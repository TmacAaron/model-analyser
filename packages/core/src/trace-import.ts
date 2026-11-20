import { TraceImport,TraceSelection,TraceMappingRequest,MeasurementRecord,type TraceEvent,type ProfilerImport,type ProfilerEvent,type RocmTraceImport,type RocmTraceEvent,type TraceMappingTarget,type AnalysisResult } from '@model-analyser/contracts';
import { canonical } from '../../contracts/src/validation.js';
import { encodeMeasurements } from '../../contracts/src/measurement-file.js';
import { parseNanoseconds,relativeNanosecondsToSeconds } from './rocm-import.js';

export const traceByteLimit=64*1024*1024;
const obj=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Trace 事件必须是对象');return v as Record<string,unknown>;};
const numeric=(v:unknown,label:string):number=>{if(typeof v!=='number'||!Number.isFinite(v))throw Error(label+' 必须是有限数（微秒），不接受数字字符串');return v;};
const identity=(v:unknown,label:string):string=>{if(typeof v!=='string'&&!(typeof v==='number'&&Number.isFinite(v)))throw Error(label+' 必须是字符串或有限数');return JSON.stringify(v);};
export async function decodeChromeTrace(text:string,sourceName:string):Promise<TraceImport>{
  const bytes=new TextEncoder().encode(text);if(bytes.length>traceByteLimit)throw Error('Trace 解压后超过 64 MiB');
  let raw:unknown;try{raw=JSON.parse(text.replace(/^\uFEFF/,'')) as unknown;}catch{throw Error('Trace JSON 无法解析');}
  const rawEvents=Array.isArray(raw)?raw:obj(raw).traceEvents;if(!Array.isArray(rawEvents))throw Error('只接受事件数组或含 traceEvents 数组的 Chrome Trace JSON');if(rawEvents.length>100000)throw Error('Trace 超过 100000 个原始事件');
  const events:TraceEvent[]=[],ignored=new Map<string,number>();let zeroDurationCount=0,origin=Infinity;
  for(const [index,item] of rawEvents.entries()){
    const e=obj(item);if(typeof e.ph!=='string'||!e.ph)throw Error(`事件 ${index} 缺少 ph`);
    if(e.ph!=='X'){ignored.set(e.ph,(ignored.get(e.ph)??0)+1);continue;}
    const ts=numeric(e.ts,`事件 ${index} ts`),dur=numeric(e.dur,`事件 ${index} dur`);if(dur<0)throw Error(`事件 ${index} dur 不能为负`);if(dur===0){zeroDurationCount++;continue;}
    if(typeof e.name!=='string'||!e.name)throw Error(`事件 ${index} 缺少 name`);if(e.cat!==undefined&&typeof e.cat!=='string')throw Error(`事件 ${index} cat 必须是字符串`);
    if(!Number.isFinite(ts+dur)||ts+dur<=ts)throw Error(`事件 ${index} 时间超出可分辨数值范围`);
    // args are display-only evidence, never a hardware mapping or HBM byte count.
    const args=e.args&&typeof e.args==='object'&&!Array.isArray(e.args)?obj(e.args):{},device=args.device??args.Device,correlation=args.correlation;
    events.push({index,name:e.name,category:typeof e.cat==='string'?e.cat:'',pid:identity(e.pid,`事件 ${index} pid`),tid:identity(e.tid,`事件 ${index} tid`),startSeconds:0,seconds:dur/1e6,rawStartMicroseconds:ts,rawDurationMicroseconds:dur,...(typeof device==='string'||typeof device==='number'?{sourceDevice:String(device)}:{}),...(typeof correlation==='string'||typeof correlation==='number'?{correlation:String(correlation)}:{})});origin=Math.min(origin,ts);
  }
  if(!events.length)throw Error('Trace 没有正时长 complete X 事件；B/E、异步和采样事件尚不重建');
  for(const e of events)e.startSeconds=(e.rawStartMicroseconds-origin)/1e6;
  const hash=await globalThis.crypto.subtle.digest('SHA-256',bytes),contentHash=[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('');
  return TraceImport.parse({version:'chrome-trace.1',sourceName,contentHash,originMicroseconds:origin,rawEventCount:rawEvents.length,ignoredPhases:[...ignored].map(([phase,count])=>({phase,count})),zeroDurationCount,events});
}
function csvClock(trace:RocmTraceImport,event:RocmTraceEvent){
  const start=parseNanoseconds(event.rawStartNanoseconds,'Start_Timestamp'),end=parseNanoseconds(event.rawEndNanoseconds,'End_Timestamp'),origin=parseNanoseconds(trace.originNanoseconds,'origin');if(end<=start)throw Error('CSV事件必须有正的kernel区间');relativeNanosecondsToSeconds(end-origin);if(event.startSeconds!==relativeNanosecondsToSeconds(start-origin)||event.seconds!==relativeNanosecondsToSeconds(end-start))throw Error('CSV归一化时间与原始纳秒不一致');
  if(event.rawDispatchNanoseconds!==undefined&&parseNanoseconds(event.rawDispatchNanoseconds,'DispatchNs')>start||event.rawCompleteNanoseconds!==undefined&&parseNanoseconds(event.rawCompleteNanoseconds,'CompleteNs')<end)throw Error('CSV原始dispatch/complete顺序不一致');return {start,end};
}
const sourceQueue=(event:ProfilerEvent)=>'sourceQueue' in event?event.sourceQueue:undefined;
function eventEndSeconds(trace:ProfilerImport,event:ProfilerEvent){if(trace.version==='rocm-timestamps.1'){if(!('rawEndNanoseconds' in event))throw Error('CSV事件时钟类型不一致');return relativeNanosecondsToSeconds(BigInt(event.rawEndNanoseconds)-BigInt(trace.originNanoseconds));}if(!('rawStartMicroseconds' in event))throw Error('Chrome事件时钟类型不一致');return ((event.rawStartMicroseconds-trace.originMicroseconds)+event.rawDurationMicroseconds)/1e6;}
function timeSummary(trace:ProfilerImport,events:ProfilerEvent[]){
  if(trace.version==='rocm-timestamps.1'){
    const intervals=events.map(e=>{if(!('rawStartNanoseconds' in e))throw Error('CSV事件时钟类型不一致');return csvClock(trace,e);}).sort((a,b)=>a.start<b.start?-1:a.start>b.start?1:0),first=intervals[0];if(!first)throw Error('事件时间合计无效');let end=first.start,total=0n,overlapping=false;for(const e of intervals){if(e.start<end)overlapping=true;if(e.end>end)end=e.end;total+=e.end-e.start;}return {cumulativeSeconds:relativeNanosecondsToSeconds(total),spanSeconds:relativeNanosecondsToSeconds(end-first.start),overlapping};
  }
  const intervals=events.map(e=>{if(!('rawStartMicroseconds' in e))throw Error('Chrome事件时钟类型不一致');return e;}).sort((a,b)=>a.rawStartMicroseconds-b.rawStartMicroseconds),first=intervals[0];if(!first)throw Error('事件时间合计无效');let end=0,total=0,overlapping=false;for(const e of intervals){const start=e.rawStartMicroseconds-first.rawStartMicroseconds;if(start<end)overlapping=true;end=Math.max(end,start+e.rawDurationMicroseconds);total+=e.rawDurationMicroseconds;}if(!Number.isFinite(total)||!Number.isFinite(end))throw Error('事件时间合计无效');return {cumulativeSeconds:total/1e6,spanSeconds:end/1e6,overlapping};
}
export function selectTraceEvents(trace:ProfilerImport,input:TraceSelection):ProfilerEvent[]{
  if(trace.version==='rocm-timestamps.1'){const indices=new Set<number>(),dispatches=new Set<string>();for(const event of trace.events){csvClock(trace,event);if(indices.has(event.index)||event.index>=trace.rawEventCount)throw Error('CSV原始行索引重复或越界');indices.add(event.index);const key=JSON.stringify([event.pid,event.sourceDevice,event.dispatchId]);if(dispatches.has(key))throw Error('CSV重复dispatch身份');dispatches.add(key);}}
  const s=TraceSelection.parse(input);if(s.startSeconds!==undefined&&s.endSeconds!==undefined&&s.endSeconds<=s.startSeconds)throw Error('范围结束必须晚于开始');
  const indices=s.eventIndices?new Set(s.eventIndices):undefined;if(indices&&indices.size!==s.eventIndices?.length)throw Error('事件选择重复');
  if(indices){const known=new Set(trace.events.map(e=>e.index));for(const i of indices)if(!known.has(i))throw Error('选择包含未知事件 '+i);}
  // Full containment only: an interval never manufactures a clipped event measurement.
  return trace.events.filter(e=>(!indices||indices.has(e.index))&&(s.startSeconds===undefined||e.startSeconds>=s.startSeconds)&&(s.endSeconds===undefined||eventEndSeconds(trace,e)<=s.endSeconds)&&(s.category===undefined||e.category===s.category)&&(s.pid===undefined||e.pid===s.pid)&&(s.tid===undefined||e.tid===s.tid)&&(s.sourceDevice===undefined||e.sourceDevice===s.sourceDevice)&&(s.sourceQueue===undefined||sourceQueue(e)===s.sourceQueue)&&(!s.nameContains||e.name.includes(s.nameContains)));
}
export type TraceMappingRow={event:ProfilerEvent;status:'matched'|'unmatched'|'ambiguous';candidates:TraceMappingTarget[];ruleIds:string[];record:MeasurementRecord};
export function prepareTraceMeasurements(input:TraceMappingRequest):{rows:TraceMappingRow[];records:MeasurementRecord[];cumulativeSeconds:number;spanSeconds:number;overlapping:boolean}{
  const r=TraceMappingRequest.parse(input),events=selectTraceEvents(r.trace,r.selection);if(!events.length||events.length>1000)throw Error('每批须选择 1–1000 个事件；请缩小范围或分批');
  if(new Set(r.rules.map(x=>x.ruleId)).size!==r.rules.length)throw Error('映射规则 ID 重复');if(new Set(r.overrides.map(x=>x.eventIndex)).size!==r.overrides.length)throw Error('事件目标重复');if(new Set(r.deviceIds).size!==r.deviceIds.length)throw Error('物理设备重复');
  const chosen=new Set(events.map(e=>e.index));if(r.overrides.some(x=>!chosen.has(x.eventIndex)))throw Error('手动目标包含范围外事件');
  const {eventIndices,...filters}=r.selection,selectionEvidence={...filters,...(eventIndices?{explicitIndices:true}:{})};let encodedBytes=128;
  const rows=events.map(event=>{
    const rules=r.rules.filter(x=>x.name===event.name&&(x.category===undefined||x.category===event.category)&&(x.pid===undefined||x.pid===event.pid)&&(x.tid===undefined||x.tid===event.tid)&&(x.sourceDevice===undefined||x.sourceDevice===event.sourceDevice)&&(x.sourceQueue===undefined||x.sourceQueue===sourceQueue(event))),override=r.overrides.find(x=>x.eventIndex===event.index);
    const candidates=override?[override.target]:[...new Map(rules.map(x=>[canonical(x.target),x.target])).values()],target=candidates.length===1?candidates[0]:undefined,status=target?'matched' as const:candidates.length?'ambiguous' as const:'unmatched' as const;
    const rocm=r.trace.version==='rocm-timestamps.1';const clockEvidence='rawStartNanoseconds' in event?{csvLine:event.csvLine,dispatchId:event.dispatchId,sourceQueue:event.sourceQueue,rawStartNanoseconds:event.rawStartNanoseconds,rawEndNanoseconds:event.rawEndNanoseconds,rawDispatchNanoseconds:event.rawDispatchNanoseconds,rawCompleteNanoseconds:event.rawCompleteNanoseconds,...(r.trace.version==='rocm-timestamps.1'?{originNanoseconds:r.trace.originNanoseconds}:{})}:{rawStartMicroseconds:event.rawStartMicroseconds,rawDurationMicroseconds:event.rawDurationMicroseconds,...(r.trace.version==='chrome-trace.1'?{originMicroseconds:r.trace.originMicroseconds}:{})};
    const record=MeasurementRecord.parse({measurementId:rocm?`trace:${r.trace.version}:${r.trace.contentHash}:${event.index}:${r.scenarioId}`:`trace:${r.trace.contentHash}:${event.index}:${r.scenarioId}`,scenarioId:r.scenarioId,target:target??{kind:'unmapped',eventName:event.name,source:r.trace.sourceName},phase:r.phase,deviceIds:r.deviceIds,interval:r.interval,count:1,time:{kind:'single',seconds:event.seconds},source:{kind:'import',file:r.trace.sourceName,eventId:rocm&&'dispatchId' in event?`pid:${event.pid}/gpu:${event.sourceDevice}/dispatch:${event.dispatchId}`:String(event.index),mappingBasis:JSON.stringify({format:r.trace.version,contentHash:r.trace.contentHash,eventIndex:event.index,category:event.category,pid:event.pid,tid:event.tid,sourceDevice:event.sourceDevice,correlation:event.correlation,...clockEvidence,selection:selectionEvidence,ruleIds:rules.map(x=>x.ruleId),manualOverride:!!override,status,timeBasis:rocm?'kernel execution End_Timestamp - Start_Timestamp; integer nanoseconds / 1e9; not DispatchNs/CompleteNs or inferred model wall time':'inclusive complete X duration; microseconds / 1e6; one event, not inferred model or child time',physicalDeviceBasis:'user explicitly supplied; source pid/device are not mapped automatically'})}});
    encodedBytes+=new TextEncoder().encode(JSON.stringify(record,null,2).replaceAll('\n','\n    ')).length+6;if(encodedBytes>2*1024*1024)throw Error('本批统一测量文件超过2 MiB；请缩小范围或分批');
    return {event,status,candidates,ruleIds:rules.map(x=>x.ruleId),record};
  });
  const summary=timeSummary(r.trace,events),records=rows.map(x=>x.record);if(new TextEncoder().encode(encodeMeasurements(records,'json')).length>2*1024*1024)throw Error('本批统一测量文件超过2 MiB；请缩小范围或分批');return {rows,records,...summary};
}
/** Stable IDs and physical scopes for external mapping. Unmeasurable fusion/decode internals stay explicit. */
export function traceMappingSummary(result:AnalysisResult){
  const entries=[{target:{kind:'model' as const},deviceIds:result.total.scope.deviceIds,leafNodeIds:result.nodes.map(n=>n.nodeId)},...result.modules.map(m=>({target:{kind:'module' as const,nodeId:m.nodeId},deviceIds:m.cost.scope.deviceIds,leafNodeIds:m.leafNodeIds})),...result.nodes.map(n=>({target:{kind:'node' as const,nodeId:n.nodeId},deviceIds:n.cost.scope.deviceIds,leafNodeIds:[n.nodeId]})),...(result.fusions??[]).map(f=>({target:{kind:'node' as const,nodeId:f.evaluation.application.nodeId},deviceIds:f.cost.scope.deviceIds,leafNodeIds:f.evaluation.application.memberNodeIds}))];
  return {version:'trace-targets.1',scenarioId:result.scenarioId,inputHash:result.inputHash,phase:result.phase,targets:entries.map(e=>{const target=e.target;const key=target.kind==='model'?'model':target.kind+':'+target.nodeId,reason=result.decode?.unmeasurableTargetIds.includes(key)?'no independent decode interval':target.kind==='node'&&result.fusions?.some(f=>f.evaluation.application.memberNodeIds.includes(target.nodeId))?'fusion internal has no independent interval':target.kind==='module'&&result.fusions?.some(f=>f.evaluation.application.memberNodeIds.some(id=>e.leafNodeIds.includes(id))&&!f.evaluation.application.memberNodeIds.every(id=>e.leafNodeIds.includes(id)))?'module cuts across fusion boundary':undefined;return {...e,eligible:!reason,...(reason?{reason}:{})};}),notes:['Names and profiler pid/device IDs are not stable target/device mappings.','A single kernel is not automatically a complete module invocation. Confirm scope, phase, physical devices, interval and current input before binding.','No actual time or measured HBM bytes are generated by this summary.']};
}
