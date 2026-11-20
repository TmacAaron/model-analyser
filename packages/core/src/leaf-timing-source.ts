import {CostDefinition,StorageId} from '@model-analyser/contracts';
import {ENGINE_VERSION} from './analyze.js';
import {stableStringify} from './input-hash.js';
import {explainValue,evaluateValue} from './formula.js';
import {resolveLeafCostSource,type LeafCostContext} from './leaf-cost-context.js';
import {explainLeafCostSource} from './leaf-cost-source.js';
import {observeCostTiming} from './timing-observer.js';
export async function replayLeafTimingSource(input:unknown){return explainLeafTimingSource(await resolveLeafCostSource(input));}
export function explainLeafTimingSource(context:LeafCostContext){
 const {r,node,call,expanded,metric}=context;
 if(r.selector.field!=='seconds'||r.selector.computeClass||call.cost.timing.kind!=='roofline_bound')throw Error('请选择实际叶节点的Roofline耗时');
 const boundNode=expanded.resolved.graph.nodes.find(n=>n.nodeId===r.selector.nodeId);if(boundNode?.body.kind!=='opaque')throw Error('未找到实际绑定的叶成本');const boundCost=boundNode.body.cost;
 if(stableStringify(call.cost.compute.map(c=>c.segmentId))!==stableStringify(boundCost.compute.map(c=>c.segmentId)))throw Error('原始计算段的实际顺序已变化');
 const device=r.scenario.deviceTopology.devices[0];if(!device||r.scenario.deviceTopology.devices.length!==1||r.selector.scope.deviceIds.length!==1||r.selector.scope.deviceIds[0]!==device.deviceId)throw Error('此耗时来源需要实际单设备绑定');const hardwareMatches=r.assets.filter(a=>a.assetId===device.hardware.assetId&&a.revision===device.hardware.revision),hardwareAsset=hardwareMatches[0];if(hardwareMatches.length!==1||hardwareAsset?.definition.kind!=='hardware')throw Error('实际设备的固定硬件定义缺失或不唯一');
 const segments=new Map<string,{value:(typeof boundCost.compute)[number];count:number}>();for(const value of boundCost.compute)segments.set(value.segmentId,{value,count:(segments.get(value.segmentId)?.count??0)+1});
 const works=call.cost.compute.map(source=>{const match=segments.get(source.segmentId),bound=match?.value;if(match?.count!==1||!bound||stableStringify(source.computeClass)!==stableStringify(bound.computeClass))throw Error('实际计算段无法按ID与完整计算类别唯一定位');const quantity=evaluateValue(bound.executedOperations,{},r.assets),declared=evaluateValue(source.executedOperations,call.symbols,r.assets);if(quantity.unit!=='operation'||!Number.isFinite(quantity.value)||quantity.value<0||stableStringify(quantity)!==stableStringify(declared))throw Error('原表达式与实际绑定计算段的数量不同');return {source,quantity};});
 // Analysis groups displayed work by class only AFTER computing each segment's
 // duration. Reconstructing duration from the grouped work changes IEEE results.
 const byClass=new Map<string,number>();for(const {source,quantity}of works){const key=stableStringify(source.computeClass);byClass.set(key,(byClass.get(key)??0)+quantity.value);}if(byClass.size!==node.cost.compute.length)throw Error('实际显示指标的计算类别集合已变化');
 for(const row of node.cost.compute){const value=byClass.get(stableStringify(row.computeClass));if(value===undefined||row.executedOperations.status!=='available'||value!==row.executedOperations.quantity.value)throw Error('原显示指标的类别求和与实际计算段不同');}

 if(node.cost.hbmBytes.status!=='available')throw Error('原HBM工作量不可用，保留诊断');
 const timingInput=CostDefinition.parse({compute:works.map(({source,quantity})=>({segmentId:source.segmentId,computeClass:source.computeClass,usefulOperations:{kind:'literal',quantity:{value:0,unit:'operation'}},executedOperations:{kind:'literal',quantity}})),memoryAccess:[{accessId:'verified-actual-hbm',storageId:StorageId.parse('$verified-hbm'),mode:'read',logicalBytes:{kind:'literal',quantity:node.cost.hbmBytes.quantity},hbmEstimate:{kind:'factor',value:1}}],temporaryStorageIds:[],timing:call.cost.timing});
 const observed=observeCostTiming(timingInput,node.cost.scope,{symbols:{},assets:r.assets},hardwareAsset.definition.hardware);
 if(observed.evaluation.cost.seconds.status!=='available'||observed.evaluation.cost.seconds.quantity.value!==metric.quantity.value)throw Error('记录的耗时运算与原指标不同');
 const pageSize=20,start=r.page*pageSize;
 let hbmSource:Omit<ReturnType<typeof explainLeafCostSource>,'request'>|undefined,hbmBoundaryReason:string|undefined,hbmCount=0;
 try{
  const hbmContext={...context,compute:false,metric:node.cost.hbmBytes,r:{...r,selector:{...r.selector,field:'hbmBytes' as const},metric:node.cost.hbmBytes,page:0}};
  const first=explainLeafCostSource(hbmContext);hbmCount=first.componentCount;
  if(r.page===0||start<hbmCount){const full=r.page===0?first:explainLeafCostSource({...hbmContext,r:{...hbmContext.r,page:r.page}});const {request,...summary}=full;void request;hbmSource=summary;}
 }catch(e){hbmBoundaryReason=e instanceof Error?e.message:'HBM上游来源尚未完整采集';}
 const componentCount=Math.max(works.length,hbmCount,observed.dag.nodes.length,observed.dag.guards.length);
 if(r.page>0&&start>=componentCount)throw Error('请求的耗时来源页不存在，未回退第一页');
 const workExpressions=works.slice(start,start+pageSize).map(({source,quantity})=>{const proof=explainValue(source.executedOperations,call.symbols,r.assets);if(stableStringify(proof.quantity)!==stableStringify(quantity))throw Error('原计算段表达式与绑定数量不同');return {segmentId:source.segmentId,computeClass:source.computeClass,field:'compute['+JSON.stringify(source.segmentId)+'].executedOperations',...proof};});
 const completeSupportedExpressions=r.page===0&&workExpressions.length===works.length&&!workExpressions.some(w=>w.truncated)&&!!hbmSource?.complete;
 return {kind:'leaf_timing_source' as const,schemaVersion:1 as const,engineVersion:ENGINE_VERSION,inputHash:r.inputHash,selector:r.selector,asset:call.asset,hardware:device.hardware,metric,timing:call.cost.timing,dag:observed.dag,workExpressions,...(hbmSource?{hbmSource}:{}),...(hbmBoundaryReason?{hbmBoundaryReason}:{}),page:r.page,pageSize,componentCount,workExpressionCount:works.length,hbmExpressionCount:hbmCount,coverage:{completeTimingTransform:observed.dag.completeTiming,completeSupportedExpressions,parameterBindingDagComplete:false as const,distributedFusionAndOverrideTransformsComplete:false as const},request:r};
}
export type LeafTimingSourceReport=Awaited<ReturnType<typeof replayLeafTimingSource>>;
export async function verifyLeafTimingSourceReport(input:unknown){const raw=input&&typeof input==='object'?input as Record<string,unknown>:undefined;if(raw?.['kind']!=='leaf_timing_source'||raw['schemaVersion']!==1)throw Error('不支持的耗时来源报告格式');const actual=await replayLeafTimingSource(raw['request']);if(stableStringify(actual)!==stableStringify(input))throw Error('耗时来源报告与固定输入复算不同，未接受被修改的显示证据');return actual;}
