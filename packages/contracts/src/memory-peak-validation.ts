import type { MemoryPeak,MemoryPeakEstimate,Scenario,Diagnostic } from './index.js';
import { canonical } from './validation.js';

/** Unwrap only for validation of the unchanged theoretical lifecycle; never for capacity decisions. */
export function preTotalPeak(row:MemoryPeak):MemoryPeakEstimate{const {totalOverride,...base}=row;return totalOverride?.theoretical??{...base,peakPoint:base.peakPoint.kind==='unlocated'?{kind:'order',index:0}:base.peakPoint};}
export function theoreticalPeak(row:MemoryPeak):MemoryPeakEstimate{const base=preTotalPeak(row);return row.sequenceTheoretical??base.moduleOverrides?.theoretical??base;}
function moduleIssues(row:MemoryPeakEstimate,phase:Scenario['workload']['kind']):string[]{
  const e=row.moduleOverrides;if(!e)return [];const issues:string[]=[],report=(s:string)=>issues.push(s),unique=(a:readonly string[])=>new Set(a).size===a.length,persistent=(c:string)=>['weight','state','graph','runtime','reserve'].includes(c),claimed=new Set<string>(),removed=new Set<string>();
  if(canonical(row.deviceScope)!==canonical(e.theoretical.deviceScope)||row.capacityBytes!==e.theoretical.capacityBytes)report('模块覆盖不能改变设备/容量');
  if(row.peakBytes.status!=='available'||row.peakBytes.basis!=='estimated'||row.capacityStatus.kind!=='point_only')report('模块预算须为估计单点峰值');
  if(!unique(e.allocations.map(a=>a.storageId))||!unique(e.applications.map(a=>a.rule.overrideId)))report('模块覆盖规范分配/规则重复');
  for(const a of e.allocations)if(a.bytes.status!=='available'||!Number.isSafeInteger(a.bytes.quantity.value)||a.bytes.quantity.value<0||a.intervals.some(i=>i.end<i.start||e.axis==='order'&&(!Number.isSafeInteger(i.start)||!Number.isSafeInteger(i.end))))report('模块生命周期分配或区间无效');
  for(const a of e.applications){
    const owned=new Set([...a.memberNodeIds,...a.extraNodeIds]);if(!unique(a.extraNodeIds)||a.extraNodeIds.some(id=>a.memberNodeIds.includes(id)))report('模块融合附加事件身份无效');
    if(!a.rule.phases.includes(phase)||!a.rule.description.trim()||!unique(a.rule.phases)||!unique(a.memberNodeIds)||!unique(a.executionNodeIds)||a.end<a.start||e.axis==='order'&&(!Number.isSafeInteger(a.start)||!Number.isSafeInteger(a.end)))report('模块覆盖阶段、来源、调用跨度无效');
    if(a.rule.peakBytes.kind==='literal'&&(a.rule.peakBytes.quantity.unit!=='byte'||a.rule.peakBytes.quantity.value!==a.evaluatedBytes))report('模块覆盖字面量与求值不符');
    for(const id of a.memberNodeIds){if(claimed.has(id))report('模块覆盖存在嵌套/重复调用范围');claimed.add(id);}
    if(!unique(a.privateStorageIds)||!unique(a.retainedStorageIds)||!unique(a.boundaryStorageIds))report('模块存储身份重复');
    const relevant=e.allocations.filter(s=>e.uses.some(u=>owned.has(u.nodeId)&&[...u.reads,...u.writes,...u.temporary].includes(s.storageId)));
    if(canonical([...a.privateStorageIds,...a.retainedStorageIds].sort())!==canonical(relevant.map(s=>s.storageId).sort()))report('模块私有与保留存储须完整划分实际使用对象');
    for(const id of a.privateStorageIds){const s=e.allocations.find(s=>s.storageId===id);if(!s||persistent(s.category)||a.boundaryStorageIds.includes(id)||a.retainedStorageIds.includes(id)||removed.has(id)||e.uses.some(u=>!owned.has(u.nodeId)&&[...u.reads,...u.writes,...u.temporary].includes(id)))report('不能替换常驻、边界、共享或重复私有对象');removed.add(id);}
    const indices=e.uses.flatMap((u,i)=>owned.has(u.nodeId)&&a.executionNodeIds.includes(u.executionNodeId)?[i]:[]);if(!indices.length||e.axis==='order'&&(a.start!==Math.min(...indices)||a.end!==Math.max(...indices)))report('模块预算跨度须来自实际调用事件');
  }
  const points=[...new Set([0,...e.allocations.flatMap(a=>a.intervals.flatMap(i=>e.axis==='order'?[i.start,i.end+1]:[i.start,i.end])),...e.applications.flatMap(a=>e.axis==='order'?[a.start,a.end+1]:[a.start,a.end])])].sort((a,b)=>a-b);
  const sweep=(adjusted:boolean)=>{let maximum=-1,point=0,categories=new Map<string,number>();for(const at of points){if(e.axis==='order'&&at>=Math.max(1,e.uses.length))continue;const c=new Map<string,number>();for(const s of e.allocations){if(adjusted&&removed.has(s.storageId))continue;if(s.bytes.status==='available'&&s.intervals.some(i=>at>=i.start&&(e.axis==='order'?at<=i.end:at<i.end||i.start===i.end&&at===i.start||persistent(s.category)&&at===i.end)))c.set(s.category,(c.get(s.category)??0)+s.bytes.quantity.value);}if(adjusted)for(const a of e.applications)if(at>=a.start&&(e.axis==='order'?at<=a.end:at<a.end||a.start===a.end&&at===a.start))c.set('reserve',(c.get('reserve')??0)+a.evaluatedBytes);const n=[...c.values()].reduce((s,v)=>s+v,0);if(!Number.isSafeInteger(n))report('模块峰值叠加溢出');if(n>maximum){maximum=n;point=at;categories=c;}}return {maximum:Math.max(0,maximum),point,categories};}
  const raw=sweep(false),adjusted=sweep(true);
  // Decode reserves add the same persistent-state delta to raw and adjusted peaks.
  const delta=e.theoretical.peakBytes.status==='available'?e.theoretical.peakBytes.quantity.value-raw.maximum:NaN;
  for(const c of e.theoretical.categoryBreakdown)if(c.bytes.status!=='available'||c.bytes.quantity.value!==(raw.categories.get(c.category)??0)+(c.category==='state'?delta:0))report('模块覆盖原理论只能增加已保留的常驻状态预留');
  if(!Number.isSafeInteger(delta)||delta<0||row.peakBytes.status!=='available'||row.peakBytes.quantity.value!==adjusted.maximum+delta||e.peakCoordinate!==adjusted.point)report('模块峰值须等于保留对象与调用预算的重叠扫描');
  const expected=new Map(adjusted.categories);expected.set('state',(expected.get('state')??0)+delta);if(!unique(row.categoryBreakdown.map(c=>c.category)))report('模块峰值分类重复');for(const c of row.categoryBreakdown)if(c.bytes.status!=='available'||c.bytes.quantity.value!==(expected.get(c.category)??0))report('模块预算分类与重叠扫描不符');for(const [category,n] of expected)if(n&&!row.categoryBreakdown.some(c=>c.category===category))report('模块峰值遗漏保留分类/预算');
  return issues;
}
export function validateMemoryPeakOverride(row:MemoryPeak,scenarioId:string,path:string,phase:Scenario['workload']['kind'],physicalDeviceIds:readonly string[]):Diagnostic[]{
  const issues:Diagnostic[]=[],report=(message:string)=>issues.push({diagnosticId:'peak-override-validation-'+path+'-'+issues.length,severity:'error',code:'invalid_peak_override_result',message,location:{kind:'scenario',scenarioId,fieldPath:path}}),e=row.totalOverride;
  for(const message of moduleIssues(preTotalPeak(row),phase))report(message);
  if(!e){if(row.peakPoint.kind==='unlocated')report('未定位峰值必须有显式覆盖证据');return issues;}
  if(canonical(row.moduleOverrides??null)!==canonical(e.theoretical.moduleOverrides??null))report('总量覆盖前的模块证据须完整保留且一致');
  if(!e.rule.phases.includes(phase)||e.deviceIds.some(id=>!physicalDeviceIds.includes(id)))report('覆盖阶段/实际设备不属于当前结果');
  if(row.deviceScope.kind!=='per_device'||!e.deviceIds.includes(row.deviceScope.deviceId)||new Set(e.deviceIds).size!==e.deviceIds.length)report('覆盖设备范围不符或重复');
  if(canonical(row.deviceScope)!==canonical(e.theoretical.deviceScope)||row.capacityBytes!==e.theoretical.capacityBytes)report('覆盖不能修改设备身份/容量');
  if(e.rule.target.kind==='device'&&canonical(e.deviceIds)!==canonical([e.rule.target.deviceId]))report('设备覆盖不能扩大范围');
  if(row.peakBytes.status!=='available'||row.peakBytes.quantity.value!==e.evaluatedBytes||row.peakBytes.basis!=='estimated')report('有效峰值必须等于已求值覆盖且标注用户估计');
  if(e.rule.peakBytes.kind==='literal'&&(e.rule.peakBytes.quantity.unit!=='byte'||e.rule.peakBytes.quantity.value!==e.evaluatedBytes))report('字面覆盖与求值 byte 不符');
  if(!e.rule.description.trim()||new Set(e.rule.phases).size!==e.rule.phases.length)report('覆盖来源/阶段无效');
  if(row.categoryBreakdown.length||e.classification!=='unknown')report('只有总量时不能伪造分类');
  if(row.peakPoint.kind!=='unlocated'||row.peakPoint.overrideId!==e.rule.overrideId)report('总峰值覆盖没有实际峰值时刻证据');
  if(new Set(e.shadowedOverrideIds).size!==e.shadowedOverrideIds.length||e.shadowedOverrideIds.includes(e.rule.overrideId))report('被覆盖规则 ID 不一致');
  if(row.capacityStatus.kind!=='point_only')report('覆盖结果不能冒充容量区间解');
  const base=e.theoretical;if(base.peakBytes.status==='available'&&(base.categoryBreakdown.some(c=>c.bytes.status!=='available')||base.categoryBreakdown.reduce((n,c)=>n+(c.bytes.status==='available'?c.bytes.quantity.value:0),0)!==base.peakBytes.quantity.value))report('保留的理论峰值必须有完整且一致的分类');
  return issues;
}
