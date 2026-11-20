import type { MemoryEvidence } from './index.js';
/** Evidence proves allocation participation, never a proportional attribution of a peak. */
export function memoryEvidenceIssues(rows:MemoryEvidence[],devices:Set<string>,nodes:Set<string>):string[]{
  const issues:string[]=[],seenDevices=new Set<string>(),unique=(ids:string[])=>new Set(ids).size===ids.length;
  for(const row of rows){
    if(seenDevices.has(row.deviceId)||!devices.has(row.deviceId))issues.push('存储证据设备重复或不在当前结果中');seenDevices.add(row.deviceId);
    const allocations=new Map(row.allocations.map(a=>[String(a.storageId),a])),aliasIds=new Set<string>();
    if(allocations.size!==row.allocations.length)issues.push('规范存储证据重复');
    for(const a of row.allocations){
      if(a.resident!==['weight','state','graph','runtime','reserve'].includes(a.category))issues.push('存储常驻标记与生命周期类别不符');
      if(a.bytes.status==='available'&&(!Number.isSafeInteger(a.bytes.quantity.value)||a.bytes.quantity.value<0))issues.push('分配证据须为精确非负byte');
      if(a.bytes.status==='available'&&!row.provenancePool[a.bytes.provenanceIndex])issues.push('分配证据引用缺失来源');
      const format=a.perCopyAllocation;if(format){const metrics=[format.payloadBytes,format.totalBytes,...format.auxiliaryBytes.map(v=>v.bytes)];if(!unique(format.auxiliaryBytes.map(v=>v.name))||metrics.some(v=>v.status==='available'&&(!row.provenancePool[v.provenanceIndex]||!Number.isSafeInteger(v.quantity.value))))issues.push('逐副本分配分解或来源无效');if(format.totalBytes.status==='available'&&format.payloadBytes.status==='available'&&format.auxiliaryBytes.every(v=>v.bytes.status==='available')){const sum=format.payloadBytes.quantity.value+format.auxiliaryBytes.reduce((n,v)=>n+(v.bytes.status==='available'?v.bytes.quantity.value:0),0);if(sum!==format.totalBytes.quantity.value)issues.push('payload与辅助项不等于逐副本合计');}if(a.bytes.status==='available'&&format.totalBytes.status==='available'&&format.totalBytes.quantity.value*format.copies!==a.bytes.quantity.value)issues.push('物理分配与逐副本打包及副本数不符');}
      if(!unique(a.eliminatedBy)||a.eliminatedBy.length&&a.bytes.status==='available'&&a.bytes.quantity.value!==0)issues.push('取消物化的存储须明确为零物理分配');
      if(!unique(a.aliasIds))issues.push('存储别名重复');for(const id of a.aliasIds){if(allocations.has(id)||aliasIds.has(id))issues.push('存储别名与规范身份冲突');aliasIds.add(id);}
      if(a.intervals?.some(i=>i.end<i.start||row.axis==='order'&&(!Number.isSafeInteger(i.start)||!Number.isSafeInteger(i.end)||i.end>=Math.max(1,row.uses.length))))issues.push('存储生命周期区间无效');
    }
    for(const ids of [row.initialStorageIds,row.outputStorageIds,row.carriedStorageIds])if(!unique(ids)||ids.some(id=>!allocations.has(id)))issues.push('存储边界引用重复或不在设备分配中');
    if(!unique((row.interfaces??[]).map(i=>i.nodeId))||(row.interfaces??[]).some(i=>!unique(i.storageIds)||i.storageIds.some(id=>!allocations.has(id))))issues.push('范围接口证据重复或引用缺失规范分配');
    const used=new Set<string>();for(const u of row.uses){const key=JSON.stringify([u.nodeId,u.executionNodeId]);if(used.has(key)||!nodes.has(u.nodeId)||!nodes.has(u.executionNodeId))issues.push('存储访问者重复或不是当前执行节点');used.add(key);for(const ids of [u.reads,u.writes,u.temporary])if(!unique(ids)||ids.some(id=>!allocations.has(id)))issues.push('存储访问必须引用本设备的唯一规范分配');}
  }
  return issues;
}
