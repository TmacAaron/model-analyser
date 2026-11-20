import type {AnalysisResult,MetricValue} from '@model-analyser/contracts';
import {logicalFusionExtraRows,logicalWorkRows,type AggregateCostSelector,type CommunicationCostSelector,type FusionCostSelector,type LayoutSourceSelector,type LeafCostSelector,type LocalCostSelector,type LogicalWorkSelector} from '@model-analyser/core';
import {logicalTargetId} from './compute-source.js';

export type SourceReport=Pick<AnalysisResult,'total'|'nodes'|'modules'|'memory'|'fusions'|'distributed'|'diagnostics'|'parameterTrace'|'decode'>;
export type SourceMetric={id:string;label:string;value:MetricValue;selector?:LeafCostSelector;aggregateSelector?:AggregateCostSelector;communicationSelector?:CommunicationCostSelector;localSelector?:LocalCostSelector;fusionSelector?:FusionCostSelector;logicalSelector?:LogicalWorkSelector;layoutSelector?:LayoutSourceSelector};
export type SourceTarget={id:string;label:string;readMetrics:()=>SourceMetric[];local?:Pick<LocalCostSelector,'nodeId'|'deviceId'>};
function metricIdentity(scope:AggregateCostSelector['scope']|undefined,field:AggregateCostSelector['field'],computeClass?:AggregateCostSelector['computeClass']){
 if(!scope)return {};
 const aggregateSelector={scope,field,...(computeClass?{computeClass}:{})};
 return {aggregateSelector,...(scope.target.kind==='node'?{selector:{...aggregateSelector,nodeId:scope.target.nodeId}}:{})};
}
function computeMetrics(cost:Pick<SourceReport['total'],'compute'> & Partial<Pick<SourceReport['total'],'scope'>>):SourceMetric[]{return cost.compute.flatMap((c,i)=>[{id:'useful:'+i,label:`${c.computeClass.resource} ${c.computeClass.multiplyDtype.format}/${c.computeClass.accumulateDtype.format} 有效工作`,value:c.usefulOperations,...metricIdentity(cost.scope,'usefulOperations',c.computeClass)},{id:'executed:'+i,label:`${c.computeClass.resource} ${c.computeClass.multiplyDtype.format}/${c.computeClass.accumulateDtype.format} 执行工作`,value:c.executedOperations,...metricIdentity(cost.scope,'executedOperations',c.computeClass)}]);}
function costMetrics(cost:SourceReport['total']):SourceMetric[]{return [{id:'seconds',label:'理论耗时',value:cost.seconds,...metricIdentity(cost.scope,'seconds')},{id:'read',label:'逻辑读取',value:cost.logicalReadBytes,...metricIdentity(cost.scope,'logicalReadBytes')},{id:'write',label:'逻辑写入',value:cost.logicalWriteBytes,...metricIdentity(cost.scope,'logicalWriteBytes')},{id:'hbm',label:'估计 HBM',value:cost.hbmBytes,...metricIdentity(cost.scope,'hbmBytes')},...computeMetrics(cost),...cost.communications.flatMap((c,i)=>[{id:'send:'+i,label:`${c.groupId} ${c.operation} 每成员发送消息`,value:c.sendBytesPerMember},{id:'receive:'+i,label:`${c.groupId} ${c.operation} 每成员接收消息`,value:c.receiveBytesPerMember},{id:'algorithm:'+i,label:`${c.groupId} ${c.operation} 每成员算法流量`,value:c.algorithmTrafficBytesPerMember},{id:'group-send:'+i,label:`${c.groupId} ${c.operation} 组发送合计`,value:c.groupSendBytes},{id:'group-receive:'+i,label:`${c.groupId} ${c.operation} 组接收合计`,value:c.groupReceiveBytes}])];}
const communicationFields:Record<string,CommunicationCostSelector['field']>={seconds:'seconds','send:0':'sendBytesPerMember','receive:0':'receiveBytesPerMember','algorithm:0':'algorithmTrafficBytesPerMember','group-send:0':'groupSendBytes','group-receive:0':'groupReceiveBytes'};
export const localId=(nodeId:string,deviceId:string)=>'local:'+JSON.stringify([nodeId,deviceId]);
export const fusionDeviceId=(nodeId:string,deviceId:string)=>'fusion-device:'+JSON.stringify([nodeId,deviceId]);
function localTarget(cost:SourceReport['total'],nodeId:LocalCostSelector['nodeId'],deviceId:LocalCostSelector['deviceId'],fusionNodeId?:LocalCostSelector['fusionNodeId']):SourceTarget{
 const local={nodeId,deviceId};
 const readMetrics=()=>costMetrics(cost).map(metric=>{
  if(!metric.selector)return metric;
  const computeIndex=metric.selector.computeClass?Number(metric.id.split(':')[1]):undefined;
  return {...metric,label:computeIndex===undefined?metric.label:metric.label+' · 计算段 '+(computeIndex+1),
   localSelector:{...metric.selector,...local,...(computeIndex===undefined?{}:{computeIndex}),...(fusionNodeId?{fusionNodeId}:{})}};
 });
 return {id:localId(nodeId,deviceId),label:(fusionNodeId?'融合附加 ':'局部 ')+nodeId+' / '+deviceId,readMetrics,local};
}
const fusionMetrics=(cost:SourceReport['total'])=>costMetrics(cost).map(metric=>metric.aggregateSelector?{...metric,fusionSelector:metric.aggregateSelector}:metric);
function logicalMetrics(row:ReturnType<typeof logicalWorkRows>[number],fusionNodeId?:LogicalWorkSelector['fusionNodeId']):SourceMetric[]{
 return computeMetrics(row).map(metric=>{
  const selector=metric.aggregateSelector;
  if(!selector?.computeClass||(selector.field!=='usefulOperations'&&selector.field!=='executedOperations'))return metric;
  return {...metric,label:selector.field==='executedOperations'?metric.label.replace('执行工作','声明执行工作'):metric.label,
   logicalSelector:{scope:row.scope,field:selector.field,computeClass:selector.computeClass,...(fusionNodeId?{fusionNodeId}:{})}};
 });
}

function* sourceTargets(report:SourceReport,actualDecodeStep:boolean):Generator<SourceTarget>{
 yield {id:'model',label:report.distributed?'模型物理汇总':'模型汇总',readMetrics:()=>costMetrics(report.total)};
 for(const row of report.modules)yield {id:'module:'+row.nodeId,label:'模块 '+row.nodeId,readMetrics:()=>costMetrics(row.cost)};
 for(const row of report.nodes)yield {id:'node:'+row.nodeId,label:'节点 '+row.nodeId,readMetrics:()=>costMetrics(row.cost)};
 for(const fusion of report.fusions??[]){
  const {nodeId,extraNodeId}=fusion.evaluation.application;
  yield {id:'fusion:'+nodeId,label:'融合 '+nodeId,readMetrics:()=>fusionMetrics(fusion.cost)};
  for(const device of fusion.evaluation.perDevice)if(device.outcome.status==='available'){
   const {cost}=device.outcome;
   yield {id:fusionDeviceId(nodeId,device.deviceId),label:'融合 '+nodeId+' / '+device.deviceId,readMetrics:()=>fusionMetrics(cost)};
  }
  for(const device of fusion.evaluation.extraPerDevice)if(device.outcome.status==='available')yield localTarget(device.outcome.cost,extraNodeId,device.deviceId,nodeId);
 }
 for(const [i,memory] of report.memory.entries())yield {
  id:'memory:'+i,label:'生命周期显存 '+(memory.deviceScope.kind==='per_device'?memory.deviceScope.deviceId:memory.deviceScope.deviceIds.join(', ')),
  readMetrics:()=>[{id:'peak',label:'峰值（含显式覆盖）',value:memory.peakBytes},...memory.categoryBreakdown.map(c=>({id:c.category,label:c.category+' 峰值分解',value:c.bytes}))],
 };
 const logical=report.decode?.logicalCompute??(report.distributed||actualDecodeStep?logicalWorkRows(report):[]);
 for(const row of logical)if(row.compute.length)yield {
  id:logicalTargetId(row.scope.target),label:'逻辑工作 '+(row.scope.target.kind==='model'?'模型':row.scope.target.nodeId),readMetrics:()=>logicalMetrics(row),
 };
 if(report.fusions?.length)for(const {row,fusionNodeId} of logicalFusionExtraRows(report))yield {
  id:'logical-extra:'+fusionNodeId,label:'逻辑融合附加项 '+fusionNodeId,readMetrics:()=>logicalMetrics(row,fusionNodeId),
 };
 const layout=report.distributed?.layout;
 if(!layout)return;
 for(const node of layout.localCosts.nodes)if(node.placement.kind==='placed')for(const device of node.placement.perDevice)
  if(device.outcome.status==='available')yield localTarget(device.outcome.cost,node.nodeId,device.deviceId);
 for(const storage of layout.storageAllocations)yield {
  id:'storage:'+storage.storageId,label:'规范存储 '+storage.storageId,
  readMetrics:()=>storage.allocation.perDevice.map(d=>({id:d.deviceId,label:d.deviceId+' 分配（非峰值）',value:d.totalBytes,layoutSelector:{kind:'storage',storageId:storage.storageId,deviceId:d.deviceId}})),
 };
 for(const communication of layout.communications)yield {
  id:'communication:'+communication.index,label:'通信 '+(communication.evaluation.definition.placement?.nodeId??'#'+(communication.index+1)),
  readMetrics:()=>costMetrics(communication.evaluation.cost).map(metric=>{
   const field=communicationFields[metric.id];
   if(!field)return metric;
   return {...metric,...(field==='seconds'?{label:'网络理论耗时'}:{}),communicationSelector:{
    index:communication.index,scope:communication.evaluation.cost.scope,field,...(communication.origin?{nativeNodeId:communication.origin.nodeId}:{}),
   }};
  }),
 };
}

/** Index the scope identities once. Numeric source selectors are built only for opened scopes. */
export function indexSourceTargets(report:SourceReport,actualDecodeStep:boolean){
 const targets=new Map<string,SourceTarget>(),localByNode=new Map<string,SourceTarget[]>();
 const searchEntries:{target:SourceTarget;text:string}[]=[];
 for(const target of sourceTargets(report,actualDecodeStep)){
  if(!targets.has(target.id))targets.set(target.id,target);
  searchEntries.push({target,text:(target.id+' '+target.label).toLowerCase()});
  if(target.local){
   const siblings=localByNode.get(target.local.nodeId);
   if(siblings)siblings.push(target);
   else localByNode.set(target.local.nodeId,[target]);
  }
 }
 const first=searchEntries.slice(0,100).map(entry=>entry.target);
 return {
  targets,localByNode,
  search(query:string){
   if(!query)return {count:searchEntries.length,visible:first};
   const match=query.toLowerCase(),visible:SourceTarget[]=[];
   let count=0;
   for(const {target,text} of searchEntries)if(text.includes(match)){
    count++;
    if(visible.length<100)visible.push(target);
   }
   return {count,visible};
  },
 };
}

export function findSourceTarget(report:SourceReport,id:string,actualDecodeStep:boolean){
 for(const target of sourceTargets(report,actualDecodeStep))if(target.id===id)return target;
}
export function sourceFrame(result:AnalysisResult,step:string){
 const call=step==='aggregate'?undefined:result.decode?.steps.find(item=>String(item.index)===step);
 return {report:step==='aggregate'?result:call?.result,scenario:call?.scenario,actual:!!call};
}
export function sourceProblem(report:SourceReport|undefined,target:SourceTarget|undefined,metric:SourceMetric|undefined){
 return !report?'请求的来源步骤不存在；不会改成序列汇总。':!target?'请求的成本来源范围不存在；不会改成其他范围。':!metric?'请求的来源指标不存在；不会改成其他指标。':undefined;
}
export function resolveSourceSelection(result:AnalysisResult,step:string,targetId:string,metricId:string){
 const {report,scenario,actual}=sourceFrame(result,step);
 const target=report?findSourceTarget(report,targetId,actual):undefined,metric=target?.readMetrics().find(item=>item.id===metricId);
 return {report,scenario,target,metric,problem:sourceProblem(report,target,metric)};
}
