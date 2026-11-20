import type { AnalysisResult,MemoryEvidence,MetricTarget,MetricValue,MemoryPeak } from '@model-analyser/contracts';
import { memoryAllocationMetric } from '../../../packages/contracts/src/memory-evidence-metric.js';
import { timelineContext } from './timeline-context.js';
export function memoryFrame(result:AnalysisResult,step:string){
  if(!result.decode)return {result,memory:result.memory,transitions:[],step:undefined};
  const frame=result.decode.steps.find(s=>String(s.index)===step);return frame?{result:frame.result,memory:frame.memory,transitions:frame.stateTransitions,step:frame.index}:undefined;
}
type Accessor={nodeId:string;executionNodeId:string;reads:boolean;writes:boolean;temporary:boolean};
export type SelectedMemoryRow={deviceId:string;storage:MemoryEvidence['allocations'][number];axis:MemoryEvidence['axis'];value:MetricValue|undefined;originalValue:MetricValue|undefined;accessors:Accessor[];selectedAccessors:Accessor[];shared:boolean;interfaceKnown:boolean;interfaceBoundary:boolean;input:boolean;output:boolean;private:boolean;replacedBy:string[];provenancePool:MemoryEvidence['provenancePool'];reservation?:{before:MetricValue;after:MetricValue;reserved:MetricValue}|undefined};
export type SelectedMemoryView={rows:SelectedMemoryRow[];problem?:string|undefined;atomic:boolean;devices:string[];memory:MemoryPeak[];inputHash?:string|undefined;step?:number|undefined};
/** Linear projection of recorded evidence only. No resolver, allocator or new peak calculation. */
export function selectedMemoryView(result:AnalysisResult,target:MetricTarget|undefined,step:string):SelectedMemoryView{
  const frame=memoryFrame(result,step),empty={rows:[],devices:[],memory:[],atomic:false};if(!frame)return {...empty,problem:'所选显存调用不存在；不会改用另一步或序列总计。'};
  const report=frame.result,context=timelineContext(report,target?{key:'memory',label:'memory',target}:undefined),devices=frame.memory.flatMap(m=>m.deviceScope.kind==='per_device'?[m.deviceScope.deviceId]:m.deviceScope.deviceIds),base={devices,memory:frame.memory,inputHash:report.inputHash,step:frame.step,atomic:context.atomic};
  if(!target||!context.frame.available)return {...base,rows:[],problem:'当前调用没有所选存储范围；不会改用全模型。'};
  const evidence=report.distributed?.layout.memoryEvidence??report.memoryEvidence;if(!evidence?.length)return {...base,rows:[],problem:'当前结果未记录规范存储参与证据。旧结果请重新计算；分析缺项请查看诊断。'};
  const reservations=new Map(frame.transitions.flatMap(t=>t.storages.map(s=>[JSON.stringify([s.deviceId,s.storageId]),s] as const))),rows:SelectedMemoryRow[]=[];
  for(const e of evidence){
    const accesses=new Map<string,Accessor[]>(),selected=new Set<string>(),inputs=new Set(e.initialStorageIds),outputs=new Set(e.outputStorageIds),peak=frame.memory.find(m=>m.deviceScope.kind==='per_device'&&m.deviceScope.deviceId===e.deviceId);
    for(const u of e.uses){const take=target.kind==='model'||context.frame.nodeIds.has(u.nodeId)||context.frame.nodeIds.has(u.executionNodeId),reads=new Set(u.reads),writes=new Set(u.writes),temporary=new Set(u.temporary);for(const id of new Set([...reads,...writes,...temporary])){if(take)selected.add(id);const list=accesses.get(id)??[];list.push({nodeId:u.nodeId,executionNodeId:u.executionNodeId,reads:reads.has(id),writes:writes.has(id),temporary:temporary.has(id)});accesses.set(id,list);}}
    const boundary=e.interfaces?.find(i=>target.kind!=='model'&&i.nodeId===target.nodeId),boundaryIds=new Set(boundary?.storageIds??[]),interfaceKnown=target.kind==='model'||!!boundary||target.kind==='node'&&!!report.fusions?.some(f=>f.evaluation.application.nodeId===target.nodeId);
    const replacements=new Map<string,string[]>();for(const application of peak?.moduleOverrides?.applications??[])for(const id of application.privateStorageIds)replacements.set(id,[...(replacements.get(id)??[]),application.rule.overrideId]);
    for(const storage of e.allocations){if(target.kind!=='model'&&!selected.has(storage.storageId))continue;
      const accessors=accesses.get(storage.storageId)??[],selectedAccessors=target.kind==='model'?accessors:accessors.filter(u=>context.frame.nodeIds.has(u.nodeId)||context.frame.nodeIds.has(u.executionNodeId)),shared=accessors.some(u=>!selectedAccessors.includes(u)),input=inputs.has(storage.storageId),output=outputs.has(storage.storageId),originalValue=memoryAllocationMetric(e,storage),reservation=reservations.get(JSON.stringify([e.deviceId,storage.storageId]));
      rows.push({deviceId:e.deviceId,storage,axis:e.axis,originalValue,value:reservation?.reservedBytes??originalValue,accessors,selectedAccessors,shared,interfaceKnown,interfaceBoundary:boundaryIds.has(storage.storageId),input,output,private:selectedAccessors.length>0&&interfaceKnown&&!boundaryIds.has(storage.storageId)&&!storage.resident&&!input&&!output&&!shared,replacedBy:replacements.get(storage.storageId)??[],provenancePool:e.provenancePool,...(reservation?{reservation:{before:reservation.beforeBytes,after:reservation.afterBytes,reserved:reservation.reservedBytes}}:{})});
    }
  }
  const missing=devices.filter(id=>!evidence.some(e=>e.deviceId===id));return {...base,rows,...(missing.length?{problem:'部分设备未记录参与证据：'+missing.join(', ')+'；不会按零分配处理。'}:{})};
}
export function knownAllocationSum(rows:SelectedMemoryRow[]){let known=0,missing=0;for(const row of rows){if(row.value?.status==='available'){known+=row.value.quantity.value;if(!Number.isSafeInteger(known))return {known:undefined,missing,overflow:true};}else missing++;}return {known,missing,overflow:false};}
export function selectedMemoryExport(result:AnalysisResult,view:SelectedMemoryView,rows:SelectedMemoryRow[],target:MetricTarget|undefined,step:string,device:string,query:string){
  const frame=memoryFrame(result,step),evidence=frame?.result.distributed?.layout.memoryEvidence??frame?.result.memoryEvidence??[],devices=new Set(rows.map(r=>r.deviceId));
  return {version:'selected-memory.1',inputHash:view.inputHash,target,step:view.step,device,query,atomicWholeExecutionUnit:view.atomic,problem:view.problem,semantics:'Canonical allocation participation, not module peak. Storage.bytes is the original evaluated allocation; a state reservation supplies the actual max(before,after) call allocation. Private/total peak overrides remain separate.',
    sources:evidence.filter(e=>devices.has(e.deviceId)).map(e=>({deviceId:e.deviceId,axis:e.axis,provenancePool:e.provenancePool,memoryUseOrder:e.uses.map(u=>({nodeId:u.nodeId,executionNodeId:u.executionNodeId}))})),
    rows:rows.map(({value,originalValue,provenancePool,...row})=>{void value;void originalValue;void provenancePool;return row;})};
}
