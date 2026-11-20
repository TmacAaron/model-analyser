import { modelAssumptions } from './model-context.js';
import { AnalysisAttempt,AnalysisResult,CostResult,ComputeCostResult,CostDefinition,NodeId,metricFor,type Scenario,type AssetDocument,type MetricValue,type MetricScope,type Diagnostic,type DecodeStepContext } from '@model-analyser/contracts';
import { instantiateModel } from './instantiate.js';
import { resolveParallelPlan } from './parallel-plan.js';
import { numericValue } from './storage.js';
import { MetricFactory } from './metrics.js';
import { canonical } from '../../contracts/src/validation.js';
import { validateResult } from '../../contracts/src/result-validation.js';
import { rooflinePoints } from './roofline.js';
import { FormulaError } from './formula.js';
import { ENGINE_VERSION } from './version.js';
import {modelCostInputs,moduleCostInputs} from './aggregate-members.js';
import {logicalDeclarationObserver,type AnalysisObserver} from './logical-work-observation.js';
import {logicalWorkMembers} from './logical-work-members.js';

/** Explicit projection from physical local costs to group totals. Times are barriers, never device sums. */
export async function analyzeDistributedScenario(scenario:Scenario,assets:AssetDocument[],stepContext?:DecodeStepContext,observer?:AnalysisObserver):Promise<AnalysisAttempt>{
  const fusion=observer&&'fusion'in observer?observer:undefined,logicalObserver=observer&&'logicalLeaf'in observer?observer.logicalLeaf:undefined;
  const attempt=await resolveParallelPlan(scenario,assets,stepContext,fusion);if(attempt.status==='unavailable')return AnalysisAttempt.parse(attempt);
  const layout=attempt.result,diagnostics:Diagnostic[]=[...layout.diagnostics],expanded=instantiateModel(scenario,assets,undefined,stepContext,logicalDeclarationObserver(logicalObserver));if(expanded.status==='unavailable')return AnalysisAttempt.parse(expanded);
  const resolved=expanded.resolved,allDevices=scenario.deviceTopology.devices.map(d=>d.deviceId),provenance={assetRefs:resolved.assetRefs,formulaRefs:resolved.assetRefs.filter(r=>r.kind==='formula'),parameterSources:resolved.parameters.map(p=>({parameterKey:p.nodeId+':'+p.parameterKey,source:p.source.kind})),assumptions:[
    'Group totals sum explicitly evaluated physical work and traffic. Replicated local useful work is not the logical model numerator for MFU.',
    'Logical compute is evaluated once from the expanded graph and kept in model_useful scopes separately from physical group_total costs.',
    'Node seconds use the slowest participating device. Model seconds use the declared serial-barrier makespan, including named communications; device seconds are never summed as wall time.',
    'Modules aggregate their declared expanded graph leaves, including graph-native communications. Plan-level communications belong to the model; they are not implicitly assigned to a module.',
    'Unplaced or incomplete local equations remain unknown. Network-only communication does not imply zero HBM, local reduction or staging cost.',
    ...modelAssumptions(scenario,assets),
      ...scenario.parallelPlan.assumptions,
  ]},metrics=new MetricFactory(diagnostics,provenance,scenario.scenarioId,'distributed-analysis'),execution=layout.execution.status==='available'?layout.execution.result:undefined;
  const scope:MetricScope={phase:resolved.phase,target:{kind:'model'},deviceIds:allDevices,aggregation:'group_total'};
  function scheduledCost(cost:CostResult,nodeId:NodeId,deviceId:typeof allDevices[number]):CostResult{if(execution?.policy!=='streams')return cost;const interval=execution.intervals.find(i=>i.nodeId===nodeId&&i.deviceId===deviceId);return CostResult.parse({...cost,seconds:interval?metrics.available(interval.endSeconds-interval.startSeconds,'second','estimated'):metrics.unavailable('missing_stream_interval','多流 Roofline 缺少设备区间')});}
  type Compute=CostResult['compute'];
  const sumCompute=(lists:Compute[],factory=metrics):Compute=>{const classes=new Map<string,Compute>();for(const list of lists)for(const c of list){const key=canonical(c.computeClass),entries=classes.get(key);if(entries)entries.push(c);else classes.set(key,[c]);}return [...classes.values()].map(cs=>{const c=cs[0];if(!c)throw new FormulaError('invalid_cost','空计算分类');return {computeClass:c.computeClass,usefulOperations:factory.sum(cs.map(v=>v.usefulOperations),'operation'),executedOperations:factory.sum(cs.map(v=>v.executedOperations),'operation')};});};
  function physicalSum(costs:CostResult[],target:MetricScope,seconds:CostResult['seconds'],factory=metrics):CostResult{
    for(const c of costs)if(c.scope.phase!==target.phase||c.scope.aggregation==='model_useful'||c.scope.deviceIds.some(id=>!target.deviceIds.includes(id)))throw new FormulaError('invalid_scope','设备组投影不能混入其他阶段、组外设备或模型有效成本');
    return {scope:target,compute:sumCompute(costs.map(c=>c.compute),factory),logicalReadBytes:factory.sum(costs.map(c=>c.logicalReadBytes),'byte'),logicalWriteBytes:factory.sum(costs.map(c=>c.logicalWriteBytes),'byte'),hbmBytes:factory.sum(costs.map(c=>c.hbmBytes),'byte'),communications:costs.flatMap(c=>c.communications),seconds};
  }
  const nodes:AnalysisResult['nodes']=[],logical:NonNullable<AnalysisResult['distributed']>['logicalCompute']=[],roofline:AnalysisResult['roofline']=[],byLogical=new Map<NodeId,Compute>(),fusedMembers=new Set(layout.fusions.flatMap(f=>f.application.memberNodeIds));
  function addLogical(nodeId:NodeId,compute:Compute,nodeScope:MetricScope){byLogical.set(nodeId,compute);logical.push({scope:{...nodeScope,aggregation:'model_useful'},compute});}
  for(const n of layout.localCosts.nodes){
    const body=resolved.graph.nodes.find(g=>g.nodeId===n.nodeId)?.body;if(body?.kind!=='opaque')throw new FormulaError('missing_reference','分布式分析缺少已展开叶节点 '+n.nodeId);
    const nodeMetrics=new MetricFactory(diagnostics,{...provenance,parameterSources:resolved.parameters.filter(p=>p.nodeId==='$model'||p.nodeId===n.nodeId||n.nodeId.startsWith(p.nodeId+'/')||n.nodeId.startsWith(p.nodeId+'[')).map(p=>({parameterKey:p.nodeId+':'+p.parameterKey,source:p.source.kind}))},scenario.scenarioId,'distributed-node-'+n.nodeId);
    const capture=logicalObserver?.nodeId===n.nodeId?logicalObserver:undefined;
    const logicalCompute=sumCompute([body.cost.compute.map((c,index)=>{
      function value(v:typeof c.usefulOperations){try{return nodeMetrics.available(numericValue(v,'operation',{symbols:{},assets}),'operation');}catch(e){return nodeMetrics.unavailable(e instanceof FormulaError?e.code:'invalid_cost',e instanceof Error?e.message:'逻辑计算缺项');}}
      const row=ComputeCostResult.parse({computeClass:c.computeClass,usefulOperations:value(c.usefulOperations),executedOperations:value(c.executedOperations)});
      capture?.term(structuredClone({index,segmentId:c.segmentId,...row}));
      return row;
    })],nodeMetrics);
    const devices=n.placement.kind==='placed'?n.placement.perDevice.map(d=>d.deviceId):execution?.steps.find(s=>s.nodeId===n.nodeId)?.deviceIds??[],nodeScope:MetricScope={...scope,target:{kind:'node',nodeId:n.nodeId},deviceIds:devices.length?devices:allDevices};
    const costs:CostResult[]=[],missing:Extract<MetricValue,{status:'unavailable'}>[]=[];
    if(n.placement.kind==='unplaced')missing.push({status:'unavailable',diagnosticIds:n.placement.diagnosticIds});
    if(n.placement.kind==='placed')for(const d of n.placement.perDevice){
      if(d.outcome.status==='unavailable'){missing.push(d.outcome);continue;}costs.push(d.outcome.cost);
      const device=scenario.deviceTopology.devices.find(device=>device.deviceId===d.deviceId),hardware=device?assets.find(a=>a.assetId===device.hardware.assetId&&a.revision===device.hardware.revision):undefined;
      if(hardware?.definition.kind!=='hardware')throw new FormulaError('missing_reference','Roofline 缺少设备硬件');const definition=CostDefinition.parse(layout.singleDeviceBaseline?body.cost:body.localCost?.cost??body.cost);
      for(const override of scenario.numericOverrides)if(override.target.kind==='node'&&override.target.nodeId===n.nodeId){if(override.field==='fixed_seconds')definition.timing={kind:'fixed',seconds:override.value.value,description:'Explicit local override'};else if(definition.timing.kind==='roofline_bound'){if(override.field==='compute_efficiency')definition.timing.computeEfficiency=override.value.value;else if(override.field==='memory_efficiency')definition.timing.memoryEfficiency=override.value.value;}}
      const source=[...d.outcome.cost.compute.map(c=>c.usefulOperations),d.outcome.cost.hbmBytes].find(m=>m.status==='available');if(!fusedMembers.has(n.nodeId))roofline.push(...rooflinePoints(scheduledCost(d.outcome.cost,n.nodeId,d.deviceId),definition,hardware.definition.hardware,new MetricFactory(diagnostics,source?.provenance??nodeMetrics.provenance,scenario.scenarioId,'roofline-'+n.nodeId+'-'+d.deviceId)));
    }
    if(missing.length){const unavailable={status:'unavailable' as const,diagnosticIds:[...new Set(missing.flatMap(m=>m.diagnosticIds))]},classes=new Map([...body.cost.compute,...(body.localCost?.cost.compute??[])].map(c=>[canonical(c.computeClass),c.computeClass]));costs.push(CostResult.parse({scope:nodeScope,compute:[...classes.values()].map(computeClass=>({computeClass,usefulOperations:unavailable,executedOperations:unavailable})),logicalReadBytes:unavailable,logicalWriteBytes:unavailable,hbmBytes:unavailable,seconds:unavailable,communications:[]}));}
    const seconds=fusedMembers.has(n.nodeId)?nodeMetrics.unavailable('fused_member_interval','该数学步骤属于融合组，没有独立的执行/测量区间'):execution?.steps.find(s=>s.nodeId===n.nodeId)?.duration??nodeMetrics.unavailable('missing_execution_duration','执行顺序不可用，节点屏障耗时未知');nodes.push({nodeId:n.nodeId,cost:physicalSum(costs,nodeScope,seconds,nodeMetrics)});addLogical(n.nodeId,logicalCompute,nodeScope);
  }
  const fusionRows:NonNullable<AnalysisResult['fusions']>=layout.fusions.map(evaluation=>{const f=evaluation.application,devices=evaluation.perDevice.map(d=>d.deviceId),target:MetricScope={...scope,target:{kind:'node',nodeId:f.nodeId},deviceIds:devices.length?devices:allDevices},costs=evaluation.perDevice.flatMap(d=>d.outcome.status==='available'?[d.outcome.cost]:[]),missing=evaluation.perDevice.flatMap(d=>d.outcome.status==='unavailable'?[d.outcome]:[]);if(missing.length){const unavailable={status:'unavailable' as const,diagnosticIds:[...new Set(missing.flatMap(m=>m.diagnosticIds))]},classes=new Map([...nodes.filter(n=>f.memberNodeIds.includes(n.nodeId)).flatMap(n=>n.cost.compute.map(c=>c.computeClass)),...f.extraCost.compute.map(c=>c.computeClass),...(f.extraLocalCost?.rule.cost.compute.map(c=>c.computeClass)??[])].map(c=>[canonical(c),c]));costs.push(CostResult.parse({scope:target,compute:[...classes.values()].map(computeClass=>({computeClass,usefulOperations:unavailable,executedOperations:unavailable})),logicalReadBytes:unavailable,logicalWriteBytes:unavailable,hbmBytes:unavailable,communications:[],seconds:unavailable}));}const times=costs.map(c=>c.seconds),unknown=times.filter(m=>m.status==='unavailable'),seconds=unknown.length?{status:'unavailable' as const,diagnosticIds:[...new Set(unknown.flatMap(m=>m.diagnosticIds))]}:metrics.available(Math.max(0,...times.flatMap(m=>m.status==='available'?[m.quantity.value]:[])),'second'),cost=physicalSum(costs,target,execution?.policy==='streams'?execution.steps.find(s=>s.nodeId===f.nodeId)?.duration??metrics.unavailable('missing_stream_duration','融合组多流耗时不可用'):seconds);
    logical.push({scope:{...target,aggregation:'model_useful'},compute:sumCompute(logicalWorkMembers(byLogical,[evaluation],f.memberNodeIds).map(m=>m.compute))});for(const d of evaluation.perDevice)if(d.outcome.status==='available'){const device=scenario.deviceTopology.devices.find(t=>t.deviceId===d.deviceId),hardware=assets.find(a=>a.assetId===device?.hardware.assetId&&a.revision===device?.hardware.revision);if(hardware?.definition.kind==='hardware'){const timing=f.timeStrategy.kind==='override'?f.timeStrategy.timing:{kind:'fixed' as const,seconds:d.outcome.cost.seconds.status==='available'?d.outcome.cost.seconds.quantity.value:0,description:'Aggregate group bound; component efficiencies are already reflected in the serial fused span.'};roofline.push(...rooflinePoints(scheduledCost(d.outcome.cost,f.nodeId,d.deviceId),{compute:[],memoryAccess:[],temporaryStorageIds:[],timing},hardware.definition.hardware,metrics));}}return {evaluation,cost};});
  const occupied=new Set([...nodes.map(n=>String(n.nodeId)),...layout.communications.flatMap(c=>c.evaluation.definition.placement?[String(c.evaluation.definition.placement.nodeId)]:[])]);
  for(const c of layout.communications){let id=c.evaluation.definition.placement?.nodeId;if(!id){let candidate='$unplaced-communication:'+c.index;while(occupied.has(candidate))candidate+=':';id=NodeId.parse(candidate);}occupied.add(id);const cost=CostResult.parse(c.evaluation.cost);cost.scope={...cost.scope,target:{kind:'node',nodeId:id}};if(execution?.policy==='streams')cost.seconds=execution.steps.find(s=>s.nodeId===id)?.duration??metrics.unavailable('missing_stream_duration','通信多流耗时不可用');nodes.push({nodeId:id,cost});addLogical(id,[],cost.scope);}
  const nodeById=new Map(nodes.map(n=>[n.nodeId,n]));
  const modules:AnalysisResult['modules']=resolved.containers.filter(c=>c.nodeId!=='$model').map(c=>{const {contained,costs:leaves}=moduleCostInputs(c.leafNodeIds,nodeById,fusionRows),devices=[...new Set(leaves.flatMap(leaf=>leaf.scope.deviceIds))],moduleScope:MetricScope={...scope,target:{kind:'module',nodeId:c.nodeId},deviceIds:devices.length?devices:allDevices},cost=physicalSum(leaves,moduleScope,metrics.sum(leaves.map(leaf=>leaf.seconds),'second'));
    if(execution?.policy==='streams'&&leaves.every(l=>l.seconds.status==='available')){const ids=new Set(leaves.flatMap(leaf=>leaf.scope.target.kind==='node'?[leaf.scope.target.nodeId]:[])),steps=execution.steps.filter(s=>ids.has(s.nodeId));cost.seconds=metricFor('second').parse(steps.some(s=>s.startSeconds===undefined||s.endSeconds===undefined)?metrics.unavailable('missing_module_stream_span','模块缺少完整多流区间'):metrics.available(steps.length?Math.max(...steps.map(s=>s.endSeconds??0))-Math.min(...steps.map(s=>s.startSeconds??0)):0,'second','estimated'));}
    logical.push({scope:{...moduleScope,aggregation:'model_useful'},compute:sumCompute(logicalWorkMembers(byLogical,contained.map(f=>f.evaluation),c.leafNodeIds).map(m=>m.compute))});return {nodeId:c.nodeId,leafNodeIds:c.leafNodeIds,cost};});
  const total=physicalSum(modelCostInputs(nodes,fusionRows,fusedMembers),scope,execution?.makespan??metrics.unavailable('missing_execution_duration','执行顺序不可用，无法报告完整串行跨度'));logical.push({scope:{...scope,aggregation:'model_useful'},compute:sumCompute(logicalWorkMembers(byLogical,layout.fusions).map(m=>m.compute))});
  const schedule:AnalysisResult['schedule']=execution?.intervals.map(i=>({nodeId:i.nodeId,deviceScope:{kind:'per_device',deviceId:i.deviceId},streamId:i.streamId??'serial',startSeconds:i.startSeconds,endSeconds:i.endSeconds}))??[];
  const result:AnalysisResult={parameterTrace:resolved.parameters,...(stepContext?{stepContext}:{}),fusions:fusionRows,quantizationApplications:layout.quantizationApplications,engineVersion:ENGINE_VERSION,inputHash:layout.inputHash,scenarioId:scenario.scenarioId,phase:resolved.phase,scope,nodes,modules,total,memory:layout.memory,schedule,roofline,distributed:{layout,logicalCompute:logical},diagnostics};const issues=validateResult(result);return issues.length?AnalysisAttempt.parse({status:'unavailable',diagnostics:issues}):{status:'available',result};
}






