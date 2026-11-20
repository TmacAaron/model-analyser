import { Scenario,type CapacitySearchRequest,type AnalysisResult,type CapacitySearchPoint } from '@model-analyser/contracts';
/** The search and on-demand source verification must use precisely the same candidate. */
export function capacityCandidate(base:Scenario,variable:CapacitySearchRequest['variable'],value:number):Scenario{
  if(!Number.isSafeInteger(value)||value<0)throw Error('容量候选必须为非负安全整数');
  const candidate=Scenario.parse(base);
  if(variable.kind==='workload'){
    const w=candidate.workload,field=variable.field;
    if(field==='batchSize')w.batchSize=value;
    else if(field==='queryTokensPerRequest')w.queryTokensPerRequest=value;
    else if(field==='pastTokensPerRequest'&&w.kind==='prefill')w.pastTokensPerRequest=value;
    else if(field==='contextTokensPerRequest'&&w.kind==='decode')w.contextTokensPerRequest=value;
    else throw Error('该工作负载阶段没有所选字段');
  }else{
    candidate.bindings=candidate.bindings.filter(b=>b.parameterKey!==variable.parameterKey);
    candidate.bindings.push({parameterKey:variable.parameterKey,value:{kind:'integer',value}});
    candidate.numericOverrides=candidate.numericOverrides.filter(o=>!(o.field==='parameter'&&o.parameterKey===variable.parameterKey&&(o.target.kind==='project'||o.target.kind==='scenario'||(o.target.kind==='node'&&o.target.nodeId==='$model'))));
  }
  return Scenario.parse(candidate);
}
/** Original exhaustive-search point projection, also used to verify a replay. */
export function capacityPoint(r:AnalysisResult,value:number):Extract<CapacitySearchPoint,{status:'available'}>{
  const memory:Extract<CapacitySearchPoint,{status:'available'}>['memory']=[];
  for(const m of r.memory){const ids=m.deviceScope.kind==='per_device'?[m.deviceScope.deviceId]:m.deviceScope.deviceIds;for(const deviceId of ids)memory.push({deviceId,peakBytes:m.peakBytes,capacityBytes:m.capacityBytes});}
  const allDevices=new Set(memory.map(m=>m.deviceId));
  const exceeds=memory.some(m=>m.peakBytes.status==='available'&&m.peakBytes.quantity.value>m.capacityBytes),known=memory.length>0&&r.scope.deviceIds.every(id=>allDevices.has(id))&&memory.every(m=>m.peakBytes.status==='available');
  return {status:'available',value,inputHash:r.inputHash,fit:exceeds?'exceeds':known?'fits':'unknown',memory,scope:r.scope,compute:r.total.compute,...(r.scope.aggregation==='group_total'&&(r.decode||r.distributed)?{modelUsefulCompute:(r.decode?.logicalCompute??r.distributed?.logicalCompute)?.find(c=>c.scope.target.kind==='model')?.compute}:{}),hbmBytes:r.total.hbmBytes,seconds:r.total.seconds,diagnostics:r.diagnostics};
}
