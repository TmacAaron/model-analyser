import type { CapacitySearchResult,Diagnostic } from './index.js';
import { canonical } from './validation.js';

/** Semantic checks separate from the structural JSON Schema. */
export function validateCapacitySearch(result:CapacitySearchResult):Diagnostic[]{
  const issues:Diagnostic[]=[],scope=new Set<string>(result.baseScenario.deviceTopology.devices.map(d=>d.deviceId));
  function report(message:string,path:string){issues.push({diagnosticId:'capacity-validation-'+issues.length,severity:'error',code:'invalid_capacity_result',message,location:{kind:'scenario',scenarioId:result.baseScenario.scenarioId,fieldPath:path}});}
  const range=result.request.searchRange,count=range.max-range.min+1;
  if(range.min>range.max||!Number.isSafeInteger(count))report('搜索区间无效','request.searchRange');
  if(result.completion==='complete'&&result.points.length!==count)report('完整整数搜索必须包含区间内每一个点','points');
  if(result.points.length>count)report('搜索点超出区间','points');
  const outerIds=new Map(result.diagnostics.map(d=>[d.diagnosticId,d]));if(outerIds.size!==result.diagnostics.length)report('搜索诊断 ID 重复','diagnostics');
  for(const [index,point] of result.points.entries()){
    const path='points.'+index;if(point.value!==range.min+index||point.value>range.max)report('搜索点必须按区间升序连续，不能跳过未知点',path+'.value');
    const ids=new Map(point.diagnostics.map(d=>[d.diagnosticId,d]));if(ids.size!==point.diagnostics.length)report('同一点诊断 ID 重复',path+'.diagnostics');
    if(point.status==='unavailable'){if(!point.diagnostics.some(d=>d.severity==='error'))report('不可计算点必须包含缺项/错误诊断',path);continue;}
    function metrics(value:unknown,field:string):void{
      if(value===null||typeof value!=='object')return;
      if('diagnosticIds' in value&&Array.isArray(value.diagnosticIds)){
        for(const id of value.diagnosticIds)if(typeof id!=='string'||!ids.has(id))report('指标引用缺少当前点的诊断',field);
        if('status' in value&&value.status==='unavailable'&&!value.diagnosticIds.some(id=>typeof id==='string'&&ids.get(id)?.severity==='error'))report('不可用指标必须关联错误诊断',field);
      }
      for(const [key,child] of Object.entries(value))metrics(child,field+'.'+key);
    }
    metrics(point,path);
    if(point.scope&&(point.scope.target.kind!=='model'||point.scope.phase!==result.baseScenario.workload.kind||!['per_device','group_total'].includes(point.scope.aggregation)||canonical([...point.scope.deviceIds].sort())!==canonical([...scope].sort())))report('搜索点成本范围与完整方案设备/阶段不同',path+'.scope');
    if(point.modelUsefulCompute&&point.scope?.aggregation!=='group_total')report('独立模型工作量需要明确的设备组合计成本范围',path+'.modelUsefulCompute');
    for(const [key,compute] of [['compute',point.compute],['modelUsefulCompute',point.modelUsefulCompute??[]]] as const){if(new Set(compute.map(c=>canonical(c.computeClass))).size!==compute.length)report('搜索点不能重复同一计算类别',path+'.'+key);for(const c of compute)if(c.usefulOperations.status==='available'&&c.executedOperations.status==='available'&&c.executedOperations.quantity.value<c.usefulOperations.quantity.value)report('搜索点执行工作量不能小于有效工作量',path+'.'+key);}
    const devices=new Set<string>(point.memory.map(m=>m.deviceId));if(devices.size!==point.memory.length||[...devices].some(id=>!scope.has(id)))report('峰值设备范围重复或未知',path+'.memory');
    const exceeds=point.memory.some(m=>m.peakBytes.status==='available'&&m.peakBytes.quantity.value>m.capacityBytes),known=point.memory.every(m=>m.peakBytes.status==='available')&&[...scope].every(id=>devices.has(id));
    if(point.fit!==(exceeds?'exceeds':known?'fits':'unknown'))report('容量判定与设备峰值/容量或缺项不符',path+'.fit');
  }
  const status=result.capacityStatus;
  if(status.kind==='solved'){
    if(result.completion!=='complete')report('取消搜索不能声明已求得最大值','capacityStatus');
    if(canonical(status.searchRange)!==canonical(range))report('求解结论与搜索范围不同','capacityStatus.searchRange');
    const expectedVariable=result.request.variable.kind==='workload'?'workload.'+result.request.variable.field:'parameter.'+result.request.variable.parameterKey;
    if(status.solveVariable!==expectedVariable)report('求解变量与请求不符','capacityStatus.solveVariable');
    const best=result.points.filter(p=>p.status==='available'&&p.fit==='fits').at(-1);
    if(!best||best.value!==status.maximum)report('最大值必须等于已计算的最高可行整数点','capacityStatus.maximum');
    if(result.points.some(p=>p.value>status.maximum&&(p.status==='unavailable'||p.fit==='unknown')))report('最大值以上仍有未知点，不能证明最大容量','capacityStatus.maximum');
    if(new Set(status.limitingDeviceIds).size!==status.limitingDeviceIds.length||status.limitingDeviceIds.some(id=>!scope.has(id)))report('限制设备重复或不属于方案','capacityStatus.limitingDeviceIds');
  }else if(status.kind==='unavailable'){
    if(!status.diagnosticIds.some(id=>outerIds.get(id)?.severity==='error')||status.diagnosticIds.some(id=>!outerIds.has(id)))report('容量缺项必须引用搜索级错误诊断','capacityStatus.diagnosticIds');
  }else report('区间搜索不能使用单点结论替代最大值或缺项','capacityStatus');
  return issues;
}
