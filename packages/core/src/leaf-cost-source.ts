import {z} from 'zod';
import type {ValueExpr,Quantity} from '@model-analyser/contracts';
import {explainValue} from './formula.js';
import {canonical} from '../../contracts/src/validation.js';
import {stableStringify} from './input-hash.js';
import {allocateStorage,type AllocationObservation} from './storage.js';
import {LeafCostSourceRequest,resolveLeafCostSource,type LeafCostContext} from './leaf-cost-context.js';
export {LeafCostSelector,LeafCostSourceRequest} from './leaf-cost-context.js';
type Component={field:string;expression:ValueExpr;factor?:number;storageId?:string};

export async function replayLeafCostSource(input:unknown){return explainLeafCostSource(await resolveLeafCostSource(input));}
export function explainLeafCostSource({r,metric,call,compute}:LeafCostContext){
  const components:Component[]=[];
  if(compute){for(const c of call.cost.compute)if(canonical(c.computeClass)===canonical(r.selector.computeClass))components.push({field:'compute['+JSON.stringify(c.segmentId)+'].'+r.selector.field,expression:c[r.selector.field as 'usefulOperations'|'executedOperations']});}
  else if(r.selector.field==='seconds'){
    const timing=call.cost.timing;if(timing.kind==='roofline_bound')throw Error('Roofline时间含能力匹配、效率和max变换；该精确链仍待采集，不使用固定公式列表替代。');
    components.push({field:'timing.'+(timing.kind==='fixed'?'fixedSeconds':'seconds'),expression:timing.kind==='fixed'?{kind:'literal',quantity:{value:timing.seconds,unit:'second'}}:timing.seconds});
  }else for(const a of call.cost.memoryAccess){
    if(r.selector.field==='logicalReadBytes'&&a.mode!=='read'||r.selector.field==='logicalWriteBytes'&&a.mode!=='write')continue;
    const field='memoryAccess['+JSON.stringify(a.accessId)+']';
    if(r.selector.field==='hbmBytes'&&a.hbmEstimate?.kind==='bytes'){components.push({field:field+'.hbmEstimate.value',expression:a.hbmEstimate.value});continue;}
    if(r.selector.field==='hbmBytes'&&!a.hbmEstimate)throw Error('原访问没有HBM估计。');
    components.push({field:field+'.logicalBytes'+(a.logicalBytes.kind==='storage_allocation'?'.passes':''),expression:a.logicalBytes.kind==='storage_allocation'?a.logicalBytes.passes:a.logicalBytes,...(a.logicalBytes.kind==='storage_allocation'?{storageId:a.storageId}:{}),...(r.selector.field==='hbmBytes'&&a.hbmEstimate?.kind==='factor'?{factor:a.hbmEstimate.value}:{})});
  }
  function storageProof(localId:string){
    if(r.scenario.quantizationOverrides.length||r.scenario.numericOverrides.some(o=>o.target.kind==='storage'&&o.field==='memory_bytes'))throw Error('当前配置包含场景量化／分配覆盖；本来源尚未采集这些变换，未用覆盖前表达式代替。');
    let id=call?.storageRefs.find(s=>s.localStorageId===localId)?.storageId;const resolvedStorageId=id,aliases:string[]=[];
    while(id){if(aliases.includes(id)||aliases.length>=64)throw Error('存储来源alias链无效。');const entry=call?.storages.find(s=>s.storage.storageId===id);if(!entry)throw Error('实际存储来源缺失，未从同字节数或其他调用补填。');aliases.push(id);if(entry.storage.allocation.kind==='alias'){id=entry.storage.allocation.targetStorageId;continue;}
      const allocation=entry.storage.allocation,fields:{field:string;expression:ValueExpr}[]=allocation.kind==='bytes'?[{field:'allocation.value',expression:allocation.value}]:[...allocation.shape.map(a=>({field:'allocation.shape['+JSON.stringify(a.axisId)+']',expression:a.size})),...(allocation.quantization?.auxiliaries.flatMap(a=>a.count.kind==='formula'?[{field:'allocation.auxiliary['+JSON.stringify(a.name)+'].count',expression:a.count.value}]:[])??[])];
      if(fields.length>64)throw Error('单次存储表达式超过64项记录预算，需要更细分页；未声称完整链。');
      const proofs=fields.map(f=>({...explainValue(f.expression,entry.symbols,r.assets),field:f.field})),events:AllocationObservation[]=[];let truncated=false;
      const evaluated=allocateStorage(entry.storage.storageId,[entry.storage],{symbols:entry.symbols,assets:r.assets},event=>{if(events.length<256)events.push(event);else truncated=true;});
      if(evaluated.totalBytes.status!=='available')throw Error('原实际存储分配不能完整复核。');
      return {localStorageId:localId,resolvedStorageId,aliases,asset:entry.asset,storage:entry.storage,proofs,events,result:evaluated,truncated:truncated||proofs.some(p=>p.truncated),bytes:evaluated.totalBytes.quantity.value};
    }throw Error('原访问的存储身份缺失。');
  }
  const pageSize=20,start=r.page*pageSize;if(r.page>0&&start>=components.length)throw Error('请求的表达式页不存在，未回退第一页。');
  const proofs=components.slice(start,start+pageSize).map(c=>{
    const evaluated=explainValue(c.expression,call.symbols,r.assets),storage=c.storageId&&evaluated.quantity.value!==0?storageProof(c.storageId):undefined,value=evaluated.quantity.value*(storage?.bytes??1)*(c.factor??1);
    if(evaluated.quantity.unit!==(c.storageId?'count':metric.quantity.unit)||!Number.isFinite(value)||value<0)throw Error('表达式单位或数值与原字段不符。');
    return {...evaluated,truncated:evaluated.truncated||!!storage?.truncated,field:c.field,operation:c.factor===undefined&&!c.storageId?'expression' as const:'multiply' as const,...(c.factor===undefined?{}:{factor:c.factor}),...(storage?{storage}:{}),...(c.storageId&&evaluated.quantity.value===0?{skippedStorage:true}:{}),contribution:{value,unit:metric.quantity.unit} as Quantity};
  });
  const items=proofs;
  const complete=start===0&&components.length<=pageSize&&!items.some(p=>p.truncated);
  if(complete&&items.reduce((n,p)=>n+p.contribution.value,0)!==metric.quantity.value)throw Error('实际字段求和不等于原指标，未声明完整链。');
  const used=new Set<string>();function visit(p:(typeof items)[number]['proof']){if(p.symbol)used.add(p.symbol);for(const b of p.bindings??[])if(b.proof)visit(b.proof);}for(const p of items)visit(p.proof);
  return {schemaVersion:1 as const,kind:'leaf_cost_source' as const,inputHash:r.inputHash,engineVersion:r.engineVersion,selector:r.selector,asset:call.asset,metric,operation:'sum' as const,componentCount:components.length,page:r.page,pageSize,complete,items,symbols:[...used].map(name=>({name,quantity:call.symbols[name]})),request:r};
}
export type LeafCostSourceReport=Awaited<ReturnType<typeof replayLeafCostSource>>;
/** Offline verification checks every displayed field as well as the embedded fixed request. */
export async function verifyLeafCostSourceReport(input:unknown){
  const saved=z.object({schemaVersion:z.literal(1),kind:z.literal('leaf_cost_source'),request:LeafCostSourceRequest}).passthrough().parse(input),actual=await replayLeafCostSource(saved.request);
  if(stableStringify(actual)!==stableStringify(saved))throw Error('保存的来源报告与固定输入复算不一致，未接受被修改的显示证据。');
  return actual;
}
