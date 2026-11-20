import {z} from 'zod';
import {ComputeClass,MetricScope,type CostResult,type DeviceId,type LocalDeviceCost,type MetricValue,type NodeId,type Quantity,type StorageId} from '@model-analyser/contracts';
import {canonical} from '../../contracts/src/validation.js';
import {jsonBytes} from '../../contracts/src/json-size.js';
import {LeafCostSourceRequest} from './leaf-cost-context.js';
import {computeInputHash,stableStringify} from './input-hash.js';
import {analyzeScenario,ENGINE_VERSION} from './analyze.js';
import {namespaceDiagnostics} from './decode.js';
import {explainValue} from './formula.js';
import {fusionParameterBindingGraph,parameterReads} from './parameter-binding-graph.js';
import type {FusionDeclaration} from './fusion-observation.js';
import type {ParameterCaptureTrace} from './parameter-observation.js';
import {rooflineMetricInputs,type TimingDag} from './timing-dag.js';

export const FusionCostSelector=z.strictObject({
 scope:MetricScope,field:z.enum(['hbmBytes','logicalReadBytes','logicalWriteBytes','usefulOperations','executedOperations','seconds']),
 computeClass:ComputeClass.optional(),
});
export type FusionCostSelector=z.infer<typeof FusionCostSelector>;
export const FusionCostSourceRequest=LeafCostSourceRequest.extend({selector:FusionCostSelector,decodeFrame:z.literal(true).optional(),proofVersion:z.literal(2).optional()});
export type FusionCostSourceRequest=z.input<typeof FusionCostSourceRequest>;

const pageSize=20;
export type FusionSourceOperand={
 kind:'device'|'member'|'extra'|'barrier'|'barrier_rank';
 nodeId:NodeId;
 deviceId?:DeviceId;
 computeIndex?:number;
 quantity?:Quantity;
 diagnosticIds?:string[];
 step?:{before:number;after:number};
 bottleneck?:true;
};
type ElidedAllocation={kind:'elided_allocation';storageId:StorageId;deviceId:DeviceId;quantity?:Quantity;diagnosticIds?:string[]};
type FusionSourceItem=FusionSourceOperand|(FusionDeclaration['removed'][number]&{resourceRemoved:true})|ElidedAllocation;
type Operation='sum_devices'|'sum_device_terms'|'max_devices'|'sum_member_barriers'|'fixed_override'|'formula_override'|'roofline_override'|'stream_span';
type RooflineOperand={timingNodeId:string;quantity:Quantity;selector:FusionCostSelector};

function operand(identity:Pick<FusionSourceOperand,'kind'|'nodeId'|'deviceId'|'computeIndex'>,metric:MetricValue):FusionSourceOperand{
 return {...identity,...(metric.status==='available'?{quantity:metric.quantity}:{}),...(metric.diagnosticIds.length?{diagnosticIds:metric.diagnosticIds}:{})};
}

function checkedSum(items:FusionSourceOperand[],metric:MetricValue){
 let value=0,known=true;
 for(const item of items){
  if(!item.quantity){known=false;continue;}
  if(metric.status==='available'&&metric.quantity.unit!==item.quantity.unit)throw Error('融合操作数的单位与原指标不同');
  if(!known)continue;
  const next=value+item.quantity.value;
  if(!Number.isFinite(next)){known=false;continue;}
  item.step={before:value,after:next};value=next;
 }
 if(metric.status==='available'&&(!known||value!==metric.quantity.value))throw Error('操作数累加与原融合指标不同');
}

function maximum(items:FusionSourceOperand[]){
 if(items.some(item=>!item.quantity))return;
 const max=items.reduce((value,item)=>Math.max(value,item.quantity?.value??0),0);
 for(const item of items)if(item.quantity?.value===max)item.bottleneck=true;
 return max;
}

function usedRooflineOperands(dag:TimingDag,cost:CostResult):RooflineOperand[]{
 return rooflineMetricInputs(dag,cost,String).map(input=>({timingNodeId:input.timingNodeId,quantity:input.quantity,
  selector:{scope:cost.scope,field:input.field,...(input.field==='executedOperations'?{computeClass:input.computeClass}:{})}}));
}

export async function replayFusionCostSource(input:unknown){
 const request=FusionCostSourceRequest.parse(input),{scenario,assets,stepContext,selector,page,inputHash,engineVersion}=request;
 const extended=request.proofVersion===2;
 const {scope,field,computeClass}=selector;
 if(scope.target.kind!=='node'||!['per_device','group_total'].includes(scope.aggregation))throw Error('请选择实际融合节点或融合设备范围');
 const nodeId=scope.target.nodeId,deviceId=scope.aggregation==='per_device'?scope.deviceIds[0]:undefined;
 const computeField=field==='usefulOperations'||field==='executedOperations'?field:undefined;
 if(!!computeField!==!!computeClass)throw Error('融合计算指标须指定完整类别');
 if(scenario.workload.kind==='decode'&&scenario.workload.steps!==1)throw Error('融合成本需要选择实际 Decode 步骤');
 if(request.decodeFrame&&!stepContext)throw Error('融合成本缺少实际 Decode 上下文');
 const prefix=request.decodeFrame&&stepContext?`decode-step-${stepContext.index}::`:undefined;
 if(engineVersion!==ENGINE_VERSION||await computeInputHash(scenario,assets,stepContext)!==inputHash)throw Error('融合固定输入、实际步骤或引擎版本不匹配');
 const authored=scenario.fusionGroups.find(group=>'$fusion:'+encodeURIComponent(group.groupId)===nodeId);
 const captureBindings=extended&&field==='seconds'&&deviceId!==undefined&&authored?.timeStrategy.kind==='override'&&authored.timeStrategy.timing.kind==='custom_formula';
 const declarations:FusionDeclaration[]=[],timings:TimingDag[]=[];
 let bindingTrace:ParameterCaptureTrace|undefined;
 const replay=await analyzeScenario(scenario,assets,stepContext,{fusion:{
  nodeId,declaration:record=>declarations.push(record),
  ...(captureBindings?{bindings:(trace:ParameterCaptureTrace)=>{bindingTrace=trace;}}:{}),
  ...(field==='seconds'&&deviceId!==undefined?{timing:{deviceId,record:dag=>timings.push(dag)}}:{}),
 }});
 if(replay.status!=='available'||replay.result.inputHash!==inputHash||replay.result.engineVersion!==engineVersion)throw Error('原融合分析身份不匹配或不能复算');
 const layout=replay.result.distributed?.layout,result=replay.result.fusions?.find(f=>f.evaluation.application.nodeId===nodeId),declaration=declarations[0];
 if(!layout||!result||!declaration||declarations.length!==1)throw Error('原融合组或实际声明不存在');
 const {evaluation}=result,{application}=evaluation,perDevice=evaluation.perDevice;
 const rank=perDevice.find(row=>row.deviceId===deviceId);
 const selectedCost=scope.aggregation==='per_device'?(rank?.outcome.status==='available'?rank.outcome.cost:undefined):result.cost;
 if(!selectedCost||canonical(selectedCost.scope)!==canonical(scope))throw Error('原融合设备、节点或完整范围不匹配');
 const selectedClass=canonical(computeClass);
 function scopedMetric(cost:typeof selectedCost){
  return computeField?cost?.compute.find(c=>canonical(c.computeClass)===selectedClass)?.[computeField]:cost?.[field as 'seconds'|'hbmBytes'|'logicalReadBytes'|'logicalWriteBytes'];
 }
 const metric=scopedMetric(selectedCost);
 if(!metric||stableStringify(prefix?namespaceDiagnostics(metric,prefix):metric)!==stableStringify(request.metric))throw Error('原融合指标、单位或诊断不同');
 const members=new Map(layout.localCosts.nodes.map(n=>[n.nodeId,n.placement]));
 if(!authored||authored.groupId!==application.groupId)throw Error('缺少原融合声明');
 let operation:Operation,overrideFormula:ReturnType<typeof explainValue>|undefined,streamSpan:{startSeconds?:number;endSeconds?:number;streamId?:string}|undefined;
 let dag:TimingDag|undefined;
 const contributions:FusionSourceOperand[]=[];
 function appendDeviceTerm(row:LocalDeviceCost,kind:'member'|'extra',id:NodeId){
  const identity={kind,nodeId:id,deviceId:row.deviceId};
  if(row.outcome.status==='unavailable'){
   if(!computeField||metric?.status==='unavailable')contributions.push(operand(identity,row.outcome));
   return;
  }
  const {cost}=row.outcome;
  if(computeField){
   for(const [index,segment] of cost.compute.entries())if(canonical(segment.computeClass)===selectedClass)contributions.push(operand({...identity,computeIndex:index},segment[computeField]));
  }else{
   const term=scopedMetric(cost);
   if(term)contributions.push(operand(identity,term));
  }
 }
 function appendBarrier(id:NodeId,rows:LocalDeviceCost[],missing?:string[]){
  const ranks=rows.map(row=>operand({kind:'barrier_rank',nodeId:id,deviceId:row.deviceId},row.outcome.status==='available'?row.outcome.cost.seconds:row.outcome));
  const max=missing?undefined:maximum(ranks),diagnosticIds=missing??[...new Set(ranks.flatMap(term=>term.diagnosticIds??[]))];
  const barrier:FusionSourceOperand={kind:'barrier',nodeId:id,...(max===undefined?{diagnosticIds}:{quantity:{value:max,unit:'second'}})};
  contributions.push(barrier,...ranks);
  return barrier;
 }

 if(scope.aggregation==='group_total'){
  for(const row of perDevice){
   const term=row.outcome.status==='available'?scopedMetric(row.outcome.cost):row.outcome;
   if(term)contributions.push(operand({kind:'device',nodeId,deviceId:row.deviceId},term));
  }
  if(field!=='seconds'){operation='sum_devices';checkedSum(contributions,metric);}
  else if(layout.execution.status==='available'&&layout.execution.result.policy==='streams'){
   operation='stream_span';
   const step=layout.execution.result.steps.find(s=>s.nodeId===nodeId);
   if(step)streamSpan={...(step.startSeconds===undefined?{}:{startSeconds:step.startSeconds}),...(step.endSeconds===undefined?{}:{endSeconds:step.endSeconds}),...(step.streamId?{streamId:step.streamId}:{})};
   if(metric.status==='available'&&(step?.startSeconds===undefined||step.endSeconds===undefined||step.endSeconds-step.startSeconds!==metric.quantity.value))throw Error('实际融合调度跨度与原指标不同');
  }else{
   operation='max_devices';
   const max=maximum(contributions);
   if(metric.status==='available'&&metric.quantity.value!==max)throw Error('最慢设备耗时与原融合指标不同');
  }
 }else if(field!=='seconds'){
  operation='sum_device_terms';
  for(const id of application.memberNodeIds){
   const placement=members.get(id);
   const row=placement?.kind==='placed'?placement.perDevice.find(device=>device.deviceId===deviceId):undefined;
   if(row)appendDeviceTerm(row,'member',id);
  }
  const row=evaluation.extraPerDevice.find(device=>device.deviceId===deviceId);
  if(row)appendDeviceTerm(row,'extra',application.extraNodeId);
  checkedSum(contributions,metric);
 }else if(application.timeStrategy.kind==='sum_members'){
  operation='sum_member_barriers';
  const barriers=application.memberNodeIds.map(id=>{
   const member=members.get(id);
   return appendBarrier(id,member?.kind==='placed'?member.perDevice:[],member?.kind==='unplaced'?member.diagnosticIds:member?undefined:metric.diagnosticIds);
  });
  barriers.push(appendBarrier(application.extraNodeId,evaluation.extraPerDevice));
  checkedSum(barriers,metric);
 }else{
  const {timing}=application.timeStrategy;
  if(timing.kind==='fixed'){
   operation='fixed_override';
   if(metric.status==='available'&&metric.quantity.value!==timing.seconds)throw Error('融合固定耗时与原指标不同');
  }else if(timing.kind==='custom_formula'){
   operation='formula_override';
   if(authored.timeStrategy.kind!=='override'||authored.timeStrategy.timing.kind!=='custom_formula')throw Error('缺少整体融合耗时的原公式');
   if(metric.status==='available'){
    overrideFormula=explainValue(authored.timeStrategy.timing.seconds,declaration.symbols,assets);
    if(canonical(overrideFormula.quantity)!==canonical(metric.quantity))throw Error('融合耗时公式与原指标不同');
   }
  }else{
   operation='roofline_override';dag=timings[0];
   if(!dag||timings.length!==1)throw Error('缺少实际融合设备的 Roofline 观察');
   const root=dag.nodes.find(n=>n.id===dag?.root);
   if(dag.completeTiming&&(metric.status!=='available'||root?.value!==metric.quantity.value))throw Error('融合 Roofline 运算与原耗时不同');
  }
 }

 const physicalDefinition=layout.singleDeviceBaseline?'global':'local';
 const removed=declaration.removed.filter(resource=>resource.definition===physicalDefinition).map(resource=>({...resource,resourceRemoved:true as const}));
 const eliminated=new Set(application.eliminatedStorageIds);
 const allocations:ElidedAllocation[]=layout.storageAllocations.flatMap(storage=>{
  if(!eliminated.has(storage.storageId)||storage.allocation.materialization!=='elided')return [];
  return storage.allocation.perDevice.filter(row=>deviceId===undefined||row.deviceId===deviceId).map(row=>({
   kind:'elided_allocation',storageId:storage.storageId,deviceId:row.deviceId,
   ...(row.totalBytes.status==='available'?{quantity:row.totalBytes.quantity}:{}),...(row.totalBytes.diagnosticIds.length?{diagnosticIds:row.totalBytes.diagnosticIds}:{}),
  }));
 });
 const count=contributions.length+removed.length+allocations.length,start=page*pageSize;
 if(page>0&&start>=count)throw Error('请求的融合来源页不存在');
 const items:FusionSourceItem[]=[...contributions,...removed,...allocations].slice(start,start+pageSize);
 const diagnosticIds=new Set([...metric.diagnosticIds,...items.flatMap(item=>'diagnosticIds'in item?item.diagnosticIds??[]:[])]);
 const diagnostics=replay.result.diagnostics.filter(d=>diagnosticIds.has(d.diagnosticId));
 const hardware=deviceId===undefined?undefined:scenario.deviceTopology.devices.find(d=>d.deviceId===deviceId)?.hardware;
 const selectedTimeStrategy=application.timeStrategy;
 const extraDevices=evaluation.extraPerDevice.filter(row=>row.outcome.status==='available').map(row=>row.deviceId);
 let parameterBindings:ReturnType<typeof fusionParameterBindingGraph>|undefined;
 if(extended&&overrideFormula){
  const frames=declaration.parameterFrames?.root;
  if(!bindingTrace||!frames)throw Error('未采集到整体融合耗时的实际参数域');
  const reads=parameterReads(overrideFormula.proof,(name,quantity)=>{
   const frameId=Object.hasOwn(frames,name)?frames[name]:undefined;
   return {name,quantity,target:'整体融合耗时',frameId:frameId??'unrecorded-fusion-frame'};
  });
  parameterBindings=fusionParameterBindingGraph({...bindingTrace,truncated:bindingTrace.truncated||overrideFormula.truncated},assets,reads);
 }
 const rooflineOperands=extended&&dag?usedRooflineOperands(dag,selectedCost):undefined;
 const evidence={operation,metric,items,diagnostics,groupId:application.groupId,owner:application.ownerNodeId,extraNodeId:application.extraNodeId,
  memberCount:application.memberNodeIds.length,eliminatedTensorCount:application.eliminatedTensorIds.length,removedCount:removed.length,
  ...(application.origin?{origin:application.origin}:{}),selectedTimeStrategy,extraDevices,
  ...(hardware?{hardware}:{}),...(dag?{dag}:{}),...(streamSpan?{streamSpan}:{}),...(overrideFormula?{overrideFormula}:{})};
 jsonBytes(evidence,8*1024*1024);
 return {kind:'fusion_cost_source' as const,schemaVersion:extended?2 as const:1 as const,selector,inputHash,engineVersion,page,pageSize,componentCount:count,
  ...(prefix?namespaceDiagnostics(evidence,prefix):evidence),...(parameterBindings?{parameterBindings}:{}),
  ...(rooflineOperands?{rooflineOperands}:{}),request};
}

export type FusionCostSourceReport=Awaited<ReturnType<typeof replayFusionCostSource>>;

export async function verifyFusionCostSourceReport(input:unknown){
 const saved=z.object({kind:z.literal('fusion_cost_source'),schemaVersion:z.union([z.literal(1),z.literal(2)]),request:FusionCostSourceRequest}).passthrough().parse(input);
 const report=await replayFusionCostSource(saved.request);
 if(stableStringify(saved)!==stableStringify(report))throw Error('融合来源报告与固定输入复算不同');
 return report;
}
