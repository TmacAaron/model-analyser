import { memoryEvidenceIssues } from './memory-evidence-validation.js';
import { theoreticalPeak,validateMemoryPeakOverride } from './memory-peak-validation.js';
import { AnalysisResult, type Diagnostic, type CostResult } from './index.js';
import { canonical } from './validation.js';
import { validateDistributedResult } from './distributed-result-validation.js';
import { validateAnalysisQuantization } from './quantization-result-validation.js';
import { validateDecodeResult } from './decode-validation.js';

export function validateResult(result:AnalysisResult):Diagnostic[] {
  const issues:Diagnostic[]=[];
  const report=(code:string,message:string,fieldPath:string)=>issues.push({diagnosticId:`result-validation-${issues.length+1}`,severity:'error',code,message,location:{kind:'scenario',scenarioId:result.scenarioId,fieldPath}});
  const ids=new Map(result.diagnostics.map(d=>[d.diagnosticId,d]));
  if(ids.size!==result.diagnostics.length)report('duplicate_id','诊断 ID 重复','diagnostics');
  const unique=(values:string[],path:string)=>{if(new Set(values).size!==values.length)report('duplicate_id','ID 重复',path);};
  function metrics(value:unknown,path:string):void {
    if(value===null||typeof value!=='object')return;
    if('status' in value&&(value.status==='available'||value.status==='unavailable')&&'diagnosticIds' in value&&Array.isArray(value.diagnosticIds)){
      for(const id of value.diagnosticIds)if(typeof id!=='string'||!ids.has(id))report('missing_reference',`指标引用缺失诊断 ${String(id)}`,path+'.diagnosticIds');
      if(value.status==='unavailable'&&!value.diagnosticIds.some(id=>typeof id==='string'&&ids.get(id)?.severity==='error'))report('missing_reference','不可用指标必须关联至少一条错误/缺项诊断',path);
    }
    for(const [key,child] of Object.entries(value))if(key!=='provenance')metrics(child,path+'.'+key);
  }
  metrics(result,'result');
  unique(result.scope.deviceIds,'scope.deviceIds');
  if(result.scope.phase!==result.phase)report('invalid_scope','结果阶段与范围不一致','scope.phase');
  if(canonical(result.total.scope)!==canonical(result.scope))report('invalid_scope','总计范围必须等于结果范围','total.scope');
  const devices=new Set<string>(result.scope.deviceIds),nodes=new Set<string>([...result.nodes.map(n=>n.nodeId),...(result.fusions??[]).flatMap(f=>[f.evaluation.application.nodeId,f.evaluation.application.extraNodeId]),...(result.decode?.steps??[]).flatMap(s=>(s.result.fusions??[]).map(f=>f.evaluation.application.extraNodeId))]);
  for(const message of memoryEvidenceIssues(result.memoryEvidence??[],devices,nodes))report('invalid_memory_evidence',message,'memoryEvidence');
  if(result.decode&&result.memoryEvidence)report('invalid_memory_evidence','序列存储证据须按实际步骤记录','memoryEvidence');
  unique(result.nodes.map(n=>n.nodeId),'nodes');unique(result.modules.map(n=>n.nodeId),'modules');
  const costs=[result.total,...result.nodes.map(n=>n.cost),...result.modules.map(n=>n.cost),...(result.fusions??[]).map(f=>f.cost)];
  function scope(cost:CostResult,path:string){
    if(cost.scope.phase!==result.phase)report('invalid_scope','不能在一个阶段结果混入其他阶段成本',path);
    unique(cost.scope.deviceIds,path+'.deviceIds');
    if(cost.scope.aggregation==='per_device'&&cost.scope.deviceIds.length!==1)report('invalid_scope','per_device 只允许一个物理设备',path);
    for(const id of cost.scope.deviceIds)if(!devices.has(id))report('missing_reference',`未知设备 ${id}`,path);
    for(const [i,compute] of cost.compute.entries())if(compute.executedOperations.status==='available'&&compute.usefulOperations.status==='available'&&compute.executedOperations.quantity.value<compute.usefulOperations.quantity.value)report('invalid_cost','执行工作量不得小于有效工作量',path+`.compute.${i}`);
  }
  costs.forEach((cost,i)=>scope(cost,`costs.${i}.scope`));
  function aggregate(target:CostResult,leaves:CostResult[],path:string){
    if(result.decode)return; // Sequence active costs and math drilldown are verified against each child separately.
    const comparable=leaves.filter(leaf=>leaf.scope.phase===target.scope.phase&&leaf.scope.aggregation===target.scope.aggregation&&canonical([...leaf.scope.deviceIds].sort())===canonical([...target.scope.deviceIds].sort()));
    for(const key of ['logicalReadBytes','logicalWriteBytes','hbmBytes','seconds'] as const)if(!(key==='seconds'&&result.fusions?.length)&&target[key].status==='available'&&comparable.some(leaf=>leaf[key].status==='unavailable'))report('invalid_cost','叶节点有缺项时不能给出完整可用总计',path+'.'+key);
    for(const segment of target.compute){const matching=comparable.flatMap(leaf=>leaf.compute.filter(c=>canonical(c.computeClass)===canonical(segment.computeClass)));
      for(const key of ['usefulOperations','executedOperations'] as const)if(segment[key].status==='available'&&matching.some(c=>c[key].status==='unavailable'))report('invalid_cost','计算段缺项时不能给出完整可用总计',path+'.compute.'+key);
    }
  }
  aggregate(result.total,result.nodes.map(n=>n.cost),'total');
  for(const node of result.nodes)if(node.cost.scope.target.kind!=='node'||node.cost.scope.target.nodeId!==node.nodeId)report('invalid_scope','节点成本目标不匹配','nodes');
  for(const module of result.modules){
    if(module.cost.scope.target.kind!=='module'||module.cost.scope.target.nodeId!==module.nodeId)report('invalid_scope','模块成本目标不匹配','modules');
    unique(module.leafNodeIds,'modules.leafNodeIds');for(const id of module.leafNodeIds)if(!nodes.has(id))report('missing_reference',`模块引用缺失叶节点 ${id}`,'modules.leafNodeIds');
    aggregate(module.cost,result.nodes.filter(n=>module.leafNodeIds.includes(n.nodeId)).map(n=>n.cost),'modules.'+module.nodeId);
  }
  function deviceScope(value:AnalysisResult['memory'][number]['deviceScope'],path:string){
    const scopeIds=value.kind==='per_device'?[value.deviceId]:value.deviceIds;unique(scopeIds,path);
    for(const id of scopeIds)if(!devices.has(id))report('missing_reference',`范围包含未知设备 ${id}`,path);
  }
  const near=(a:number,b:number)=>Math.abs(a-b)<=1e-10*Math.max(1,Math.abs(a),Math.abs(b));
  for(const [i,effective] of result.memory.entries()){
    if(effective.sequenceTheoretical&&!result.decode)report('invalid_peak_override_result','只有逐步序列可附独立序列理论峰值','memory.'+i);
    issues.push(...validateMemoryPeakOverride(effective,result.scenarioId,'memory.'+i,result.phase,result.scope.deviceIds));const memory=theoreticalPeak(effective);
    const path=`memory.${i}`;deviceScope(memory.deviceScope,path+'.deviceScope');unique(memory.categoryBreakdown.map(c=>c.category),path+'.categoryBreakdown');
    if(memory.peakBytes.status==='available'){
      if(memory.categoryBreakdown.some(c=>c.bytes.status==='unavailable'))report('invalid_cost','峰值缺项时不能给出完整可用总量',path+'.peakBytes');
      else {const sum=memory.categoryBreakdown.reduce((n,c)=>n+(c.bytes.status==='available'?c.bytes.quantity.value:0),0);if(!Number.isFinite(sum)||!near(sum,memory.peakBytes.quantity.value))report('invalid_cost','峰值分解与总量不一致',path+'.peakBytes');}
    }
    if(memory.peakPoint.nodeId&&!nodes.has(memory.peakPoint.nodeId))report('missing_reference','峰值节点不存在',path+'.peakPoint');
    const capacity=memory.capacityStatus;
    if(capacity.kind==='solved'){
      if(capacity.searchRange.min>capacity.searchRange.max||capacity.maximum<capacity.searchRange.min||capacity.maximum>capacity.searchRange.max)report('invalid_capacity','容量解超出搜索区间',path+'.capacityStatus');
      if(capacity.fixedVariables.some(v=>v.parameterKey===capacity.solveVariable))report('invalid_capacity','求解变量不能同时固定',path+'.capacityStatus');
      for(const id of capacity.limitingDeviceIds)if(!devices.has(id))report('missing_reference','容量限制设备不存在',path+'.capacityStatus');
    }
  }
  for(const [i,entry] of result.schedule.entries()){
    const path=`schedule.${i}`;if(!nodes.has(entry.nodeId))report('missing_reference','时间线节点不存在',path);deviceScope(entry.deviceScope,path);
    if(entry.endSeconds<entry.startSeconds)report('invalid_schedule','结束时间早于开始时间',path);
  }
  for(const [i,point] of result.roofline.entries()){
    const path=`roofline.${i}`;
    if(point.scope.phase!==result.phase||point.scope.deviceIds.some(id=>!devices.has(id)))report('invalid_scope','Roofline 范围与结果不匹配',path+'.scope');
    if(point.arithmeticIntensity.status==='available'){
      if(point.operations.status!=='available'||point.trafficBytes.status!=='available'||point.trafficBytes.quantity.value===0)report('invalid_cost','算术强度缺少有效工作量或非零流量',path+'.arithmeticIntensity');
      else if(!near(point.arithmeticIntensity.operationsPerByte,point.operations.quantity.value/point.trafficBytes.quantity.value))report('invalid_cost','算术强度不等于 operations/bytes',path+'.arithmeticIntensity');
    }
  }
  issues.push(...validateDistributedResult(result),...validateAnalysisQuantization(result),...validateDecodeResult(result));return issues;
}
