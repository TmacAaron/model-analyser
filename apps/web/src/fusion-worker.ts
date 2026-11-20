import { z } from 'zod';
import { FusionGroup,NodeId,type Scenario,type AssetDocument,type ResolvedGraph } from '@model-analyser/contracts';
import { instantiateModel,prepareFusionPreset } from '@model-analyser/core';
import { canvasFusionCandidates } from './canvas-graph.js';
export type FusionTask={scenario:Scenario;assets:AssetDocument[]}&({kind:'candidates';resolved:ResolvedGraph;selections:string[][]}|{kind:'validate'}|{kind:'preset';presetKey:string});
export const FusionReply=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('candidates'),candidates:z.array(z.strictObject({nodeIds:z.array(NodeId),names:z.array(z.string()),description:z.string()}))}),
  z.strictObject({kind:z.literal('validated')}),z.strictObject({kind:z.literal('preset'),group:FusionGroup}),z.strictObject({kind:z.literal('error'),message:z.string()})
]);
export type FusionReply=z.infer<typeof FusionReply>;
export function evaluateFusionTask(request:FusionTask):FusionReply{
  try{
    if(request.kind==='preset')return {kind:'preset',group:prepareFusionPreset(request.scenario,request.assets,request.presetKey)};
    if(request.kind==='validate'){const attempt=instantiateModel(request.scenario,request.assets);return attempt.status==='available'?{kind:'validated'}:{kind:'error',message:attempt.diagnostics.map(d=>d.code+' · '+d.message).join('; ')};}
    const seen=new Set<string>(),candidates=request.selections.flatMap(ids=>canvasFusionCandidates(request.resolved,request.scenario,request.assets,ids)).filter(c=>{const key=c.nodeIds.join('\0');if(seen.has(key))return false;seen.add(key);return true;});return FusionReply.parse({kind:'candidates',candidates});
  }catch(e){return {kind:'error',message:e instanceof Error?e.message:'融合检查失败'};}
}
// The handler is installed only inside a dedicated worker, so domain tests can import the evaluator.
if(typeof self!=='undefined'&&typeof document==='undefined')self.onmessage=(event:MessageEvent<FusionTask>)=>self.postMessage(evaluateFusionTask(event.data));
