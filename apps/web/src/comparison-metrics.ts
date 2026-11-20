import type { AnalysisResult,AssetDocument,AssetRef,MetricValue,ScenarioComparisonResult } from '@model-analyser/contracts';
import { stableStringify } from '@model-analyser/core';
import { computeClassLabel,modelComputeFrame } from './compute-source.js';
export type ComparisonRow={key:string;label:string;unit:string;values:(number|undefined)[]};
const value=(m:MetricValue|undefined)=>m?.status==='available'?m.quantity.value:undefined;
export function comparisonRows(report:ScenarioComparisonResult):ComparisonRow[]{
  const results=report.entries.map(e=>e.analysis.status==='available'?e.analysis.result:undefined),out:ComparisonRow[]=[];
  const add=(key:string,label:string,unit:string,get:(r:AnalysisResult)=>number|undefined)=>out.push({key,label,unit,values:results.map(r=>r?get(r):undefined)});
  add('seconds','端到端理论跨度','second',r=>value(r.total.seconds));add('hbm','模型 HBM 流量（缺项不补零）','byte',r=>value(r.total.hbmBytes));
  const physicalClasses=new Map(results.flatMap(r=>r?.total.compute.map(c=>[stableStringify(c.computeClass),c.computeClass] as const)??[]));
  const logicalClasses=new Map(results.flatMap(r=>r?modelComputeFrame(r).compute.map(c=>[stableStringify(c.computeClass),c.computeClass] as const):[]));
  const classes=new Map([...physicalClasses,...logicalClasses]);
  for(const [key,cls] of classes){
    const label=computeClassLabel(cls);
    if(logicalClasses.has(key))add('useful:'+key,'模型有效 '+label,'operation',r=>value(modelComputeFrame(r).compute.find(c=>stableStringify(c.computeClass)===key)?.usefulOperations));
    if(physicalClasses.has(key))add('executed:'+key,'物理执行 '+label,'operation',r=>value(r.total.compute.find(c=>stableStringify(c.computeClass)===key)?.executedOperations));
  }
  const deviceIds=[...new Set(report.entries.flatMap(e=>e.scenario.deviceTopology.devices.map(d=>d.deviceId)))];
  for(const id of deviceIds){const memory=(r:AnalysisResult)=>r.memory.find(m=>m.deviceScope.kind==='per_device'?m.deviceScope.deviceId===id:m.deviceScope.deviceIds.includes(id));add('peak:'+id,id+' 生命周期峰值','byte',r=>value(memory(r)?.peakBytes));add('capacity:'+id,id+' 硬件容量','byte',r=>memory(r)?.capacityBytes);}
  const groups=[...new Set(results.flatMap(r=>r?.total.communications.map(c=>c.groupId)??[]))];
  for(const id of groups){add('send:'+id,id+' 通信 group send（多事件累计）','byte',r=>{const c=r.total.communications.filter(c=>c.groupId===id);const total=c.length&&c.every(v=>v.groupSendBytes.status==='available')?c.reduce((n,v)=>n+(value(v.groupSendBytes)??0),0):undefined;return total!==undefined&&Number.isFinite(total)?total:undefined;});}
  const modules=[...new Set(results.flatMap(r=>r?.modules.map(m=>m.nodeId)??[]))];
  for(const id of modules){add('module-seconds:'+id,'模块 '+id+' 跨度','second',r=>value(r.modules.find(m=>m.nodeId===id)?.cost.seconds));add('module-hbm:'+id,'模块 '+id+' HBM','byte',r=>value(r.modules.find(m=>m.nodeId===id)?.cost.hbmBytes));}
  return out;
}

export type ComparisonMetricPart={targetId:string;metricId:string;label:string;metric:MetricValue};
export type ComparisonMetricEvidence=
  |{kind:'metric';parts:ComparisonMetricPart[]}
  |{kind:'sum';parts:ComparisonMetricPart[];complete:boolean;sum:number|undefined}
  |{kind:'hardware';deviceId:string;hardwareRef:AssetRef;asset:AssetDocument|undefined;recordedCapacity:number|undefined;matches:boolean}
  |{kind:'missing';problem:string};

/** Resolve identity from the clicked entry, never the first matching class/device in another entry. */
export function comparisonMetricEvidence(report:ScenarioComparisonResult,rowKey:string,entryIndex:number):ComparisonMetricEvidence{
  const entry=Number.isSafeInteger(entryIndex)&&entryIndex>=0?report.entries[entryIndex]:undefined;
  if(!entry)return {kind:'missing',problem:'请求的比较配置不存在。'};
  if(entry.analysis.status!=='available')return {kind:'missing',problem:'该配置没有可用分析：'+entry.analysis.diagnostics.map(d=>d.message).join('；')};
  const result=entry.analysis.result;
  const missing=():ComparisonMetricEvidence=>({kind:'missing',problem:'该配置的请求指标或范围不存在；不会改选另一指标、设备或配置。'});
  const metric=(targetId:string,metricId:string,label:string,m:MetricValue|undefined):ComparisonMetricEvidence=>m?{kind:'metric',parts:[{targetId,metricId,label,metric:m}]}:missing();
  if(rowKey==='seconds'||rowKey==='hbm')return metric('model',rowKey,rowKey==='seconds'?'端到端理论跨度':'模型 HBM 流量',rowKey==='seconds'?result.total.seconds:result.total.hbmBytes);
  if(rowKey.startsWith('useful:')||rowKey.startsWith('executed:')){
    const useful=rowKey.startsWith('useful:'),key=rowKey.slice(useful?7:9),frame=useful?modelComputeFrame(result):{compute:result.total.compute,targetId:'model'},index=frame.compute.findIndex(c=>stableStringify(c.computeClass)===key),segment=frame.compute[index];
    return segment?metric(frame.targetId,(useful?'useful:':'executed:')+index,computeClassLabel(segment.computeClass),useful?segment.usefulOperations:segment.executedOperations):missing();
  }
  if(rowKey.startsWith('peak:')||rowKey.startsWith('capacity:')){
    const capacity=rowKey.startsWith('capacity:'),deviceId=rowKey.slice(capacity?9:5),index=result.memory.findIndex(m=>m.deviceScope.kind==='per_device'?m.deviceScope.deviceId===deviceId:m.deviceScope.deviceIds.some(id=>id===deviceId)),memory=result.memory[index];
    if(!memory)return missing();
    if(!capacity)return metric('memory:'+index,'peak',deviceId+' 生命周期峰值',memory.peakBytes);
    const device=entry.scenario.deviceTopology.devices.find(d=>d.deviceId===deviceId);if(!device)return missing();
    const asset=report.assets.find(a=>a.assetId===device.hardware.assetId&&a.revision===device.hardware.revision&&a.definition.kind==='hardware');
    return {kind:'hardware',deviceId,hardwareRef:device.hardware,asset,recordedCapacity:memory.capacityBytes,matches:memory.capacityBytes!==undefined&&asset?.definition.kind==='hardware'&&asset.definition.hardware.capacityBytes===memory.capacityBytes};
  }
  if(rowKey.startsWith('send:')){
    const groupId=rowKey.slice(5),parts=result.total.communications.flatMap((c,index)=>c.groupId===groupId?[{targetId:'model',metricId:'group-send:'+index,label:'事件 #'+(index+1)+' · '+c.groupId+' · '+c.operation,metric:c.groupSendBytes}]:[]);
    if(!parts.length)return missing();
    const known=parts.every(p=>p.metric.status==='available'),sum=known?parts.reduce((n,p)=>n+(p.metric.status==='available'?p.metric.quantity.value:0),0):undefined;
    return {kind:'sum',parts,complete:known&&sum!==undefined&&Number.isFinite(sum),sum:sum!==undefined&&Number.isFinite(sum)?sum:undefined};
  }
  const seconds=rowKey.startsWith('module-seconds:'),hbm=rowKey.startsWith('module-hbm:');
  if(seconds||hbm){const id=rowKey.slice(seconds?15:11),module=result.modules.find(m=>m.nodeId===id);return metric('module:'+id,seconds?'seconds':'hbm','模块 '+id,module?(seconds?module.cost.seconds:module.cost.hbmBytes):undefined);}
  return missing();
}

export function comparisonDeltaEvidence(report:ScenarioComparisonResult,rowKey:string,entryIndex:number){
  const row=comparisonRows(report).find(r=>r.key===rowKey),baseline=row?.values[0],current=entryIndex>0?row?.values[entryIndex]:undefined,raw=baseline!==undefined&&current!==undefined?current-baseline:undefined;
  return {baseline,current,delta:raw!==undefined&&Number.isFinite(raw)?raw:undefined,problem:baseline===undefined||current===undefined?'任一侧指标缺失，不能计算差值。':raw===undefined||!Number.isFinite(raw)?'差值超出有限数值范围。':undefined};
}
