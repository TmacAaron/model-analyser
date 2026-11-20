import { memoryAllocationMetric,memoryEvidenceMetric } from './memory-evidence-metric.js';
import { memoryEvidenceIssues } from './memory-evidence-validation.js';
import { canonical } from './validation.js';
import { validateMemoryPeakOverride } from './memory-peak-validation.js';
import { validateModulePeakLayout } from './module-peak-validation.js';
import type { ParallelResolution,Diagnostic,MetricValue } from './index.js';
import { validateLocalCosts } from './local-cost-validation.js';
import { validateExecution } from './execution-validation.js';
import { validateQuantizationApplications } from './quantization-result-validation.js';
import { validateFusions } from './fusion-validation.js';
import { validateMemberPayloadResult } from './communication-result-validation.js';
export function validateParallelResolution(result:ParallelResolution):Diagnostic[]{
  const issues:Diagnostic[]=[],diagnostics=new Map(result.diagnostics.map(d=>[d.diagnosticId,d]));
  const report=(message:string,path:string)=>issues.push({diagnosticId:'parallel-validation-'+issues.length,severity:'error',code:'invalid_parallel_result',message,location:{kind:'scenario',scenarioId:result.scenarioId,fieldPath:path}});
  const unique=(values:string[],path:string)=>{if(new Set(values).size!==values.length)report('标识重复，不能重复计算同一份结果',path);};
  unique(result.diagnostics.map(d=>d.diagnosticId),'diagnostics');
  function metrics(value:unknown,path:string):void{if(value===null||typeof value!=='object')return;
    if('diagnosticIds' in value&&Array.isArray(value.diagnosticIds)){for(const id of value.diagnosticIds)if(typeof id!=='string'||!diagnostics.has(id))report('指标引用缺少顶层诊断',path);if('status' in value&&value.status==='unavailable'&&!value.diagnosticIds.some(id=>typeof id==='string'&&diagnostics.get(id)?.severity==='error'))report('不可用指标必须引用错误诊断',path);}
    for(const [key,child] of Object.entries(value))metrics(child,path+'.'+key);
  }
  metrics(result,'result');
  const evidenceDevices=new Set(result.memory.flatMap(m=>m.deviceScope.kind==='per_device'?[m.deviceScope.deviceId]:m.deviceScope.deviceIds)),evidenceNodes=new Set<string>([...result.localCosts.nodes.map(n=>n.nodeId),...result.fusions.flatMap(f=>[f.application.nodeId,f.application.extraNodeId,...f.application.memberNodeIds]),...(result.execution.status==='available'?result.execution.result.steps.map(s=>s.nodeId):[])]);
  for(const message of memoryEvidenceIssues(result.memoryEvidence??[],evidenceDevices,evidenceNodes))report(message,'memoryEvidence');
  const evidenceAllocations=new Map(result.storageAllocations.map(s=>[s.storageId,s.allocation]));
  const evidenceElisions=new Map<string,string[]>();for(const f of result.fusions)for(const id of f.application.eliminatedStorageIds)evidenceElisions.set(id,[...(evidenceElisions.get(id)??[]),f.application.groupId]);
  const evidenceTimes=new Map(result.temporalMemory?.lifetimes.map(l=>[JSON.stringify([l.deviceId,l.storageId]),l]));
  for(const e of result.memoryEvidence??[]){
    const expected=new Map(result.storageAllocations.flatMap(s=>{const local=s.allocation.perDevice.find(d=>d.deviceId===e.deviceId);return local?[[s.storageId,local.totalBytes] as const]:[];}));
    if(expected.size!==e.allocations.length||e.allocations.some(a=>canonical(memoryAllocationMetric(e,a))!==canonical(expected.get(a.storageId))))report('存储证据与实际设备规范分配不符','memoryEvidence.allocations');
    for(const a of e.allocations)if(a.perCopyAllocation){const local=evidenceAllocations.get(a.storageId)?.perDevice.find(d=>d.deviceId===e.deviceId),f=a.perCopyAllocation;if(!local||local.copies!==f.copies||canonical(memoryEvidenceMetric(e,f.payloadBytes))!==canonical(local.allocation.payloadBytes)||canonical(memoryEvidenceMetric(e,f.totalBytes))!==canonical(local.allocation.totalBytes)||canonical(f.auxiliaryBytes.map(v=>({name:v.name,bytes:memoryEvidenceMetric(e,v.bytes)})))!==canonical(local.allocation.auxiliaryBytes))report('逐副本分解与实际物理分配不符','memoryEvidence.perCopyAllocation');}
    for(const a of e.allocations)if(canonical([...a.eliminatedBy].sort())!==canonical([...(evidenceElisions.get(a.storageId)??[])].sort()))report('取消物化的存储来源与实际融合不同','memoryEvidence.eliminatedBy');
    if(e.axis==='second'&&result.temporalMemory)for(const a of e.allocations){const actual=evidenceTimes.get(JSON.stringify([e.deviceId,a.storageId]));if(!actual||canonical(a.intervals)!==canonical(actual.intervals.map(i=>({start:i.startSeconds,end:i.endSeconds}))))report('存储证据与实际时间生命周期不符','memoryEvidence.intervals');}
  }
  if([...result.memory,...(result.serialBaseline?.memory??[])].some(m=>m.sequenceTheoretical))report('单步布局不能携带序列理论峰值','memory.sequenceTheoretical');
  issues.push(...validateModulePeakLayout(result));
  for(const [i,m] of result.memory.entries())issues.push(...validateMemoryPeakOverride(m,result.scenarioId,'memory.'+i,result.phase,result.memory.flatMap(r=>r.deviceScope.kind==='per_device'?[r.deviceScope.deviceId]:r.deviceScope.deviceIds)));
  for(const [i,m] of (result.serialBaseline?.memory??[]).entries())issues.push(...validateMemoryPeakOverride(m,result.scenarioId,'serialBaseline.memory.'+i,result.phase,result.memory.flatMap(r=>r.deviceScope.kind==='per_device'?[r.deviceScope.deviceId]:r.deviceScope.deviceIds)));
  const uses=result.tensorLayouts.map(t=>JSON.stringify([t.nodeId,t.tensorId]));unique(uses,'tensorLayouts');
  unique(result.storageLayouts.map(s=>JSON.stringify([s.nodeId,s.storageId])),'storageLayouts');
  for(const [index,s] of result.storageLayouts.entries())if(!result.storageAllocations.some(a=>a.storageId===s.storageId)||!s.assignmentIndices.length||s.assignmentIndices.some(i=>s.overriddenIndices.includes(i)))report('存储布局缺少规范分配或生效规则与覆盖规则冲突',`storageLayouts.${index}`);
  unique(result.storageAllocations.map(s=>s.storageId),'storageAllocations');unique(result.storageAllocations.flatMap(s=>s.aliasIds),'storageAllocations.aliasIds');unique(result.deviceAllocations.map(d=>d.deviceId),'deviceAllocations');
  unique(result.unassignedStorageIds,'unassignedStorageIds');unique(result.unassignedTensorIds,'unassignedTensorIds');unique(result.unassignedTensorUses.map(t=>JSON.stringify([t.nodeId,t.tensorId])),'unassignedTensorUses');
  unique(result.communications.map(c=>String(c.index)),'communications');
  unique(result.communications.flatMap(c=>c.origin?[c.origin.nodeId]:[]),'communications.origin');for(const c of result.communications)if(c.origin&&(c.origin.nodeId!==c.evaluation.definition.placement?.nodeId||result.localCosts.nodes.some(n=>n.nodeId===c.origin?.nodeId)))report('图内通信应作为唯一通信节点执行，不能再列为局部计算叶节点','communications.origin');
  for(const [index,t] of result.tensorLayouts.entries()){if(t.partition.tensorId!==t.tensorId)report('布局对象与绑定张量不一致',`tensorLayouts.${index}`);if(!t.assignmentIndices.length||t.assignmentIndices.some(i=>t.overriddenIndices.includes(i)))report('生效规则与覆盖规则冲突或缺失',`tensorLayouts.${index}.assignmentIndices`);}
  for(const id of result.unassignedTensorIds)if(result.tensorLayouts.some(t=>t.tensorId===id))report('对象同时被标为已配置和未配置','unassignedTensorIds');
  for(const use of result.unassignedTensorUses)if(uses.includes(JSON.stringify([use.nodeId,use.tensorId])))report('节点使用同时被标为已配置和未配置','unassignedTensorUses');
  for(const id of result.unassignedStorageIds)if(result.storageAllocations.some(s=>s.storageId===id||s.aliasIds.includes(id)))report('底层存储同时被标为已配置和未配置','unassignedStorageIds');
  const local=new Map<string,{category:string;metric:MetricValue}[]>();
  for(const [index,s] of result.storageAllocations.entries()){
    if(s.allocation.canonicalStorageId!==s.storageId||s.allocation.storageId!==s.storageId||!s.aliasIds.includes(s.storageId))report('存储结果必须按规范身份归一化并保留其引用',`storageAllocations.${index}`);
    unique(s.allocation.perDevice.map(d=>d.deviceId),`storageAllocations.${index}.perDevice`);
    for(const d of s.allocation.perDevice){const list=local.get(d.deviceId)??[];list.push({category:s.category,metric:d.totalBytes});local.set(d.deviceId,list);if(d.totalBytes.status==='available'&&d.allocation.totalBytes.status==='available'&&d.totalBytes.quantity.value!==d.copies*d.allocation.totalBytes.quantity.value)report('局部总分配必须是完整每份分配乘物理份数',`storageAllocations.${index}.perDevice`);}
  }
  function checkSum(target:MetricValue,values:MetricValue[],path:string){if(values.some(m=>m.status==='unavailable')){if(target.status==='available')report('分项有缺项时不能给出完整已知合计',path);return;}const sum=values.reduce((n,m)=>n+(m.status==='available'?m.quantity.value:0),0);if(!Number.isSafeInteger(sum)){if(target.status==='available')report('精确分配总和溢出不能报告为已知整数',path);return;}if(target.status!=='available'||sum!==target.quantity.value)report('物理分配合计与唯一底层分项不符',path);}
  for(const [index,d] of result.deviceAllocations.entries()){const parts=local.get(d.deviceId);if(!parts){report('设备合计没有对应物理分配',`deviceAllocations.${index}`);continue;}checkSum(d.knownBytes,parts.map(p=>p.metric),`deviceAllocations.${index}.knownBytes`);checkSum(d.knownBytes,d.categoryBreakdown.map(c=>c.bytes),`deviceAllocations.${index}.categoryBreakdown`);unique(d.categoryBreakdown.map(c=>c.category),`deviceAllocations.${index}.categoryBreakdown`);const categories=new Set(parts.map(p=>p.category));if(d.categoryBreakdown.length!==categories.size||d.categoryBreakdown.some(c=>!categories.has(c.category)))report('分解类别与规范底层分配不符',`deviceAllocations.${index}.categoryBreakdown`);for(const c of d.categoryBreakdown)checkSum(c.bytes,parts.filter(p=>p.category===c.category).map(p=>p.metric),`deviceAllocations.${index}.categoryBreakdown.${c.category}`);local.delete(d.deviceId);}
  if(local.size)report('已分配设备缺少合计行','deviceAllocations');
  for(const [index,c] of result.communications.entries())if(c.evaluation.cost.scope.phase!==result.phase||c.evaluation.source.tensorId!==c.evaluation.definition.source.tensorId||c.evaluation.destination.tensorId!==c.evaluation.definition.destination.tensorId)report('通信范围或端点与结果不一致',`communications.${index}`);
  for(const [index,c] of result.communications.entries())for(const message of validateMemberPayloadResult(c.evaluation))report(message,`communications.${index}`);
  return [...issues,...validateLocalCosts(result),...validateExecution(result),...validateQuantizationApplications(result.quantizationApplications,result.scenarioId,result),...validateFusions(result)];
}
