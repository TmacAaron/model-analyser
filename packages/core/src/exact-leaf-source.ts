import {resolveLeafCostSource} from './leaf-cost-context.js';
import {explainLeafCostSource,verifyLeafCostSourceReport} from './leaf-cost-source.js';
import {explainLeafTimingSource,verifyLeafTimingSourceReport} from './leaf-timing-source.js';
import {LeafCostSourceRequest} from './leaf-cost-context.js';
import {parameterBindingGraph} from './parameter-binding-graph.js';
import {stableStringify} from './input-hash.js';
import {z} from 'zod';
import {replayStorageLeafSource,replayOverrideLeafSource} from './exact-storage-source.js';
export const BoundLeafSourceRequest=LeafCostSourceRequest.extend({proofVersion:z.literal(2).default(2),bindingBudget:z.number().int().min(1).max(256).default(256)});
export async function replayBoundLeafSource(input:unknown){
 const request=BoundLeafSourceRequest.parse(input),{proofVersion,bindingBudget,...base}=request;void proofVersion;
 const context=await resolveLeafCostSource(base,true),parameterBindings=parameterBindingGraph(context.call,context.r.assets,bindingBudget);
 const leaf=context.r.selector.field==='seconds'&&context.call.cost.timing.kind==='roofline_bound'?explainLeafTimingSource(context):explainLeafCostSource(context);
 return leaf.kind==='leaf_timing_source'?{...leaf,schemaVersion:2 as const,coverage:{...leaf.coverage,parameterBindingDagComplete:parameterBindings.complete},parameterBindings,request}:{...leaf,schemaVersion:2 as const,parameterBindings,request};
}
export async function replayExactLeafSource(input:unknown){
 const version=input&&typeof input==='object'&&'proofVersion'in input?input.proofVersion:undefined;
 if(version===4)return replayOverrideLeafSource(input);
 if(version===3)return replayStorageLeafSource(input);
 return replayBoundLeafSource(input);
}
export type ExactLeafSourceReport=Awaited<ReturnType<typeof replayExactLeafSource>>;
export async function verifyExactLeafSourceReport(input:unknown){
 if(input&&typeof input==='object'&&'schemaVersion'in input&&input.schemaVersion===4){if(!('request'in input))throw Error('成本覆盖来源缺少固定请求');const actual=await replayOverrideLeafSource(input.request);if(stableStringify(actual)!==stableStringify(input))throw Error('成本覆盖来源与固定输入复算不同');return actual;}
 if(input&&typeof input==='object'&&'schemaVersion'in input&&input.schemaVersion===3){if(!('request'in input))throw Error('量化分配来源缺少固定请求');const actual=await replayStorageLeafSource(input.request);if(stableStringify(actual)!==stableStringify(input))throw Error('分配来源报告与固定输入复算不同，未接受修改的规则或存储身份');return actual;}
 if(input&&typeof input==='object'&&'schemaVersion'in input&&input.schemaVersion===2){if(!('request'in input)||!('kind'in input)||!['leaf_cost_source','leaf_timing_source'].includes(String(input.kind)))throw Error('不支持的参数绑定来源报告格式');const actual=await replayBoundLeafSource(input.request);if(stableStringify(actual)!==stableStringify(input))throw Error('参数来源报告与固定输入复算不同，未接受修改的字段或覆盖身份');return actual;}
 return input&&typeof input==='object'&&'kind'in input&&input.kind==='leaf_timing_source'?verifyLeafTimingSourceReport(input):verifyLeafCostSourceReport(input);
}
