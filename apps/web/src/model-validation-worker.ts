import {NodeId,Scenario} from '@model-analyser/contracts';
import {instantiateModel,resolveParallelPlan} from '@model-analyser/core';
import {confirmConfigModel} from '../../../packages/contracts/src/config-import.js';
import {confirmAscendQuantization} from '../../../packages/core/src/ascend-quantization.js';
import type {ModelValidationReply,ModelValidationTask} from './model-validation-protocol.js';
export type {ModelValidationTask} from './model-validation-protocol.js';
/** Validation returns no publishable change until every requested check has succeeded. */
export function evaluateModelValidationTask(task:ModelValidationTask):ModelValidationReply{
 try{
  if(task.kind==='ascend')return {taskId:task.taskId,reply:{kind:'project',project:confirmAscendQuantization(task.project,task.scenarioId,task.importId,task.note)}};
  if(task.kind==='config'){
   const asset=confirmConfigModel(task.asset);
   for(const phase of ['prefill','decode'] as const){const scenario=Scenario.parse({scenarioId:'config:probe',name:'Config structure validation',model:{assetId:asset.assetId,revision:asset.revision,kind:'model'},bindings:[],workload:phase==='prefill'?{kind:phase,batchSize:1,queryTokensPerRequest:1,pastTokensPerRequest:0}:{kind:phase,batchSize:1,contextTokensPerRequest:0,queryTokensPerRequest:1,steps:1},deviceTopology:{devices:[{deviceId:'config:probe',hardware:{assetId:'config:probe:hardware',revision:1,kind:'hardware'}}],groups:[]},parallelPlan:{assignments:[],communications:[],assumptions:[]},executionPlan:{kind:'serial'},quantizationOverrides:[],numericOverrides:[],fusionGroups:[]}),result=instantiateModel(scenario,[asset,...task.library]);if(result.status==='unavailable')throw Error(phase+' 结构无法展开：'+result.diagnostics.map(d=>d.code+' '+d.message).join('；'));}
   return {taskId:task.taskId,reply:{kind:'asset',asset}};
  }
  const ids=task.kind==='targets'?task.nodeIds.map(id=>NodeId.parse(id)):[],result=instantiateModel(task.scenario,task.assets);if(result.status==='unavailable')throw Error(result.diagnostics.map(d=>d.code+' '+d.message).join('；'));
  if(ids.length){const targets=new Set([...result.resolved.graph.nodes.map(n=>n.nodeId),...result.resolved.containers.map(c=>c.nodeId),...result.resolved.fusionApplications.map(f=>f.nodeId),...task.scenario.parallelPlan.communications.flatMap(c=>c.placement?[c.placement.nodeId]:[])]);for(const id of ids)if(!targets.has(id))throw Error('未匹配稳定节点或容器 ID：'+id);}
  return {taskId:task.taskId,reply:{kind:'validated'}};
 }catch(e){return {taskId:task.taskId,reply:{kind:'error',message:e instanceof Error?e.message:'模型校验失败'}};}
}
if(typeof self!=='undefined'&&typeof document==='undefined')self.onmessage=async(event:MessageEvent<ModelValidationTask>)=>{
 const task=event.data;
 if(task.kind!=='model'||!task.validateLayout){self.postMessage(evaluateModelValidationTask(task));return;}
 try{
  const {scenario}=task,workload=scenario.workload;
  const first=workload.kind==='decode'&&workload.steps>1?{...scenario,workload:{...workload,steps:1}}:scenario;
  if(first!==scenario){
   const structure=evaluateModelValidationTask(task);
   if(structure.reply.kind==='error'){self.postMessage(structure);return;}
  }
  const attempt=await resolveParallelPlan(first,task.assets);
  if(attempt.status==='unavailable')throw Error(attempt.diagnostics.map(d=>d.message).join('；'));
  const {execution,unassignedStorageIds,unassignedTensorUses,diagnostics}=attempt.result;
  // Network-only collectives leave local HBM unknown while keeping a valid layout.
  const errors=diagnostics.filter(d=>d.severity==='error'&&d.code!=='missing_communication_memory');
  if(errors.length)throw Error(errors.map(d=>d.message).join('；'));
  if(execution.status!=='available'||execution.result.blockedNodeIds.length||execution.result.unplacedCommunicationIndices.length||
     unassignedStorageIds.length||unassignedTensorUses.length)throw Error('新模型修订无法沿用当前完整布局');
  self.postMessage({taskId:task.taskId,reply:{kind:'validated'}});
 }catch(e){self.postMessage({taskId:task.taskId,reply:{kind:'error',message:e instanceof Error?e.message:'新模型布局校验失败'}});}
};
