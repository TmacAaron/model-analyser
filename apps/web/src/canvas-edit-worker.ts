import {z} from 'zod';
import {AssetDocument,AssetDraft,AssetRef,ProjectDocument,type Scenario} from '@model-analyser/contracts';
import {calculationInput} from '@model-analyser/core';
import {connectCanvasNodes,graphAsset,prepareCanvasEdit} from './canvas-editing.js';
export type CanvasConnectionIntent={asset:AssetDocument;fromId:string;toId:string;kind:'data'|'control'|'synchronization';outputPort:string;inputPort:string;removeId?:string};
export type CanvasEditControls={signal:AbortSignal;onPublishing:()=>void};
export type CanvasEditTask={taskId:string}&({kind:'references';scenario:Scenario;assets:AssetDocument[];catalog:{assetId:string;revision:number;kind:AssetRef['kind']}[]}|{kind:'prepare';project:ProjectDocument;modelRef:AssetRef;intent:CanvasConnectionIntent;library:AssetDocument[]});
const Plan=z.strictObject({project:ProjectDocument,records:z.array(z.strictObject({asset:AssetDocument,draft:AssetDraft,draftRequestId:z.string().min(1),commitRequestId:z.string().min(1),draftSaved:z.literal(false),committed:z.literal(false)}))});
export const CanvasEditReply=z.strictObject({taskId:z.string(),reply:z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('references'),refs:z.array(AssetRef)}),z.strictObject({kind:z.literal('prepared'),plan:Plan}),z.strictObject({kind:z.literal('error'),message:z.string()})])});
export type CanvasEditReply=z.infer<typeof CanvasEditReply>;
/** Pure preparation. No library or project publication can occur inside this worker. */
export function evaluateCanvasEditTask(task:CanvasEditTask):CanvasEditReply{
 try{
  if(task.kind==='references'){const refs=calculationInput(task.scenario,task.assets).assets.filter(a=>task.catalog.some(e=>e.assetId===a.assetId&&e.revision>=a.revision&&e.kind===a.definition.kind)).map(a=>({assetId:a.assetId,revision:a.revision,kind:a.definition.kind}));return {taskId:task.taskId,reply:{kind:'references',refs}};}
  const {intent}=task,asset=graphAsset(intent.asset);if(!asset)throw Error('当前节点没有可编辑的模块定义');
  const edited=intent.removeId?AssetDocument.parse({...asset,definition:{...asset.definition,graph:{...asset.definition.graph,edges:asset.definition.graph.edges.filter(e=>e.edgeId!==intent.removeId),dependencies:asset.definition.graph.dependencies.filter(e=>e.edgeId!==intent.removeId)}}}):connectCanvasNodes(asset,intent.fromId,intent.toId,intent.kind,intent.outputPort,intent.inputPort,task.project.assetSnapshots);
  return {taskId:task.taskId,reply:{kind:'prepared',plan:Plan.parse(prepareCanvasEdit(task.project,task.modelRef,edited,task.library))}};
 }catch(e){return {taskId:task.taskId,reply:{kind:'error',message:e instanceof Error?e.message:'模型结构准备失败'}};}
}
if(typeof self!=='undefined'&&typeof document==='undefined')self.onmessage=(event:MessageEvent<CanvasEditTask>)=>self.postMessage(evaluateCanvasEditTask(event.data));
