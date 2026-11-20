import {z} from 'zod';
import {AssetDocument,NodeId,ProjectDocument,Scenario} from '@model-analyser/contracts';
import {instantiateModel} from '@model-analyser/core';
import {confirmConfigModel} from '../../../packages/contracts/src/config-import.js';
import {confirmAscendQuantization} from '../../../packages/core/src/ascend-quantization.js';
export type ModelValidationTask={taskId:string}&(
 {kind:'model';scenario:Scenario;assets:AssetDocument[]}|
 {kind:'targets';scenario:Scenario;assets:AssetDocument[];nodeIds:string[]}|
 {kind:'config';asset:AssetDocument;library:AssetDocument[]}|
 {kind:'ascend';project:ProjectDocument;scenarioId:string;importId:string;note:string});
export const ModelValidationReply=z.strictObject({taskId:z.string(),reply:z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('validated')}),z.strictObject({kind:z.literal('asset'),asset:AssetDocument}),z.strictObject({kind:z.literal('project'),project:ProjectDocument}),z.strictObject({kind:z.literal('error'),message:z.string()})])});
export type ModelValidationReply=z.infer<typeof ModelValidationReply>;
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
if(typeof self!=='undefined'&&typeof document==='undefined')self.onmessage=(event:MessageEvent<ModelValidationTask>)=>self.postMessage(evaluateModelValidationTask(event.data));
