import { modelAssumptions } from './model-context.js';
import {observeCostTiming} from './timing-observer.js';
import {communicationSymbols} from './communication-observation.js';
import type {LocalAccessTerm,LocalCostOverride,LocalPlanObserver} from './local-cost-observation.js';
import { CostDefinition,type DistributedCosts,type ResolvedGraph,type Scenario,type AssetDocument,type ParallelResolution,type Diagnostic,type LocalDeviceCost,type LocalNodeEvaluation,type LocalCostRule,type Quantity,type MetricValue,type CostResult } from '@model-analyser/contracts';
import { evaluateDeclaredCost,memoryAccessBytes } from './cost.js';
import { numericValue } from './storage.js';
import { FormulaError } from './formula.js';
import { MetricFactory,aggregateCosts } from './metrics.js';
import { canonical } from '../../contracts/src/validation.js';

type Layouts=Pick<ParallelResolution,'tensorLayouts'|'storageLayouts'|'storageAllocations'>;
export const LOCAL_COST_VERSION='0.1.0-local-cost.1';

/** Evaluate explicitly declared local equations. No work/traffic division by card count. */
export function evaluateDistributedCosts(resolved:ResolvedGraph,scenario:Scenario,assets:AssetDocument[],layouts:Layouts,diagnostics:Diagnostic[],singleDeviceBaseline=false,observer?:LocalPlanObserver['localCost']):DistributedCosts{
  const assumptions=[
    'LocalCostRule explicitly binds useful logical dimensions separately from allocated/padded dimensions.',
    'Manual copies are exposed as bindings; compute and traffic are never multiplied implicitly.',
    'Device subtotals sum evaluated leaf equations once per device. Serial seconds exclude communication, unplaced and missing nodes; they are not a whole-model schedule.',
    'logicalModelCompute is the single logical graph definition, not a sum of replicated device work.',
    ...modelAssumptions(scenario,assets),
      ...scenario.parallelPlan.assumptions,
  ];
  const provenance={assetRefs:assets.map(a=>({assetId:a.assetId,revision:a.revision,kind:a.definition.kind})),formulaRefs:resolved.assetRefs.filter(a=>a.kind==='formula'),parameterSources:resolved.parameters.map(p=>({parameterKey:p.nodeId+':'+p.parameterKey,source:p.source.kind})),assumptions};
  const metrics=new MetricFactory(diagnostics,provenance,scenario.scenarioId,'local-cost'),nodes:LocalNodeEvaluation[]=[];
  const graphStorages=new Map(resolved.graph.storages.map(s=>[String(s.storageId),s])),storageAllocations=new Map(layouts.storageAllocations.map(s=>[String(s.storageId),s])),tensorLayouts=new Map(layouts.tensorLayouts.map(t=>[JSON.stringify([t.nodeId,t.tensorId]),t.partition]));
  const canonicalStorage=(id:string):string=>{const seen=new Set<string>();while(true){const s=graphStorages.get(id);if(!s)throw new FormulaError('missing_reference','局部成本缺少存储 '+id);if(s.allocation.kind!=='alias')return id;if(seen.has(id))throw new FormulaError('dependency_cycle','局部成本 alias 环');seen.add(id);id=s.allocation.targetStorageId;}};
  const tensorLayout=(nodeId:string,id:string)=>tensorLayouts.get(JSON.stringify([nodeId,id]));
  const storageLayout=(id:string)=>storageAllocations.get(canonicalStorage(id));
  const deviceBytes=new Map(scenario.deviceTopology.devices.map(device=>[
    device.deviceId,new Map<ResolvedGraph['graph']['storages'][number]['storageId'],MetricValue>(),
  ]));
  for(const storage of graphStorages.values())for(const placement of storageLayout(storage.storageId)?.allocation.perDevice??[]){
    deviceBytes.get(placement.deviceId)?.set(storage.storageId,placement.totalBytes);
  }
  function failure(error:unknown){return metrics.unavailable(error instanceof FormulaError?error.code:'invalid_local_cost',error instanceof Error?error.message:'局部成本不可用');}
  const logicalClasses=new Map<string,{computeClass:CostResult['compute'][number]['computeClass'];useful:MetricValue[];executed:MetricValue[]}>();
  for(const node of resolved.graph.nodes){
    if(node.body.kind!=='opaque')continue;const body=node.body;
    for(const segment of body.cost.compute){const key=canonical(segment.computeClass),entry=logicalClasses.get(key)??{computeClass:segment.computeClass,useful:[],executed:[]};
      for(const [source,values] of [[segment.usefulOperations,entry.useful],[segment.executedOperations,entry.executed]] as const){try{values.push(metrics.available(numericValue(source,'operation',{symbols:{},assets}),'operation'));}catch(e){values.push(failure(e));}}logicalClasses.set(key,entry);
    }
    const rule=body.localCost;
    if(!rule&&!body.cost.compute.length&&!body.cost.memoryAccess.length&&!body.cost.temporaryStorageIds.length&&body.cost.timing.kind==='fixed'&&body.cost.timing.seconds===0){nodes.push({nodeId:node.nodeId,placement:{kind:'no_work',description:'Declared metadata/control-only leaf with zero resource work'}});continue;}
    try{
      if(scenario.workload.kind==='decode'&&scenario.workload.steps!==1)throw new FormulaError('unsupported_decode_steps','局部成本目前仅计算一个明确 decode 步骤，不能忽略多步状态更新');
      if(!rule&&!singleDeviceBaseline)throw new FormulaError('missing_local_cost_rule',`节点 ${node.nodeId} 未声明局部成本方程，不能按设备数平分逻辑成本`);
      const p=rule?.participation;let devices:Scenario['deviceTopology']['devices'][number]['deviceId'][];
      if(singleDeviceBaseline){if(scenario.deviceTopology.devices.length!==1)throw new FormulaError('invalid_scope','单卡全局方程只允许一台完整设备');devices=scenario.deviceTopology.devices.map(d=>d.deviceId);}
      else if(p?.kind==='tensor_layout'){const layout=tensorLayout(node.nodeId,p.tensorId);if(!layout)throw new FormulaError('missing_local_layout',`节点 ${node.nodeId} 缺少参与张量 ${p.tensorId} 的布局`);devices=layout.placements.map(p=>p.deviceId);}
      else if(p?.kind==='storage_layout'){const layout=storageLayout(p.storageId);if(!layout)throw new FormulaError('missing_local_layout',`节点 ${node.nodeId} 缺少参与存储 ${p.storageId} 的物理分配`);const local=layouts.storageLayouts.find(s=>s.nodeId===node.nodeId&&s.storageId===canonicalStorage(p.storageId)),group=local?scenario.deviceTopology.groups.find(g=>g.groupId===local.distribution.groupId):undefined;devices=group?.members??layout.allocation.perDevice.map(p=>p.deviceId);}
      else throw new FormulaError('missing_local_cost_rule','局部成本缺少参与范围');
      if(!devices.length||new Set(devices).size!==devices.length)throw new FormulaError('invalid_scope','局部成本参与设备为空或重复');
      const overrides=scenario.numericOverrides.filter(o=>o.target.kind==='node'&&o.target.nodeId===node.nodeId&&o.field!=='parameter'),fields=new Set<string>();
      for(const o of overrides){if(fields.has(o.field))throw new FormulaError('invalid_override','同一局部成本字段存在重复覆盖');fields.add(o.field);}if(fields.has('fixed_seconds')&&(fields.has('compute_efficiency')||fields.has('memory_efficiency')))throw new FormulaError('invalid_override','局部固定耗时与效率覆盖不能同时应用');
      const relevantParameters=resolved.parameters.filter(p=>p.nodeId==='$model'||p.nodeId===node.nodeId||node.nodeId.startsWith(p.nodeId+'/')||node.nodeId.startsWith(p.nodeId+'['))
        .map(p=>({parameterKey:p.nodeId+':'+p.parameterKey,source:p.source.kind}));
      const perDevice:LocalDeviceCost[]=devices.map(deviceId=>{
        try{
          const observe=observer?.nodeId===node.nodeId&&observer.deviceId===deviceId?observer:undefined;
          const recordedOverrides:LocalCostOverride[]=[],accesses:LocalAccessTerm[]=[];
          const symbols:Record<string,Quantity>={},bindings:Extract<LocalDeviceCost['outcome'],{status:'available'}>['bindings']=[];
          for(const binding of singleDeviceBaseline?[]:rule?.bindings??[]){const source=binding.source;let quantity:Quantity;
            if(source.kind==='storage_bytes'){const local=storageLayout(source.storageId)?.allocation.perDevice.find(d=>d.deviceId===deviceId),metric=source.basis==='per_copy'?local?.allocation.totalBytes:local?.totalBytes;if(metric?.status!=='available')throw new FormulaError('missing_local_allocation',`节点 ${node.nodeId} 的 ${deviceId} 缺少 ${source.storageId} 的已知分配`);quantity=metric.quantity;}
            else {const local=tensorLayout(node.nodeId,source.tensorId)?.placements.find(p=>p.deviceId===deviceId);if(!local)throw new FormulaError('missing_local_layout',`节点 ${node.nodeId} 的 ${deviceId} 缺少张量 ${source.tensorId} 布局`);
              if(source.kind==='tensor_slice'){const slice=local.slices.find(s=>s.axisId===source.axisId);if(!slice)throw new FormulaError('missing_local_slice','局部布局未声明连续切片坐标 '+source.axisId);quantity={value:slice[source.edge],unit:'count'};}
              else if(source.kind==='tensor_copies')quantity={value:local.copies,unit:'count'};
              else if(source.kind==='tensor_elements')quantity={value:source.basis==='logical'?local.logicalElements:local.allocatedElements,unit:'count'};
              else {const axis=(source.basis==='logical'?local.logicalShape:local.allocatedShape).find(a=>a.axisId===source.axisId);if(!axis)throw new FormulaError('missing_local_axis','局部成本缺少轴 '+source.axisId);quantity={value:numericValue(axis.size,'count',{symbols:{},assets},true),unit:'count'};}
            }
            if(Object.hasOwn(symbols,binding.symbol))throw new FormulaError('duplicate_id','局部成本绑定符号重复');symbols[binding.symbol]=quantity;bindings.push({symbol:binding.symbol,source,quantity});
          }
          const cost=CostDefinition.parse(singleDeviceBaseline?body.cost:rule?.cost);
          const storageBytes=deviceBytes.get(deviceId);
          if(!storageBytes)throw new FormulaError('missing_reference','局部成本设备硬件缺失');
          const accessContext={symbols,assets,storageBytes};
          for(const id of [...cost.memoryAccess.map(a=>a.storageId),...cost.temporaryStorageIds])if(!storageBytes.has(id))throw new FormulaError('unplaced_storage_access',`节点 ${node.nodeId} 在 ${deviceId} 的访问/临时存储 ${id} 尚未配置分配`);
          for(const o of overrides){
            const before=observe?{...cost.timing}:undefined;
            if(o.field==='fixed_seconds')cost.timing={kind:'fixed',seconds:o.value.value,description:o.description??'Explicit per-local-node time override'};
            else if(o.field==='compute_efficiency'||o.field==='memory_efficiency'){if(cost.timing.kind!=='roofline_bound')throw new FormulaError('invalid_override','局部效率覆盖要求 roofline_bound');if(o.field==='compute_efficiency')cost.timing.computeEfficiency=o.value.value;else cost.timing.memoryEfficiency=o.value.value;}
            else if(o.field==='traffic_bytes'){
              const total=cost.memoryAccess.reduce((n,a)=>n+memoryAccessBytes(a,accessContext),0);
              if(!Number.isFinite(total)||total<=0)throw new FormulaError('invalid_override','缺少局部读写比例，无法拆分流量覆盖');
              const operands:Extract<LocalCostOverride['change'],{kind:'traffic'}>['operands']=[];
              for(const [index,a] of cost.memoryAccess.entries()){
                const originalBytes=memoryAccessBytes(a,accessContext),replacementBytes=originalBytes/total*o.value.value;
                a.logicalBytes={kind:'literal',quantity:{value:replacementBytes,unit:'byte'}};
                if(observe)operands.push({index,originalBytes,replacementBytes});
              }
              if(observe)recordedOverrides.push({index:scenario.numericOverrides.indexOf(o),override:o,change:{kind:'traffic',originalTotal:total,operands}});
              continue;
            }
            else throw new FormulaError('unsupported_override','局部成本尚未接入覆盖 '+o.field);
            if(before)recordedOverrides.push({index:scenario.numericOverrides.indexOf(o),override:o,change:{kind:'timing',before,after:{...cost.timing}}});
          }
          const device=scenario.deviceTopology.devices.find(d=>d.deviceId===deviceId),hardware=device?assets.find(a=>a.assetId===device.hardware.assetId&&a.revision===device.hardware.revision):undefined;if(!device||hardware?.definition.kind!=='hardware')throw new FormulaError('missing_reference','局部成本设备硬件缺失');
          const localProvenance={...provenance,parameterSources:[...relevantParameters,...bindings.map(b=>({parameterKey:node.nodeId+':'+b.symbol,source:'local_'+b.source.kind}))],assumptions:[...assumptions,singleDeviceBaseline?'One physical device with complete replicated objects; use the declared global leaf equation exactly once.':rule?.description??'Missing local rule',...overrides.map(o=>`Explicit local override ${o.field}=${o.value.value} ${o.value.unit}`)]};
          const scope={phase:resolved.phase,target:{kind:'node' as const,nodeId:node.nodeId},deviceIds:[deviceId],aggregation:'per_device' as const};
          const context={...accessContext,provenance:localProvenance};
          const terms=observe?{access:(index:number,logical:MetricValue,hbm:MetricValue)=>{accesses[index]={logical,hbm};}}:undefined;
          const timed=observe?.timing&&cost.timing.kind==='roofline_bound'?observeCostTiming(cost,scope,context,hardware.definition.hardware,256,terms):undefined;
          const evaluated=timed?.evaluation??evaluateDeclaredCost(cost,scope,context,hardware.definition.hardware,undefined,terms);
          diagnostics.push(...evaluated.diagnostics);
          if(evaluated.cost.hbmBytes.status==='available')evaluated.cost.hbmBytes.basis='estimated';
          const outcome={status:'available' as const,bindings,cost:evaluated.cost};
          observe?.record(structuredClone({rule,singleDeviceBaseline,devices,outcome,effective:cost,symbols:communicationSymbols(symbols),hardware:device.hardware,accesses,overrides:recordedOverrides,...(timed?{timing:timed.dag}:{})}));
          return {deviceId,outcome};
        }catch(e){return {deviceId,outcome:failure(e)};}
      });nodes.push({nodeId:node.nodeId,placement:{kind:'placed',perDevice}});
    }catch(e){nodes.push({nodeId:node.nodeId,placement:{kind:'unplaced',diagnosticIds:failure(e).diagnosticIds}});}
  }
  const deviceSubtotals:DistributedCosts['deviceSubtotals']=[];
  for(const device of scenario.deviceTopology.devices){const known:{nodeId:ResolvedGraph['graph']['nodes'][number]['nodeId'];cost:CostResult}[]=[],missing:ResolvedGraph['graph']['nodes'][number]['nodeId'][]=[];
    for(const n of nodes)if(n.placement.kind==='placed'){const local=n.placement.perDevice.find(d=>d.deviceId===device.deviceId);if(local?.outcome.status==='available')known.push({nodeId:n.nodeId,cost:local.outcome.cost});else if(local)missing.push(n.nodeId);}
    if(known.length)deviceSubtotals.push({deviceId:device.deviceId,knownNodeIds:known.map(n=>n.nodeId),missingNodeIds:missing,knownLeafCost:aggregateCosts(known.map(n=>n.cost),{phase:resolved.phase,target:{kind:'model'},deviceIds:[device.deviceId],aggregation:'per_device'},metrics)});
  }
  const logicalModelCompute=[...logicalClasses.values()].map(c=>({computeClass:c.computeClass,usefulOperations:metrics.sum(c.useful,'operation'),executedOperations:metrics.sum(c.executed,'operation')}));
  return {version:LOCAL_COST_VERSION,nodes,logicalModelCompute,deviceSubtotals};
}
