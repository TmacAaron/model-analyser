import {StorageId,type Quantity,type StorageSpec,type CostDefinition,type AssetDocument} from '@model-analyser/contracts';
import {jsonBytes} from '../../contracts/src/json-size.js';
import {LeafCostSourceRequest,resolveLeafCostSource,type LeafCostContext} from './leaf-cost-context.js';
import {instantiateModel,type InstantiatedCostCapture} from './instantiate.js';
import {assetParameterFrameId,workloadParameterFrameId,type ParameterCaptureTrace} from './parameter-observation.js';
import type {AdditionalParameterRoot} from './parameter-binding-graph.js';
import {explainValue,evaluateValue,type ValueEvaluationProof} from './formula.js';
import {allocateStorage,type AllocationObservation} from './storage.js';
import {memoryAccessBytes} from './cost.js';
import {applyStorageAllocationOverrides} from './storage-allocation-overrides.js';
import type {QuantizationObservation,StorageOverrideObservation,QuantizationObserver} from './quantization-observation.js';
import {stableStringify} from './input-hash.js';
import {applyNodeCostOverride,type NodeCostOverrideObservation} from './node-cost-overrides.js';

type Access=CostDefinition['memoryAccess'][number];
const pageSize=20;
const selectedAccesses=(call:InstantiatedCostCapture,field:string)=>call.cost.memoryAccess.filter(a=>field!=='logicalReadBytes'||a.mode==='read').filter(a=>field!=='logicalWriteBytes'||a.mode==='write');
const storageField=(field:string)=>['hbmBytes','logicalReadBytes','logicalWriteBytes','seconds','logicalAccessBytes'].includes(field);
function canonical<T extends {storage:StorageSpec}>(id:string,storages:readonly T[]){const aliases:string[]=[];while(true){if(aliases.includes(id)||aliases.length>=64)throw Error('存储来源alias链无效');aliases.push(id);const entry=storages.find(s=>s.storage.storageId===id);if(!entry)throw Error('实际规范存储声明未采集');if(entry.storage.allocation.kind!=='alias')return {id,aliases,entry};id=entry.storage.allocation.targetStorageId;}}
function collector(field:string,page:number,assets:AssetDocument[]){
 const ids=new Set<string>(),events:QuantizationObservation[]=[];let truncated=false;
 const quantization:QuantizationObserver={storageIds:ids,record:event=>{events.push(event);},truncated:()=>{truncated=true;}};
 function declared(call:InstantiatedCostCapture){if(!storageField(field)||field==='seconds'&&call.cost.timing.kind!=='roofline_bound')return;for(const a of selectedAccesses(call,field).slice(page*pageSize,(page+1)*pageSize)){
  if(a.logicalBytes.kind!=='storage_allocation'||(field==='hbmBytes'||field==='seconds')&&a.hbmEstimate?.kind==='bytes')continue;
  const passes=evaluateValue(a.logicalBytes.passes,call.symbols,assets);if(passes.value===0)continue;const id=call.storageRefs.find(r=>r.localStorageId===a.storageId)?.storageId;if(id)ids.add(canonical(id,call.storages).id);
 }}
 return {ids,events,quantization,declared,get truncated(){return truncated;}};
}
/** Observe only this page's allocations, and capture actual later shared-consumer frames. */
export async function resolveStorageSourceContext(input:unknown,allowNodeCostOverrides=false){
 // The validated resolver owns hashes, actual steps, metric identity and all legacy guards.
 const request=LeafCostSourceRequest.parse(input),traces:ParameterCaptureTrace[]=[];
 const traffic=allowNodeCostOverrides&&request.scenario.numericOverrides.some(o=>o.target.kind==='node'&&o.target.nodeId===request.selector.nodeId&&o.field==='traffic_bytes');
 const field=traffic&&storageField(request.selector.field)?'logicalAccessBytes':request.selector.field;
 const capture=collector(field,request.page,request.assets);
 let context=await resolveLeafCostSource(input,true,{quantization:capture.quantization,declared:capture.declared,bindingTraceReady:t=>{traces.push(t);},...(allowNodeCostOverrides?{allowNodeCostOverrides:true}:{})}),active=capture;
 const needed=new Set(capture.events.flatMap(e=>'nodeId'in e?[e.nodeId]:[])),trace=traces[0];
 const missing=[...needed].filter(id=>!trace?.frames.some(f=>f.id===assetParameterFrameId(id)));
 if(missing.length){const next=collector(field,context.r.page,context.r.assets),calls:InstantiatedCostCapture[]=[],final:ParameterCaptureTrace[]=[];
  const expanded=instantiateModel(context.r.scenario,context.r.assets,undefined,context.r.stepContext,{nodeId:context.r.selector.nodeId,bindings:true,bindingNodes:missing,cost:c=>{calls.push(c);next.declared(c);},bindingTraceReady:t=>{final.push(t);},quantization:next.quantization});
  if(stableStringify(expanded)!==stableStringify(context.expanded)||calls.length!==1||final.length!==1)throw Error('扩展来源观察改变了原实际实例化结果');
  const call=calls[0],completed=final[0];if(!call||!completed)throw Error('完整调用来源未采集');call.bindingContext={...call.bindingContext,trace:completed};context={...context,call};active=next;
 }else if(trace)context.call.bindingContext={...context.call.bindingContext,trace};
 return {context,capture:active};
}
type Capture=Awaited<ReturnType<typeof resolveStorageSourceContext>>['capture'];
type Expression=ReturnType<typeof explainValue>&{field:string;frameId?:string};
function reads(proof:ValueEvaluationProof,result=new Map<string,Quantity>()){if(proof.kind==='symbol'&&proof.symbol&&proof.quantity)result.set(proof.symbol,proof.quantity);for(const binding of proof.bindings??[])if(binding.proof)reads(binding.proof,result);return result;}

export function explainStorageAccessSource(context:LeafCostContext,capture:Capture,trafficOverride?:{overrideIndex:number;override:LeafCostContext['r']['scenario']['numericOverrides'][number]}){
 const {r,call,node,expanded}=context,field=r.selector.field==='seconds'?'hbmBytes':r.selector.field;
 if(!['hbmBytes','logicalReadBytes','logicalWriteBytes'].includes(field))throw Error('请选择实际访问字节字段');
 if(expanded.resolved.fusionApplications.some(f=>f.memberNodeIds.includes(r.selector.nodeId)))throw Error('当前叶涉及融合变换，尚未记录其实际访问链');
 const expected=field==='hbmBytes'?node.cost.hbmBytes:field==='logicalReadBytes'?node.cost.logicalReadBytes:node.cost.logicalWriteBytes;if(expected.status!=='available')throw Error('原访问指标不可用');
 const storages=structuredClone(expanded.resolved.graph.storages),overrides:StorageOverrideObservation[]=[];
 applyStorageAllocationOverrides(storages,r.scenario.numericOverrides,e=>{if(capture.ids.has(e.storageId))overrides.push(e);});
 const storageBytes=new Map<StorageId,ReturnType<typeof allocateStorage>['totalBytes']>();
 const boundNode=expanded.resolved.graph.nodes.find(n=>n.nodeId===r.selector.nodeId);if(boundNode?.body.kind!=='opaque')throw Error('实际绑定叶成本缺失');const bound=boundNode.body.cost.memoryAccess;
 if(stableStringify(call.cost.memoryAccess.map(a=>a.accessId))!==stableStringify(bound.map(a=>a.accessId)))throw Error('原访问ID或顺序已变化');
 const accessBindings=new Map(call.cost.memoryAccess.map((a,index)=>[a,bound[index]]));
 const accessContext={symbols:{},assets:r.assets,storageBytes};
 function prepareAllocation(access:Access){
  if(access.logicalBytes.kind==='storage_allocation'&&evaluateValue(access.logicalBytes.passes,{},r.assets).value!==0&&!storageBytes.has(access.storageId))storageBytes.set(access.storageId,allocateStorage(access.storageId,storages,accessContext).totalBytes);
 }
 const selected=new Set(selectedAccesses(call,field));
 const effectiveCost=trafficOverride?structuredClone(boundNode.body.cost):undefined;
 const observations:NodeCostOverrideObservation[]=[];
 if(trafficOverride&&effectiveCost){
  for(const access of bound)prepareAllocation(access);
  applyNodeCostOverride(effectiveCost,trafficOverride.override,trafficOverride.overrideIndex,accessContext,o=>observations.push(o));
 }
 const traffic=observations.find(o=>o.kind==='traffic');
 const source=traffic?call.cost.memoryAccess:[...selected],roots:AdditionalParameterRoot[]=[],start=r.page*pageSize;let sum=0,previousSum=0,bytes=0;
 const contributions=source.map((a,index)=>{
  const original=accessBindings.get(a),effective=effectiveCost?.memoryAccess[index]??original;
  if(!original||!effective)throw Error('实际绑定访问缺失');
  const relevant=selected.has(a),independent=field==='hbmBytes'&&effective.hbmEstimate?.kind==='bytes';
  let value=0;
  if(relevant){
   if(field==='hbmBytes'&&effective.hbmEstimate?.kind==='bytes')value=evaluateValue(effective.hbmEstimate.value,{},r.assets).value;
   else{prepareAllocation(effective);value=memoryAccessBytes(effective,accessContext);if(field==='hbmBytes'){if(effective.hbmEstimate?.kind!=='factor')throw Error('原访问没有HBM估计');value=value*effective.hbmEstimate.value;}}
  }
  if(!Number.isFinite(value)||value<0)throw Error('访问字节不可复核');
  const left=sum;sum+=value;
  if(!traffic)return {value,left,total:sum};
  const before=memoryAccessBytes(original,accessContext),after=memoryAccessBytes(effective,accessContext),previous=previousSum;
  previousSum+=before;
  const fraction=before/traffic.previousTotal;
  if(after!==fraction*traffic.override.value.value)throw Error('覆盖后的访问字节与实际分摊顺序不同');
  return {value,left,total:sum,traffic:{relevant,independent,before,after,fraction,previousSum:{left:previous,right:before,value:previousSum}}};
 });
 if(traffic&&previousSum!==traffic.previousTotal)throw Error('流量覆盖的原始分母与实际顺序求和不同');
 if(sum!==expected.quantity.value)throw Error('实际分配与原顺序访问求和不等于原指标');
 function expression(value:Parameters<typeof explainValue>[0],symbols:Record<string,Quantity>,field:string,frameId?:string):Expression{return {...explainValue(value,symbols,r.assets),field,...(frameId?{frameId}:{})};}
 function allocation(id:string){const events:AllocationObservation[]=[];let truncated=false;const result=allocateStorage(StorageId.parse(id),storages,{symbols:{},assets:r.assets},e=>{if(events.length<256)events.push(e);else truncated=true;});if(result.totalBytes.status!=='available')throw Error('最终实际分配不可用');return {result,events,truncated,bytes:result.totalBytes.quantity.value};}
 function storage(localId:string){
  const boundId=call.storageRefs.find(s=>s.localStorageId===localId)?.storageId;if(!boundId)throw Error('原访问的实际存储身份缺失');const {id,aliases,entry}=canonical(boundId,call.storages),finalStorage=storages.find(s=>s.storageId===id);if(!finalStorage)throw Error('实际规范存储不存在');
  const boundaries:string[]=[],original=entry.storage.allocation,fields=original.kind==='alias'?[]:original.kind==='bytes'?[{field:'allocation.value',value:original.value}]:[...original.shape.map(a=>({field:'shape.'+a.axisId,value:a.size})),...(original.quantization?.auxiliaries.flatMap(a=>a.count.kind==='formula'?[{field:'auxiliary.'+a.name,value:a.count.value}]:[])??[])];
  const initialProofs=fields.slice(0,64).map(f=>expression(f.value,entry.symbols,f.field,entry.bindingFrame)),initialEvents:AllocationObservation[]=[];let initialTruncated=fields.length>64;
  const initial=allocateStorage(entry.storage.storageId,[entry.storage],{symbols:entry.symbols,assets:r.assets},e=>{if(initialEvents.length<256)initialEvents.push(e);else initialTruncated=true;});
  if(initial.totalBytes.status!=='available')boundaries.push('原声明分配未完整复核');if(initialTruncated||initialProofs.some(p=>p.truncated))boundaries.push('原分配表达式达到记录预算');
  const events=capture.events.filter(e=>e.storageId===id),applied=events.find(e=>e.kind==='storage_applied'),decisions=events.filter(e=>e.kind==='rule_decision'),bindings=[];
  for(const event of events)if(event.kind==='specification_bound'){
   const assignments=events.filter(e=>e.kind==='scope_assignment').filter(e=>e.nodeId===event.nodeId&&e.ruleIndex===event.ruleIndex).map(e=>e.assignment),symbols=Object.fromEntries(assignments.map(a=>[a.name,a.quantity])),proofs=[];
   for(const [index,aux]of event.raw.auxiliaries.entries())if(aux.count.kind==='formula'){
    if(proofs.length>=64){boundaries.push('辅助项表达式达到记录预算');break;}
    const proof=expression(aux.count.value,symbols,'auxiliary.'+aux.name),actual=event.specification.auxiliaries[index]?.count;
    if(actual?.kind!=='formula'||stableStringify(evaluateValue(actual.value,{},r.assets))!==stableStringify(proof.quantity))throw Error('辅助项表达式与实际量化绑定不同');
    const links=[];for(const [name,quantity]of reads(proof.proof)){
     const winner=assignments.findLast(a=>a.name===name),candidates=assignments.filter(a=>a.name===name);if(!winner||stableStringify(winner.quantity)!==stableStringify(quantity)){boundaries.push('量化读取缺少实际作用域赋值');continue;}
     const frameId=winner.source.kind==='workload'?workloadParameterFrameId():assetParameterFrameId(winner.source.parameter.nodeId),parameter=winner.source.kind==='workload'?winner.source.field:winner.source.parameter.parameterKey,target='storage '+id+' / consumer '+event.nodeId+' / rule '+event.ruleIndex+' / auxiliary '+aux.name;
     links.push({name,frameId,parameter,quantity,candidates});if(roots.length<256)roots.push({frameId,name:parameter,quantity,target});else boundaries.push('量化参数根达到记录预算');
    }proofs.push({...proof,links});
   }
   bindings.push({nodeId:event.nodeId,ruleIndex:event.ruleIndex,raw:event.raw,specification:event.specification,proofs});
  }
  const application=expanded.resolved.quantizationApplications.find(a=>a.storageId===id),final=allocation(id),storageOverrides=overrides.filter(o=>o.storageId===id);
  if(application&&!applied)boundaries.push('量化执行事件达到预算，未声明完整变换');
  if(applied&&application){if(stableStringify(applied.application)!==stableStringify(application))throw Error('量化应用身份与实际图不同');if(initial.totalBytes.status==='available'&&application.beforeBytes!==initial.totalBytes.quantity.value)throw Error('原声明分配与实际量化前分配不同');}
  if(!application&&!storageOverrides.length&&initial.totalBytes.status==='available'&&initial.totalBytes.quantity.value!==final.bytes)boundaries.push('存在尚未采集的分配变换');
  const last=storageOverrides.at(-1);if(last){if(last.override.value.value!==final.bytes)throw Error('显式分配覆盖与最终分配不一致');}
  else if(application&&application.afterBytes!==final.bytes)boundaries.push('量化后仍存在尚未采集的分配变换');
  if(capture.truncated&&application)boundaries.push('量化执行事件达到记录预算');if(bindings.some(b=>b.proofs.some(p=>p.truncated))||final.truncated)boundaries.push('分配或辅助项表达式达到记录预算');
  return {localStorageId:localId,storageId:id,aliases,asset:entry.asset,initial:{storage:entry.storage,proofs:initialProofs,result:initial,events:initialEvents},quantization:{...(application?{application}:{}),decisions,bindings,operations:events.filter(e=>e.kind==='allocation_operation')},overrides:storageOverrides,final:{storage:finalStorage,...final},bytes:final.bytes,complete:boundaries.length===0,boundaries:[...new Set(boundaries)]};
 }
 const items=source.slice(start,start+pageSize).map((access,offset)=>{
  const index=start+offset,contribution=contributions[index],boundAccess=accessBindings.get(access);if(!contribution||!boundAccess)throw Error('实际访问贡献未采集');
  const independent=field==='hbmBytes'&&access.hbmEstimate?.kind==='bytes',explicitHBM=independent&&access.hbmEstimate?.kind==='bytes'?access.hbmEstimate.value:undefined;
  const useLogical=!!traffic||!independent,value=!useLogical&&explicitHBM?explicitHBM:access.logicalBytes.kind==='storage_allocation'?access.logicalBytes.passes:access.logicalBytes;
  const fieldPath='memoryAccess['+JSON.stringify(access.accessId)+'].';
  const proof=expression(value,call.symbols,fieldPath+(!useLogical?'hbmEstimate.value':access.logicalBytes.kind==='storage_allocation'?'logicalBytes.passes':'logicalBytes'),call.bindingContext?.frameId),isAllocation=useLogical&&access.logicalBytes.kind==='storage_allocation',skippedStorage=isAllocation&&proof.quantity.value===0;
  const allocationSource=isAllocation&&!skippedStorage?storage(access.storageId):undefined;
  let checked=proof.quantity.value;if(isAllocation){if(!skippedStorage&&!allocationSource)throw Error('实际分配来源未采集');checked=skippedStorage?0:(allocationSource?.bytes??0)*checked;}
  const explicitProof=traffic&&explicitHBM?expression(explicitHBM,call.symbols,fieldPath+'hbmEstimate.value',call.bindingContext?.frameId):undefined;
  if(contribution.traffic){if(checked!==contribution.traffic.before)throw Error('原访问表达式与覆盖分母操作数不同');checked=contribution.traffic.relevant?(explicitProof?.quantity.value??contribution.traffic.after):0;}
  const factor=field==='hbmBytes'&&!independent&&access.hbmEstimate?.kind==='factor'?access.hbmEstimate.value:undefined;if(factor!==undefined)checked=checked*factor;
  const unit=isAllocation?'count':'byte';if(proof.quantity.unit!==unit||checked!==contribution.value)throw Error('原访问表达式、分配和因子与实际字节不同');
  if(boundAccess.storageId!==call.storageRefs.find(s=>s.localStorageId===access.storageId)?.storageId)throw Error('实际访问存储映射不同');
  const item={index,accessId:access.accessId,mode:access.mode,kind:independent?'explicit_hbm_bytes' as const:isAllocation?'storage_allocation' as const:'declared_logical_bytes' as const,proof,...(factor===undefined?{}:{factor}),...(allocationSource?{storage:allocationSource}:{}),...(contribution.traffic?{traffic:contribution.traffic}:{}),...(explicitProof?{explicitProof}:{}),skippedStorage,contribution:{value:contribution.value,unit:'byte' as const},sum:{left:contribution.left,right:contribution.value,value:contribution.total},complete:!proof.truncated&&!explicitProof?.truncated&&(!allocationSource||allocationSource.complete),boundaries:[] as string[]};
  try{bytes+=jsonBytes(item,16*1024*1024-bytes);return item;}catch{return {index,accessId:access.accessId,mode:access.mode,kind:item.kind,skippedStorage,contribution:item.contribution,sum:item.sum,complete:false,boundaries:['本页来源记录达到16MiB预算']};}
 });
 return {kind:'storage_access_source' as const,field,metric:expected,page:r.page,pageSize,componentCount:source.length,operation:'ordered_sum' as const,total:{value:sum,unit:'byte' as const},items,complete:r.page===0&&source.length<=pageSize&&items.every(i=>i.complete),...(traffic?{trafficOverride:traffic}:{}),parameterRoots:roots};
}
export type StorageAccessSource=ReturnType<typeof explainStorageAccessSource>;
