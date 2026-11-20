import {z} from 'zod';
import {LeafCostSourceRequest} from './leaf-cost-context.js';
import {explainLeafCostSource} from './leaf-cost-source.js';
import {explainLeafTimingSource} from './leaf-timing-source.js';
import {parameterBindingGraph} from './parameter-binding-graph.js';
import {resolveStorageSourceContext,explainStorageAccessSource} from './storage-access-source.js';

export const StorageLeafSourceRequest=LeafCostSourceRequest.extend({proofVersion:z.literal(3),bindingBudget:z.number().int().min(1).max(256).default(256)});
/** Version3 keeps the ordinary/legacy report protocol independently replayable. */
export async function replayStorageLeafSource(input:unknown){
 const request=StorageLeafSourceRequest.parse(input),{proofVersion,bindingBudget,...base}=request;void proofVersion;
 const {context,capture}=await resolveStorageSourceContext(base),roofline=context.r.selector.field==='seconds'&&context.call.cost.timing.kind==='roofline_bound',bytes=['hbmBytes','logicalReadBytes','logicalWriteBytes'].includes(context.r.selector.field);
 const upstream=roofline||bytes?explainStorageAccessSource(context,capture):undefined,parameterBindings=parameterBindingGraph(context.call,context.r.assets,bindingBudget,upstream?.parameterRoots??[]);
 const source=upstream?(()=>{const {parameterRoots,...report}=upstream;void parameterRoots;return report;})():undefined;
 if(bytes&&source){if(request.page>0&&request.page*20>=source.componentCount)throw Error('请求的访问来源页不存在');return {schemaVersion:3 as const,kind:'leaf_storage_source' as const,inputHash:request.inputHash,engineVersion:request.engineVersion,selector:request.selector,asset:context.call.asset,metric:context.metric,page:request.page,pageSize:20,componentCount:source.componentCount,complete:source.complete,storageAccessSource:source,parameterBindings,request};}
 if(roofline&&source){
  const first=explainLeafTimingSource({...context,r:{...context.r,page:0}}),start=request.page*20,componentCount=Math.max(first.componentCount,source.componentCount);
  if(request.page>0&&start>=componentCount)throw Error('请求的耗时来源页不存在');
  const paged=request.page===0?first:start<first.componentCount?explainLeafTimingSource(context):{...first,page:request.page,workExpressions:[]};
  const {hbmSource,hbmBoundaryReason,...timing}=paged;void hbmSource;void hbmBoundaryReason;
  return {...timing,schemaVersion:3 as const,storageAccessSource:source,hbmExpressionCount:source.componentCount,componentCount,coverage:{...timing.coverage,parameterBindingDagComplete:parameterBindings.complete,completeSupportedExpressions:request.page===0&&timing.workExpressions.length===timing.workExpressionCount&&!timing.workExpressions.some(w=>w.truncated)&&source.complete},parameterBindings,request};
 }
 return {...explainLeafCostSource(context),schemaVersion:3 as const,parameterBindings,request};
}
export type StorageLeafSourceReport=Awaited<ReturnType<typeof replayStorageLeafSource>>;
