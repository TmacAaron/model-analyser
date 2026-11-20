import {z} from 'zod';
import {MetricScope,type AnalysisResult,type CostResult,type MetricValue,type NodeId,type SerialExecution} from '@model-analyser/contracts';
import {canonical} from '../../contracts/src/validation.js';
import {analyzeScenario} from './analyze.js';
import {ENGINE_VERSION} from './version.js';
import {computeInputHash,stableStringify} from './input-hash.js';
import {LeafCostSelector,LeafCostSourceRequest} from './leaf-cost-context.js';
import {modelCostInputs,moduleCostInputs,stepCostInputs} from './aggregate-members.js';

export const AggregateCostSelector=LeafCostSelector.omit({nodeId:true}).extend({scope:MetricScope});
export type AggregateCostSelector=z.infer<typeof AggregateCostSelector>;
export const AggregateCostSourceRequest=LeafCostSourceRequest.extend({selector:AggregateCostSelector});
export type AggregateCostSourceRequest=z.input<typeof AggregateCostSourceRequest>;
const pageSize=20;

function selectedMetric(cost:CostResult,selector:AggregateCostSelector){
 const {field,computeClass}=selector;
 if(field==='usefulOperations'||field==='executedOperations'){
  const row=cost.compute.find(entry=>canonical(entry.computeClass)===canonical(computeClass));
  return row?.[field];
 }
 return cost[field];
}

type Available=Extract<MetricValue,{status:'available'}>;
type OperandIdentity={target:MetricScope['target'];deviceIds:MetricScope['deviceIds'];kind:'model'|'module'|'node'|'fusion'|'communication'|'metadata';step?:{index:number;inputHash:string;evaluatedContext:number}};
type SumOperand=OperandIdentity&{quantity:Available['quantity'];basis:Available['basis'];diagnosticIds:string[];before:number;after:number};
type IntervalOperand=OperandIdentity&{startSeconds:number;endSeconds:number;streamId?:string};

function sumProof(inputs:{identity:OperandIdentity;metric:MetricValue|undefined}[],metric:Available,page:number,operation:'ordered_sum'|'serial_barriers'){
 const start=page*pageSize,items:SumOperand[]=[];
 let count=0,value=0;
 for(const input of inputs){
  const leaf=input.metric;
  // A leaf without the selected class does not enter the engine's class-specific fold.
  if(!leaf)continue;
  if(leaf.status!=='available'||leaf.quantity.unit!==metric.quantity.unit)throw Error('汇总来源含缺项或单位不同');
  const before=value;
  value+=leaf.quantity.value;
  if(count>=start&&count<start+pageSize)items.push({...input.identity,quantity:leaf.quantity,basis:leaf.basis,diagnosticIds:leaf.diagnosticIds,before,after:value});
  count++;
 }
 if(value!==metric.quantity.value)throw Error('按实际顺序合计的值与原指标不同');
 return {operation,memberCount:inputs.length,componentCount:count,items};
}

function timelineIdentity(step:SerialExecution['steps'][number],fusionIds:ReadonlySet<NodeId>):OperandIdentity{
 const kind=step.kind==='compute'?fusionIds.has(step.nodeId)?'fusion':'node':step.kind;
 return {target:{kind:'node',nodeId:step.nodeId},deviceIds:step.deviceIds,kind};
}

function intervalProof(execution:SerialExecution,steps:SerialExecution['steps'],metric:Available,page:number,isModel:boolean,fusionIds:ReadonlySet<NodeId>){
 let first=Number.POSITIVE_INFINITY,last=0;
 const items:IntervalOperand[]=[];
 for(const [index,step] of steps.entries()){
  const {startSeconds,endSeconds,streamId}=step;
  if(startSeconds===undefined||endSeconds===undefined)throw Error('执行节点缺少实际起止时刻');
  first=Math.min(first,startSeconds);
  last=Math.max(last,endSeconds);
  if(index>=page*pageSize&&index<(page+1)*pageSize)items.push({...timelineIdentity(step,fusionIds),startSeconds,endSeconds,...(streamId?{streamId}:{})});
 }
 if(!steps.length)first=0;
 const terminal=isModel?execution.streams?.slices.at(-1):undefined;
 const startSeconds=isModel?0:first,endSeconds=isModel?terminal?.endSeconds??0:last;
 if((isModel&&last!==endSeconds)||endSeconds-startSeconds!==metric.quantity.value)throw Error('实际调度跨度与原指标不同');
 return {operation:isModel?'stream_makespan' as const:'module_stream_span' as const,componentCount:steps.length,memberCount:steps.length,items,startSeconds,endSeconds,...(terminal?{terminalEvent:{startSeconds:terminal.startSeconds,endSeconds:terminal.endSeconds,activeDeviceTasks:terminal.progress.length}}:{})};
}

function selectProof(result:AnalysisResult,selector:AggregateCostSelector,metric:Available,page:number){
 const {target}=selector.scope;
 if(result.decode){
  const parts=stepCostInputs(result.decode.steps,target);
  return sumProof(parts.map(({cost,step})=>{
   const scope=cost.scope,fusion=step.result.fusions?.some(row=>row.cost===cost);
   const identity:OperandIdentity={target:scope.target,deviceIds:scope.deviceIds,kind:fusion?'fusion':scope.target.kind,step:{index:step.index,inputHash:step.result.inputHash,evaluatedContext:step.evaluatedContext}};
   return {identity,metric:selectedMetric(cost,selector)};
  }),metric,page,'ordered_sum');
 }
 if(target.kind==='node')throw Error('单步节点请选择叶节点来源');
 const fusions=result.fusions??[],fusionIds=new Set(fusions.map(row=>row.evaluation.application.nodeId));
 const module=target.kind==='module'?result.modules.find(row=>row.nodeId===target.nodeId):undefined;
 if(target.kind==='module'&&!module)throw Error('原模块没有实际成员记录');
 const costs=module?moduleCostInputs(module.leafNodeIds,new Map(result.nodes.map(row=>[row.nodeId,row])),fusions).costs:modelCostInputs(result.nodes,fusions,new Set(fusions.flatMap(row=>row.evaluation.application.memberNodeIds)));
 const execution=result.distributed?.layout.execution;
 if(selector.field==='seconds'&&execution?.status==='available'){
  const schedule=execution.result;
  if(target.kind==='model'){
   if(schedule.policy==='streams')return intervalProof(schedule,schedule.steps,metric,page,true,fusionIds);
   let running=0;
   const parts=schedule.steps.map(step=>{
    if(step.startSeconds!==running||step.duration.status!=='available')throw Error('串行屏障缺少连续的实际时刻');
    running+=step.duration.quantity.value;
    if(step.endSeconds!==running)throw Error('实际串行屏障的结束时刻与累计耗时不同');
    return {identity:timelineIdentity(step,fusionIds),metric:step.duration};
   });
   return sumProof(parts,metric,page,'serial_barriers');
  }
  if(schedule.policy==='streams'){
   const memberIds=new Set(costs.flatMap(cost=>cost.scope.target.kind==='node'?[cost.scope.target.nodeId]:[]));
   const steps=schedule.steps.filter(step=>memberIds.has(step.nodeId));
   return intervalProof(schedule,steps,metric,page,false,fusionIds);
  }
 }
 const communicationIds=new Set(execution?.status==='available'?execution.result.steps.filter(step=>step.kind==='communication').map(step=>step.nodeId):[]);
 for(const communication of result.distributed?.layout.communications??[]){
  const id=communication.origin?.nodeId??communication.evaluation.definition.placement?.nodeId;
  if(id)communicationIds.add(id);
 }
 const parts=costs.map(cost=>{
  const scope=cost.scope,target=scope.target;
  const kind:OperandIdentity['kind']=target.kind==='node'&&fusionIds.has(target.nodeId)?'fusion':target.kind==='node'&&communicationIds.has(target.nodeId)?'communication':target.kind;
  return {identity:{target,deviceIds:scope.deviceIds,kind},metric:selectedMetric(cost,selector)};
 });
 return sumProof(parts,metric,page,'ordered_sum');
}

export async function replayAggregateCostSource(input:unknown){
 const request=AggregateCostSourceRequest.parse(input),{scenario,assets,stepContext,selector,page,inputHash,engineVersion}=request;
 const compute=selector.field==='usefulOperations'||selector.field==='executedOperations';
 if(compute!==!!selector.computeClass)throw Error('计算指标需要完整计算分类');
 if(engineVersion!==ENGINE_VERSION||await computeInputHash(scenario,assets,stepContext)!==inputHash)throw Error('固定配置、实际步骤或引擎版本与原结果不同');
 const attempt=await analyzeScenario(scenario,assets,stepContext);
 if(attempt.status!=='available')throw Error('原聚合配置不能复算');
 const result=attempt.result,target=selector.scope.target;
 const cost=target.kind==='model'?result.total:target.kind==='module'?result.modules.find(row=>row.nodeId===target.nodeId)?.cost:result.nodes.find(row=>row.nodeId===target.nodeId)?.cost;
 if(!cost||canonical(cost.scope)!==canonical(selector.scope))throw Error('精确聚合范围与原结果不同');
 const metric=selectedMetric(cost,selector);
 if(!metric||metric.status!=='available'||result.inputHash!==inputHash||result.engineVersion!==engineVersion||stableStringify(metric)!==stableStringify(request.metric))throw Error('原指标、单位或诊断与固定输入复算不同');
 const proof=selectProof(result,selector,metric,page);
 if(page>0&&page*pageSize>=proof.componentCount)throw Error('请求的聚合来源页不存在');
 return {schemaVersion:1 as const,kind:'aggregate_cost_source' as const,selector,metric,engineVersion,inputHash,page,pageSize,...proof,request};
}

export type AggregateCostSourceReport=Awaited<ReturnType<typeof replayAggregateCostSource>>;

export async function verifyAggregateCostSourceReport(input:unknown){
 if(!input||typeof input!=='object'||!('kind'in input)||input.kind!=='aggregate_cost_source'||!('schemaVersion'in input)||input.schemaVersion!==1||!('request'in input))throw Error('无效的聚合来源报告');
 const actual=await replayAggregateCostSource(input.request);
 if(stableStringify(actual)!==stableStringify(input))throw Error('聚合来源与固定输入复算不同');
 return actual;
}
