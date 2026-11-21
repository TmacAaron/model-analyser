import { applyTotalPeakOverrides } from './memory-peak-overrides.js';
import { theoreticalPeak,preTotalPeak } from '../../contracts/src/memory-peak-validation.js';
import { modelAssumptions } from './model-context.js';
import { AnalysisAttempt,DecodeSequence,SingleStepAnalysisResult,Scenario,MemoryPeak,CostResult,NodeId,metricFor,type AnalysisResult,type AssetDocument,type DecodeStepContext,type DecodeStateTransition,type MetricValue,type Diagnostic,type MetricScope,type StateId,type StorageId,type DeviceId,type ResolvedGraph,type MemoryPeakEstimate,type StorageSpec,type Shape,type ParallelResolution } from '@model-analyser/contracts';
import { instantiateModel } from './instantiate.js';
import { resolveParallelPlan } from './parallel-plan.js';
import { allocateStorage } from './storage.js';
import { MetricFactory,aggregateCosts } from './metrics.js';
import { computeInputHash } from './input-hash.js';
import { FormulaError } from './formula.js';
import { canonical } from '../../contracts/src/validation.js';
import { validateResult } from '../../contracts/src/result-validation.js';
import { partitionTensor } from './partition.js';
import { topologicalOrder } from './graph.js';
import { stepCostInputs } from './aggregate-members.js';
import {logicalWorkRows} from './logical-work-members.js';
import {stateTokenRange} from '../../contracts/src/state-range.js';

export const MAX_DECODE_STEPS=256;
const sequenceHeader=DecodeSequence.omit({steps:true});
const stepHeader=DecodeSequence.shape.steps.element.omit({result:true});
/** A validated provenance contains no diagnostic IDs. Preserve untouched evidence when assigning step IDs. */
export function namespaceDiagnostics<T>(value:T,prefix:string):T{
  function visit(v:unknown):unknown{
    if(!v||typeof v!=='object')return v;
    let result:object=v;
    if(Array.isArray(v)){
      let changed:unknown[]|undefined;
      for(const [i,item] of v.entries()){
        const next=visit(item);
        if(next!==item){changed??=v.slice();changed[i]=next;}
      }
      if(changed)result=changed;
    }else{
      const source=v as Record<string,unknown>;
      let changed:Record<string,unknown>|undefined;
      for(const [key,item] of Object.entries(source)){
        const next=key==='diagnosticId'&&typeof item==='string'?prefix+item:
          key==='diagnosticIds'&&Array.isArray(item)?(item.length?item.map(id=>prefix+String(id)):item):
          key==='provenance'||key==='provenancePool'?item:visit(item);
        if(next!==item){changed??={...source};changed[key]=next;}
      }
      if(changed)result=changed;
    }
    return result;
  }
  return visit(value) as T;
}
const exact=(n:number)=>{if(!Number.isSafeInteger(n)||n<0)throw new FormulaError('decode_context_overflow','decode 上下文/版本必须为非负安全整数');return n;};
type StepRunner=(scenario:Scenario,assets:AssetDocument[],context?:DecodeStepContext)=>Promise<AnalysisAttempt>;
type Frame={resolved:ResolvedGraph;storage:Map<string,{storageId:StorageId;deviceId:DeviceId;bytes:MetricValue;spec:StorageSpec;copies:number;shape?:Shape;slices?:{axisId:string;start:number;end:number}[]}>;canonical:(id:StorageId)=>StorageId};
type StateLayout=Pick<ParallelResolution,'storageAllocations'|'unassignedStorageIds'>;
export type DecodeStepMemory=Pick<SingleStepAnalysisResult,'memory'|'memoryEvidence'|'diagnostics'> & {
  distributed?:{layout:StateLayout & Pick<ParallelResolution,'execution'|'memoryEvidence'|'singleDeviceBaseline'>}|undefined;
};
type DecodeStepAttempt<R extends DecodeStepMemory>=Extract<AnalysisAttempt,{status:'unavailable'}>|{status:'available';result:R;leafCount:number};
type DecodeStepFrame<R extends DecodeStepMemory>=Omit<DecodeSequence['steps'][number],'result'|'startSeconds'|'endSeconds'> & {result:R};

/** Visit one exact execution frame at a time, sharing state carry and reservation across consumers. */
export async function visitDecodeSteps<R extends DecodeStepMemory>(base:Scenario,assets:AssetDocument[],
  run:(scenario:Scenario,assets:AssetDocument[],context:DecodeStepContext)=>Promise<DecodeStepAttempt<R>>,
  visit:(step:DecodeStepFrame<R>,resolved:ResolvedGraph)=>void,diagnostics:Diagnostic[]=[]){
    if(base.workload.kind!=='decode'||base.workload.steps<2)throw new FormulaError('invalid_decode_sequence','需要至少两个 decode 步骤');const w=base.workload;
    if(w.steps>MAX_DECODE_STEPS)throw new FormulaError('decode_step_limit',`逐步 decode 最多 ${MAX_DECODE_STEPS} 步；不会把超出预算的步骤近似为常数倍`);
    const inputHash=await computeInputHash(base,assets),mode=w.approximation==='fixed_context'?'fixed_context':'growing_context',provenance={assetRefs:assets.map(a=>({assetId:a.assetId,revision:a.revision,kind:a.definition.kind})),formulaRefs:assets.filter(a=>a.definition.kind==='formula').map(a=>({assetId:a.assetId,revision:a.revision,kind:'formula' as const})),parameterSources:[],assumptions:[...modelAssumptions(base,assets),
      'Each decode call is expanded and evaluated independently. Context advances by queryTokensPerRequest after each call; fixed_context explicitly freezes modeled context and state capacity.',
      'State identity is canonical storage identity. Static data retains its version; declared updates create a new logical version, preserving backing identity.',
      'State growth reserves max(before,after) for the whole call in the same backing. No implicit reallocation copy, conversion, staging or traffic is invented; declare such cost/workspace explicitly.',
      'Persistent weights/state are not summed across calls. Sequence capacity uses the maximum per-device call peak, including final state growth. No request compaction or cross-call overlap.',
    ]},metrics=new MetricFactory(diagnostics,provenance,base.scenarioId,'decode'),allStates=new Map<StateId,number>(),carriedRows=new Map<string,Frame['storage'] extends Map<string,infer V>?V:never>();let totalNodes=0,frameSerial=0;
    async function frame(s:Scenario,context:DecodeStepContext,child?:DecodeStepMemory):Promise<Frame>{
      const frameId=frameSerial++,attempt=instantiateModel(s,assets,undefined,context);
      if(attempt.status!=='available')throw new FormulaError('invalid_decode_state',attempt.diagnostics.map(d=>d.message).join('; '));
      const resolved=attempt.resolved,graph=resolved.graph,storages=new Map(graph.storages.map(row=>[row.storageId,row]));
      const getSpec=(id:StorageId)=>{
        const spec=storages.get(id);
        if(!spec)throw new FormulaError('missing_reference','decode 状态存储缺失 '+id);
        return spec;
      };
      const canonicalStorage=(input:StorageId):StorageId=>{
        let id=input;
        const seen=new Set<StorageId>();
        while(true){
          const {allocation}=getSpec(id);
          if(allocation.kind!=='alias')return id;
          if(seen.has(id))throw new FormulaError('dependency_cycle','decode 状态 alias 环');
          seen.add(id);id=allocation.targetStorageId;
        }
      };
      for(const override of s.numericOverrides)if(override.target.kind==='storage'&&override.field==='memory_bytes'){
        getSpec(canonicalStorage(override.target.storageId)).allocation={kind:'bytes',value:{kind:'literal',quantity:override.value}};
      }
      const ids=new Set(graph.states.flatMap(state=>state.storageIds.map(canonicalStorage))),storage:Frame['storage']=new Map();
      for(const id of ids)if(getSpec(id).category!=='state')throw new FormulaError('invalid_decode_state_category','跨步状态 backing 必须声明为常驻 state：'+id);
      let layout:StateLayout|undefined=child?.distributed?.layout;
      if(!child&&(base.deviceTopology.devices.length!==1||base.parallelPlan.assignments.length||base.parallelPlan.communications.length||base.fusionGroups.length||graph.nodes.some(n=>n.body.kind==='collective'))){
        const after=await resolveParallelPlan(s,assets,context);
        if(after.status==='unavailable')throw new FormulaError('invalid_decode_state_layout',after.diagnostics.map(d=>d.message).join('; '));
        const {storageAllocations,unassignedStorageIds,diagnostics:reported}=after.result;
        layout=namespaceDiagnostics({storageAllocations:storageAllocations.filter(row=>ids.has(row.storageId)),unassignedStorageIds},`decode-after-${frameId}::`);
        diagnostics.push(...namespaceDiagnostics(reported,`decode-after-${frameId}::`));
      }
      const allocations=new Map(layout?.storageAllocations.filter(row=>ids.has(row.storageId)).map(row=>[row.storageId,row.allocation]));
      const unassigned=new Set(layout?.unassignedStorageIds);
      for(const id of ids){
        const spec=getSpec(id),allocated=allocations.get(id);
        if(layout){
          for(const device of base.deviceTopology.devices){
            const local=allocated?.perDevice.find(row=>row.deviceId===device.deviceId);
            const bytes=local?.totalBytes??(unassigned.has(id)?metrics.unavailable('unassigned_decode_state','跨步状态缺少物理分配 '+id):metrics.available(0,'byte'));
            storage.set(id+'@'+device.deviceId,{storageId:id,deviceId:device.deviceId,spec,copies:local?.copies??0,
              ...(local?.allocatedShape?{shape:local.allocatedShape}:{}),bytes});
          }
          if(!allocated||spec.allocation.kind!=='tensor'||!['sharded','manual'].includes(allocated.distribution.kind))continue;
          const partition=partitionTensor({tensorId:('$decode-state:'+id) as ResolvedGraph['graph']['tensors'][number]['tensorId'],storageId:id,name:id,
            shape:spec.allocation.shape,dtype:spec.allocation.dtype},allocated.distribution,base.deviceTopology,{symbols:{},assets});
          if(partition.status!=='available')throw new FormulaError('unproven_decode_state_layout','状态 backing 分片无法核对');
          for(const placement of partition.result.placements){
            const row=storage.get(id+'@'+placement.deviceId);
            if(row)row.slices=placement.slices;
          }
        }else{
          const allocation=allocateStorage(id,graph.storages,{symbols:{},assets,provenance});
          diagnostics.push(...namespaceDiagnostics(allocation.diagnostics,`decode-allocation-${frameId}::`));
          const bytes=namespaceDiagnostics(allocation.totalBytes,`decode-allocation-${frameId}::`);
          for(const device of base.deviceTopology.devices)storage.set(id+'@'+device.deviceId,{storageId:id,deviceId:device.deviceId,bytes,spec,copies:1});
        }
      }
      return {resolved,storage,canonical:canonicalStorage};
    }
    for(let index=0;index<w.steps;index++){const priorRows=new Map(carriedRows);
      const contextBefore=exact(w.contextTokensPerRequest+index*w.queryTokensPerRequest),contextAfter=exact(contextBefore+w.queryTokensPerRequest),evaluatedContext=mode==='fixed_context'?w.contextTokensPerRequest:contextBefore,s=Scenario.parse({...base,workload:{...w,steps:1,contextTokensPerRequest:evaluatedContext}}),context:DecodeStepContext={index,parentInputHash:inputHash,carriedStateIds:[...allStates.keys()].sort()},attempt=await run(s,assets,context);
      if(attempt.status==='unavailable')return namespaceDiagnostics(attempt,`decode-step-${index}::`);
      const result=namespaceDiagnostics(attempt.result,`decode-step-${index}::`);diagnostics.push(...result.diagnostics);totalNodes+=attempt.leafCount;if(totalNodes>100000)throw new FormulaError('decode_expansion_limit','全部 decode 步骤超过 100000 个叶事件预算');
      const before=await frame(s,context,result),afterScenario=Scenario.parse({...s,workload:{...s.workload,contextTokensPerRequest:mode==='fixed_context'?evaluatedContext:contextAfter}}),stateIds=before.resolved.graph.states.map(s=>s.stateId).sort();if(index&&canonical(stateIds)!==canonical([...allStates.keys()].sort()))throw new FormulaError('decode_state_identity_changed','跨步状态身份发生改变，必须使用稳定状态/存储版本');const after=mode!=='fixed_context'&&before.resolved.graph.states.some(state=>(state.allocationBasis??'context_boundary')!=='step_end')?await frame(afterScenario,{...context,index:index+1,carriedStateIds:stateIds}):before,transitions:DecodeStateTransition[]=[],reserves=new Map<string,{before:MetricValue;after:MetricValue;reserved:MetricValue;deviceId:DeviceId}>();
      if(index>0)for(const state of before.resolved.graph.states){
        if(state.creator.kind!=='initialized')throw new FormulaError('uninitialized_decode_state','状态未从上一步继承 '+state.stateId);
        for(const id of state.storageIds.map(before.canonical))for(const device of base.deviceTopology.devices){
          const key=id+'@'+device.deviceId,previous=priorRows.get(key),current=before.storage.get(key);
          if(!previous||!current)throw new FormulaError('decode_state_identity_changed','跨步状态存储身份发生改变 '+id);
          if(state.allocationBasis!=='step_end'&&(previous.bytes.status!==current.bytes.status||
            previous.bytes.status==='available'&&current.bytes.status==='available'&&previous.bytes.quantity.value!==current.bytes.quantity.value)){
            throw new FormulaError('invalid_decode_state_reservation','起始状态容量与上一调用的结束容量不同 '+id);
          }
        }
      }
      for(const state of before.resolved.graph.states){const allocationBasis=state.allocationBasis??'context_boundary',endFrame=allocationBasis==='step_end'?before:after,next=endFrame.resolved.graph.states.find(s=>s.stateId===state.stateId);if(!next||canonical(state.storageIds.map(before.canonical).sort())!==canonical(next.storageIds.map(endFrame.canonical).sort())||state.updatePolicy.kind!==next.updatePolicy.kind)throw new FormulaError('decode_state_identity_changed','状态 backing/更新类型不能随步骤隐式改变 '+state.stateId);
        const version=allStates.get(state.stateId)??0,dynamic=state.updatePolicy.kind!=='static';if(dynamic&&!state.writers.length&&state.creator.kind!=='node')throw new FormulaError('missing_decode_state_writer','更新状态必须声明实际 writer：'+state.stateId);if(!dynamic&&state.writers.length)throw new FormulaError('static_decode_state_writer','static 状态不能声明逐步写入 '+state.stateId);const afterVersion=dynamic?exact(version+1):version;
        if(index===0&&state.creator.kind==='node'){const execution=result.distributed?.layout.execution,order=execution?.status==='available'?execution.result.memoryOrder?.map(e=>e.nodeId)??execution.result.orderedNodeIds:topologicalOrder(before.resolved.graph),creator=order.indexOf(state.creator.nodeId),needsExisting=[...before.storage.values()].some(s=>state.storageIds.map(before.canonical).includes(s.storageId)&&(s.bytes.status==='unavailable'||s.bytes.quantity.value>0));if(needsExisting&&state.readers.some(r=>order.indexOf(r.nodeId)<0||order.indexOf(r.nodeId)<=creator))throw new FormulaError('uninitialized_decode_state','第零步在 creator 完成前读取已有状态，需明确初始化来源：'+state.stateId);}
        const beforeTokenRange=stateTokenRange(evaluatedContext,state.updatePolicy);
        const storages:DecodeStateTransition['storages']=[];for(const id of [...new Set(state.storageIds.map(before.canonical))])for(const device of base.deviceTopology.devices){const key=id+'@'+device.deviceId,a=before.storage.get(key),b=endFrame.storage.get(key);if(!a||!b)throw new FormulaError('missing_reference','状态设备分配缺项');if(a.slices?.some(slice=>slice.end>slice.start&&!b.slices?.some(next=>next.axisId===slice.axisId&&next.start<=slice.start&&next.end>=slice.end)))throw new FormulaError('decode_state_redistribution','已有状态切片移到其他设备，需要显式跨步重分布：'+id);const carried=priorRows.get(key);if(allocationBasis==='step_end'&&carried){if(carried.slices?.some(slice=>slice.end>slice.start&&!a.slices?.some(next=>next.axisId===slice.axisId&&next.start<=slice.start&&next.end>=slice.end)))throw new FormulaError('decode_state_redistribution','步骤开始预留改变了既有状态的设备归属');if(carried.bytes.status==='available'&&a.bytes.status==='available'&&(state.updatePolicy.kind==='static'?carried.bytes.quantity.value!==a.bytes.quantity.value:state.updatePolicy.kind==='append'&&a.bytes.quantity.value<carried.bytes.quantity.value))throw new FormulaError('invalid_decode_state_reservation','步骤开始预留不能改变 static 或缩小 append 状态');}carriedRows.set(key,b);let reserved:MetricValue;if(a.bytes.status==='unavailable'||b.bytes.status==='unavailable')reserved=metrics.sum([a.bytes,b.bytes],'byte');else {if(state.updatePolicy.kind==='static'&&a.bytes.quantity.value!==b.bytes.quantity.value)throw new FormulaError('static_decode_state_changed','static 状态不能随着上下文改变物理分配 '+id);if(state.updatePolicy.kind==='append'&&mode!=='fixed_context'&&b.bytes.quantity.value<a.bytes.quantity.value)throw new FormulaError('shrinking_append_state','append 状态分配不能隐式缩小 '+id);reserved=metrics.available(Math.max(a.bytes.quantity.value,b.bytes.quantity.value),'byte');}const previous=reserves.get(key);if(previous&&canonical(previous.reserved)!==canonical(reserved))throw new FormulaError('conflicting_decode_state','共享 backing 的状态容量要求冲突 '+id);reserves.set(key,{before:a.bytes,after:b.bytes,reserved,deviceId:device.deviceId});storages.push({storageId:id,deviceId:device.deviceId,beforeStorage:a.spec,afterStorage:b.spec,beforeCopies:a.copies,afterCopies:b.copies,...(allocationBasis==='step_end'?{carriedBytes:metricFor('byte').parse(carried?.bytes??a.bytes)}:{}),...(a.shape?{beforeAllocatedShape:a.shape}:{}),...(b.shape?{afterAllocatedShape:b.shape}:{}),beforeBytes:metricFor('byte').parse(a.bytes),afterBytes:metricFor('byte').parse(b.bytes),reservedBytes:metricFor('byte').parse(reserved)});}
        transitions.push({stateId:state.stateId,...(state.allocationBasis?{allocationBasis:state.allocationBasis}:{}),policy:state.updatePolicy,afterPolicy:next.updatePolicy,beforeVersion:version,afterVersion,beforeInitialized:state.creator.kind==='initialized',...(beforeTokenRange?{beforeTokenRange,afterTokenRange:stateTokenRange(mode==='fixed_context'?evaluatedContext:contextAfter,next.updatePolicy)}:{}),storages});allStates.set(state.stateId,afterVersion);
      }
      const reservePeak=(initial:MemoryPeakEstimate):MemoryPeak=>{const m=initial.moduleOverrides?{...initial,moduleOverrides:{...initial.moduleOverrides,theoretical:reservePeak(initial.moduleOverrides.theoretical)}}:initial;const ids=m.deviceScope.kind==='per_device'?[m.deviceScope.deviceId]:m.deviceScope.deviceIds,values=ids.map(id=>{const rows=[...reserves.values()].filter(r=>r.deviceId===id),deltas=rows.map(r=>r.before.status==='available'&&r.reserved.status==='available'?metrics.available(r.reserved.quantity.value-r.before.quantity.value,'byte'):metrics.sum([r.before,r.reserved],'byte'));return metrics.sum(deltas,'byte');});if(values.some(v=>v.status==='unavailable')||m.peakBytes.status==='unavailable'){const missing=metrics.sum([m.peakBytes,...values],'byte');return MemoryPeak.parse({...m,categoryBreakdown:[],peakBytes:missing,capacityStatus:{kind:'unavailable',diagnosticIds:missing.diagnosticIds}});}const delta=values[0];if(!delta||delta.status!=='available'||values.some(v=>v.status!=='available'||v.quantity.value!==delta.quantity.value))throw new FormulaError('invalid_scope','设备等价类跨步状态增量不同');const category=m.categoryBreakdown.find(c=>c.category==='state'),peak=metrics.sum([m.peakBytes,delta],'byte'),categories=m.categoryBreakdown.map(c=>c.category==='state'?{...c,bytes:metrics.sum([c.bytes,delta],'byte')}:c);if(!category&&delta.quantity.value)categories.push({category:'state',bytes:delta});if(peak.status==='available'&&!Number.isSafeInteger(peak.quantity.value)){const missing=metrics.unavailable('decode_memory_overflow','状态预留与峰值合计超出安全整数');return MemoryPeak.parse({...m,categoryBreakdown:[],peakBytes:missing,capacityStatus:{kind:'unavailable',diagnosticIds:missing.diagnosticIds}});}if(peak.status==='available'&&peak.quantity.value>m.capacityBytes)metrics.unavailable('capacity_exceeded','decode 第 '+index+' 步含状态预留峰值超过容量');return MemoryPeak.parse({...m,categoryBreakdown:categories,peakBytes:peak,capacityStatus:{kind:'point_only',description:'This call reserves max(before,after) state capacity in place; no interval search.'}});};const reservedMemory=result.memory.map(preTotalPeak).map(reservePeak);
      const memory=applyTotalPeakOverrides(reservedMemory,before.resolved,s,assets,diagnostics);
      visit({index,contextBefore,contextAfter,evaluatedContext,scenario:s,result,stateTransitions:transitions,memory},before.resolved);
    }
    return {status:'available' as const,inputHash,mode,metrics};
}

/** Explicit sequential phase calls. State data is carried, allocations reserve max(before,after) in place. */
export async function analyzeDecodeSequence(base:Scenario,assets:AssetDocument[],run:StepRunner):Promise<AnalysisAttempt>{
  const diagnostics:Diagnostic[]=[],steps:DecodeSequence['steps']=[];
  let clock:number|undefined=0;
  try{
    const sequence=await visitDecodeSteps<SingleStepAnalysisResult>(base,assets,async(scenario,library,context)=>{
      const attempt=await run(scenario,library,context);
      if(attempt.status==='unavailable')return attempt;
      if(attempt.result.decode)throw new FormulaError('invalid_decode_step','逐步分析结果包含嵌套 Decode 序列');
      return {status:'available',result:attempt.result,leafCount:attempt.result.nodes.length};
    },step=>{
      const start=clock,seconds=step.result.total.seconds;
      if(clock!==undefined&&seconds.status==='available'){
        const end:number=clock+seconds.quantity.value;
        clock=Number.isFinite(end)&&!(seconds.quantity.value>0&&end===clock)?end:undefined;
      }else clock=undefined;
      steps.push({...step,...(start!==undefined?{startSeconds:start}:{}),...(clock!==undefined?{endSeconds:clock}:{})});
    },diagnostics);
    if(sequence.status==='unavailable')return sequence;
    const {inputHash,mode,metrics}=sequence;
    const first=steps[0]?.result;if(!first)throw new FormulaError('invalid_decode_sequence','decode 缺少步骤');const sum=(costs:CostResult[],scope:MetricScope)=>aggregateCosts(costs.map(c=>({...c,scope})),scope,metrics),nodeIds=[...new Set(steps.flatMap(s=>[...s.result.nodes.map(n=>n.nodeId),...(s.result.fusions??[]).map(f=>f.evaluation.application.nodeId)]))],scope=first.scope;
    const nodes=nodeIds.map(nodeId=>{const target={kind:'node' as const,nodeId},costs=stepCostInputs(steps,target).map(input=>input.cost),deviceIds=[...new Set(costs.flatMap(c=>c.scope.deviceIds))];return {nodeId,cost:sum(costs,{...scope,target,deviceIds})};}),moduleIds=[...new Set(steps.flatMap(s=>s.result.modules.map(m=>m.nodeId)))],modules=moduleIds.map(nodeId=>{const target={kind:'module' as const,nodeId},rows=steps.flatMap(s=>s.result.modules.filter(m=>m.nodeId===nodeId)),costs=stepCostInputs(steps,target).map(input=>input.cost);return {nodeId,leafNodeIds:[...new Set(rows.flatMap(m=>m.leafNodeIds))],cost:sum(costs,{...scope,target,deviceIds:[...new Set(costs.flatMap(c=>c.scope.deviceIds))]})};});
    const total=sum(stepCostInputs(steps,scope.target).map(input=>input.cost),scope);if(clock===undefined&&total.seconds.status==='available')total.seconds=metrics.unavailable('decode_timeline_overflow','逐步累计时间不可完整表示');const schedule:AnalysisResult['schedule']=[];let orderOffset=0;const memoryByDevice=new Map<DeviceId,MemoryPeak>();
    for(const step of steps){if(step.startSeconds!==undefined)for(const e of step.result.schedule)schedule.push({...e,startSeconds:e.startSeconds+step.startSeconds,endSeconds:e.endSeconds+step.startSeconds,decodeStepIndex:step.index});for(const m of step.memory)for(const id of m.deviceScope.kind==='per_device'?[m.deviceScope.deviceId]:m.deviceScope.deviceIds){const current=memoryByDevice.get(id),point=m.peakPoint,peakPoint=point.kind==='unlocated'?{...point,decodeStepIndex:step.index}:point.kind==='time'&&step.startSeconds!==undefined?{...point,seconds:point.seconds+step.startSeconds}:{kind:'order' as const,index:orderOffset+(point.kind==='order'?point.index:0),...(point.nodeId?{nodeId:point.nodeId}:{})},candidate=MemoryPeak.parse({...m,deviceScope:{kind:'per_device',deviceId:id},peakPoint});if(!current||m.peakBytes.status==='unavailable'||current.peakBytes.status==='available'&&m.peakBytes.status==='available'&&m.peakBytes.quantity.value>current.peakBytes.quantity.value)memoryByDevice.set(id,candidate);}orderOffset+=step.result.distributed?.layout.execution.status==='available'?step.result.distributed.layout.execution.result.memoryOrder?.length??step.result.distributed.layout.execution.result.steps.length:step.result.nodes.length;}
    const theoryByDevice=new Map<DeviceId,MemoryPeak>();let theoryOffset=0;
    for(const step of steps){for(const effective of step.memory){const row=theoreticalPeak(effective);for(const id of row.deviceScope.kind==='per_device'?[row.deviceScope.deviceId]:row.deviceScope.deviceIds){const old=theoryByDevice.get(id),p=row.peakPoint,peakPoint=p.kind==='time'&&step.startSeconds!==undefined?{...p,seconds:p.seconds+step.startSeconds}:{kind:'order' as const,index:theoryOffset+(p.kind==='order'?p.index:0),...(p.nodeId?{nodeId:p.nodeId}:{})};if(!old||row.peakBytes.status==='unavailable'||old.peakBytes.status==='available'&&row.peakBytes.status==='available'&&row.peakBytes.quantity.value>old.peakBytes.quantity.value)theoryByDevice.set(id,MemoryPeak.parse({...row,deviceScope:{kind:'per_device',deviceId:id},peakPoint}));}}theoryOffset+=step.result.distributed?.layout.execution.status==='available'?step.result.distributed.layout.execution.result.memoryOrder?.length??step.result.distributed.layout.execution.result.steps.length:step.result.nodes.length;}
    for(const [id,m] of memoryByDevice){const theoretical=theoryByDevice.get(id);if(theoretical){if(preTotalPeak(m).moduleOverrides)memoryByDevice.set(id,MemoryPeak.parse({...m,sequenceTheoretical:theoretical}));else if(m.totalOverride)memoryByDevice.set(id,MemoryPeak.parse({...m,totalOverride:{...m.totalOverride,theoretical}}));}}
    const logicalRows=steps.flatMap(s=>logicalWorkRows(s.result)),targets=[...new Set(logicalRows.map(r=>canonical(r.scope.target)))],logicalCompute=targets.map(target=>{const rows=logicalRows.filter(r=>canonical(r.scope.target)===target),scope=rows[0]?.scope;if(!scope)throw Error('Missing logical scope');const empty=metrics.available(0,'byte'),zero=metrics.available(0,'second'),cost=sum(rows.map(r=>({scope:r.scope,compute:r.compute,logicalReadBytes:metricFor('byte').parse(empty),logicalWriteBytes:metricFor('byte').parse(empty),hbmBytes:metricFor('byte').parse(empty),communications:[],seconds:metricFor('second').parse(zero)})),{...scope,deviceIds:[...new Set(rows.flatMap(r=>r.scope.deviceIds))]});return {scope:cost.scope,compute:cost.compute};}),fusedMemberNodeIds=[...new Set(steps.flatMap(s=>(s.result.fusions??[]).flatMap(f=>f.evaluation.application.memberNodeIds)))],unmeasurableTargetIds=[...fusedMemberNodeIds.map(id=>'node:'+id),...moduleIds.filter(id=>steps.some(s=>{const m=s.result.modules.find(m=>m.nodeId===id);return m&&(s.result.fusions??[]).some(f=>f.evaluation.application.memberNodeIds.some(id=>m.leafNodeIds.includes(id))&&!f.evaluation.application.memberNodeIds.every(id=>m.leafNodeIds.includes(id)));})).map(id=>'module:'+id)];
    if(mode==='fixed_context')diagnostics.push({diagnosticId:'decode-fixed-context',severity:'warning',code:'fixed_context_approximation',message:'用户显式选择固定上下文近似：工作量/状态容量按初始上下文重复，不代表真实增长过程。',location:{kind:'scenario',scenarioId:base.scenarioId}});
    // Generated child results already passed the step engine's checks. Parsing them
    // again expands shared per-device provenance into a separate copy on every metric.
    const result:AnalysisResult={...SingleStepAnalysisResult.parse({engineVersion:first.engineVersion,inputHash,scenarioId:base.scenarioId,phase:'decode',scope,nodes,modules,total,memory:[...memoryByDevice.values()],schedule,roofline:[],diagnostics}),
      decode:{...sequenceHeader.parse({baseScenario:base,mode,allocationStrategy:'in_place_reserve_max',logicalCompute,unmeasurableTargetIds,fusedMemberNodeIds}),
        steps:steps.map(({result,...step})=>({...stepHeader.parse(step),result}))}};
    const issues=validateResult(result);return issues.length?AnalysisAttempt.parse({status:'unavailable',diagnostics:issues}):{status:'available',result};
  }catch(e){diagnostics.push({diagnosticId:'decode-failure',severity:'error',code:e instanceof FormulaError?e.code:'invalid_decode_sequence',message:e instanceof Error?e.message:'decode 序列计算失败',location:{kind:'scenario',scenarioId:base.scenarioId}});return AnalysisAttempt.parse({status:'unavailable',diagnostics});}
}









