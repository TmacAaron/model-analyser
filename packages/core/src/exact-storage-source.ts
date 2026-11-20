import {z} from 'zod';
import {LeafCostSourceRequest} from './leaf-cost-context.js';
import {explainLeafCostSource} from './leaf-cost-source.js';
import {explainLeafTimingSource} from './leaf-timing-source.js';
import {parameterBindingGraph} from './parameter-binding-graph.js';
import {resolveStorageSourceContext,explainStorageAccessSource} from './storage-access-source.js';
import {applyNodeCostOverride,type NodeCostOverrideObservation} from './node-cost-overrides.js';
import type {CostDefinition} from '@model-analyser/contracts';

export const StorageLeafSourceRequest=LeafCostSourceRequest.extend({proofVersion:z.literal(3),bindingBudget:z.number().int().min(1).max(256).default(256)});
const OverrideLeafSourceRequest=StorageLeafSourceRequest.extend({proofVersion:z.literal(4)});
/** Version3 keeps the ordinary/legacy report protocol independently replayable. */
export async function replayStorageLeafSource(input:unknown){
 const request=StorageLeafSourceRequest.parse(input),{proofVersion,bindingBudget,...base}=request;void proofVersion;
 return {...explainStorageLeaf(await resolveStorageSourceContext(base),bindingBudget),schemaVersion:3 as const,request};
}

export async function replayOverrideLeafSource(input:unknown){
 const request=OverrideLeafSourceRequest.parse(input);
 const {proofVersion,bindingBudget,...base}=request;void proofVersion;
 const resolved=await resolveStorageSourceContext(base,true),{context}=resolved;
 const overrides=request.scenario.numericOverrides.flatMap((override,overrideIndex)=>override.target.kind==='node'&&override.target.nodeId===request.selector.nodeId&&override.field!=='parameter'?[{override,overrideIndex}]:[]);
 const timingOverrides:Extract<NodeCostOverrideObservation,{kind:'timing'}>[]=[];
 let effectiveTiming:CostDefinition['timing']|undefined;
 if(request.selector.field==='seconds'){
  const node=context.expanded.resolved.graph.nodes.find(n=>n.nodeId===request.selector.nodeId);
  if(node?.body.kind!=='opaque')throw Error('实际成本定义缺失');
  const cost=structuredClone(node.body.cost);
  for(const {override,overrideIndex} of overrides){
   if(override.field==='traffic_bytes')continue;
   applyNodeCostOverride(cost,override,overrideIndex,{symbols:{},assets:context.r.assets},event=>{if(event.kind==='timing')timingOverrides.push(event);});
  }
  if(timingOverrides.length)effectiveTiming=cost.timing;
 }
 const traffic=overrides.find(o=>o.override.field==='traffic_bytes');
 return {...explainStorageLeaf(resolved,bindingBudget,effectiveTiming,traffic),schemaVersion:4 as const,timingOverrides,request};
}

function explainStorageLeaf({context,capture}:Awaited<ReturnType<typeof resolveStorageSourceContext>>,bindingBudget:number,effectiveTiming?:CostDefinition['timing'],traffic?:Parameters<typeof explainStorageAccessSource>[2]){
 const request=context.r,timing=effectiveTiming??context.call.cost.timing;
 const roofline=request.selector.field==='seconds'&&timing.kind==='roofline_bound',bytes=['hbmBytes','logicalReadBytes','logicalWriteBytes'].includes(request.selector.field);
 const upstream=roofline||bytes?explainStorageAccessSource(context,capture,traffic):undefined,parameterBindings=parameterBindingGraph(context.call,request.assets,bindingBudget,upstream?.parameterRoots??[]);
 const source=upstream?(()=>{const {parameterRoots,...report}=upstream;void parameterRoots;return report;})():undefined;
 if(bytes&&source){if(request.page>0&&request.page*20>=source.componentCount)throw Error('请求的访问来源页不存在');return {schemaVersion:3 as const,kind:'leaf_storage_source' as const,inputHash:request.inputHash,engineVersion:request.engineVersion,selector:request.selector,asset:context.call.asset,metric:context.metric,page:request.page,pageSize:20,componentCount:source.componentCount,complete:source.complete,storageAccessSource:source,parameterBindings,request};}
 if(roofline&&source&&timing.kind==='roofline_bound'){
  const first=explainLeafTimingSource({...context,r:{...context.r,page:0}},timing),start=request.page*20,componentCount=Math.max(first.componentCount,source.componentCount);
  if(request.page>0&&start>=componentCount)throw Error('请求的耗时来源页不存在');
  const paged=request.page===0?first:start<first.componentCount?explainLeafTimingSource(context,timing):{...first,page:request.page,workExpressions:[]};
  const {hbmSource,hbmBoundaryReason,...timingProof}=paged;void hbmSource;void hbmBoundaryReason;
  return {...timingProof,storageAccessSource:source,hbmExpressionCount:source.componentCount,componentCount,coverage:{...timingProof.coverage,parameterBindingDagComplete:parameterBindings.complete,completeSupportedExpressions:request.page===0&&timingProof.workExpressions.length===timingProof.workExpressionCount&&!timingProof.workExpressions.some(w=>w.truncated)&&source.complete},parameterBindings,request};
 }
 if(effectiveTiming&&effectiveTiming.kind==='fixed'&&effectiveTiming.seconds!==context.metric.quantity.value)throw Error('固定耗时覆盖与原指标不同');
 const leaf=explainLeafCostSource(effectiveTiming?{...context,call:{...context.call,cost:{...context.call.cost,timing:effectiveTiming}}}:context);
 return {...leaf,parameterBindings,request};
}
export type StorageLeafSourceReport=Awaited<ReturnType<typeof replayStorageLeafSource>>;
