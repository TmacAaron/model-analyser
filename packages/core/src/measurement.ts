import { MeasurementRecord,MeasurementComparisonAttempt,type AnalysisResult,type Scenario,type AssetDocument,type Diagnostic,type HardwareDefinition,type MetricValue,type Provenance } from '@model-analyser/contracts';
import { computeInputHash,stableStringify } from './input-hash.js';
import { MetricFactory } from './metrics.js';
import { canonical } from '../../contracts/src/validation.js';
import { FormulaError } from './formula.js';
import { validateResult } from '../../contracts/src/result-validation.js';
import { measurementProblems } from '../../contracts/src/measurement-file.js';

export async function measurementRecordHash(record:MeasurementRecord){
  const hash=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(stableStringify(record)));
  return [...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('');
}
export async function compareMeasurement(input:MeasurementRecord,scenario:Scenario,result:AnalysisResult,assets:AssetDocument[]):Promise<MeasurementComparisonAttempt>{
  const diagnostics:Diagnostic[]=[...result.diagnostics];
  try{
    const issues=validateResult(result);if(issues.length)throw new FormulaError('invalid_result','理论结果语义检查失败：'+issues[0]?.message);
    const record=MeasurementRecord.parse(input);
    const problem=measurementProblems(record)[0];if(problem)throw new FormulaError(problem.code,problem.message);
    if(record.target.kind==='unmapped')throw new FormulaError('unknown_measurement_scope','测量目标尚未映射，不能生成 MFU/MBU');
    if(!record.inputHash)throw new FormulaError('unbound_measurement','测量尚未绑定输入版本，需用户明确确认');
    if(record.inputHash!==result.inputHash||await computeInputHash(scenario,assets,result.stepContext)!==result.inputHash)throw new FormulaError('measurement_input_mismatch','测量或理论结果对应另一个输入版本');
    if(record.scenarioId!==scenario.scenarioId||scenario.scenarioId!==result.scenarioId||record.phase!==result.phase)throw new FormulaError('unknown_measurement_scope','测量方案/阶段与理论结果不一致');
    if(canonical([...result.scope.deviceIds].sort())!==canonical(scenario.deviceTopology.devices.map(d=>d.deviceId).sort()))throw new FormulaError('unknown_measurement_scope','模型结果设备范围与该输入版本的完整拓扑不同');
    const target=record.target;
    if(result.decode?.unmeasurableTargetIds.includes(target.kind==='model'?'model':target.kind+':'+target.nodeId))throw new FormulaError('unknown_measurement_scope','目标在 decode 步骤中没有独立测量区间');
    if(target.kind==='node'&&result.fusions?.some(f=>f.evaluation.application.memberNodeIds.includes(target.nodeId)))throw new FormulaError('unknown_measurement_scope','融合内部数学步骤没有独立测量区间，请选择融合组或完整外部范围');
    if(target.kind==='module'){const module=result.modules.find(m=>m.nodeId===target.nodeId);if(module&&result.fusions?.some(f=>f.evaluation.application.memberNodeIds.some(id=>module.leafNodeIds.includes(id))&&!f.evaluation.application.memberNodeIds.every(id=>module.leafNodeIds.includes(id))))throw new FormulaError('unknown_measurement_scope','该模块只覆盖融合组的一部分，没有独立可比较区间');}
    const cost=target.kind==='model'?result.total:target.kind==='node'?result.nodes.find(n=>n.nodeId===target.nodeId)?.cost??result.fusions?.find(f=>f.evaluation.application.nodeId===target.nodeId)?.cost:result.modules.find(m=>m.nodeId===target.nodeId)?.cost;
    if(!cost||canonical([...record.deviceIds].sort())!==canonical([...cost.scope.deviceIds].sort()))throw new FormulaError('unknown_measurement_scope','测量目标或物理设备范围与成本范围不一致');
    if(new Set(record.deviceIds).size!==record.deviceIds.length)throw new FormulaError('unknown_measurement_scope','测量设备范围重复');
    const logical=(result.decode?.logicalCompute??result.distributed?.logicalCompute)?.find(c=>canonical(c.scope.target)===canonical(cost.scope.target));
    if((result.distributed||result.decode)&&!logical)throw new FormulaError('unknown_measurement_scope','结果缺少相同目标的模型有效工作量');
    const mfuCompute=logical?.compute??cost.compute,mfuScope=logical?.scope??cost.scope;
    if(record.time.kind==='single'&&record.count!==1)throw new FormulaError('unknown_measurement_scope','single 测量要求 count=1');
    const time=record.time,perCallEquivalentSeconds=time.kind==='span'?(time.endSeconds-time.startSeconds)/record.count:time.kind==='sum'?time.seconds/record.count:time.seconds;
    const intervalSeconds=time.kind==='span'?time.endSeconds-time.startSeconds:time.kind==='sum'?time.seconds:time.seconds*record.count;
    if(!Number.isFinite(perCallEquivalentSeconds)||perCallEquivalentSeconds<=0||!Number.isFinite(intervalSeconds)||intervalSeconds<=0)throw new FormulaError('invalid_measurement_time','测量时间归一化结果必须为正有限数');
    const hardware:HardwareDefinition[]=record.deviceIds.map(id=>{const device=scenario.deviceTopology.devices.find(d=>d.deviceId===id),asset=device?assets.find(a=>a.assetId===device.hardware.assetId&&a.revision===device.hardware.revision):undefined;if(asset?.definition.kind!=='hardware')throw new FormulaError('missing_reference','测量设备的硬件快照缺失');return asset.definition.hardware;});
    const source=[...mfuCompute.map(c=>c.usefulOperations),cost.logicalReadBytes,cost.logicalWriteBytes,cost.hbmBytes].find(m=>m.status==='available');
    const provenance:Provenance={...(source?.provenance??{assetRefs:[],formulaRefs:[],parameterSources:[],assumptions:[]}),assumptions:[...(source?.provenance.assumptions??[]),`Measurement ${record.measurementId}, input ${record.inputHash}; time kind=${time.kind}, count=${record.count}.`,time.kind==='span'?'Span/count is interval-normalized time, not an individual call latency.':'Mean/single times multiplied by count represent cumulative work time, not a wall-clock span.','MFU uses useful work and matching peak capability per compute class; MBU uses actualBytes only when declared as measured HBM traffic.']};
    const metrics=new MetricFactory(diagnostics,provenance,scenario.scenarioId,'comparison-'+record.measurementId);
    function ratio(numerator:number,peak:number,basis:'measured'|'estimated',factory=metrics):MetricValue{
      if(!Number.isFinite(peak)||peak<=0)return factory.unavailable('numeric_overflow','利用率峰值分母超出有效浮点范围');
      let value=numerator/perCallEquivalentSeconds/peak;
      if(numerator>0&&(value===0||!Number.isFinite(value)))value=Math.exp(Math.log(numerator)-Math.log(perCallEquivalentSeconds)-Math.log(peak));
      if(numerator>0&&value===0)return factory.unavailable('numeric_overflow','利用率低于非零浮点数范围，不能报告为零');
      return factory.available(value,'ratio',basis);
    }
    const mfu=mfuCompute.map(segment=>{
      if(segment.usefulOperations.status==='unavailable')return {computeClass:segment.computeClass,value:segment.usefulOperations};
      let peak=0;
      for(const h of hardware){const matches=h.computeCapabilities.filter(c=>c.kind==='peak'&&canonical(c.computeClass)===canonical(segment.computeClass));if(matches.length!==1||!matches[0])return {computeClass:segment.computeClass,value:metrics.unavailable('missing_peak_capability','MFU 需要每个设备对应计算类别的唯一峰值，不能用有效算力替代')};peak+=matches[0].operationsPerSecond;}
      return {computeClass:segment.computeClass,value:ratio(segment.usefulOperations.quantity.value,peak,'estimated')};
    });
    let bytes:MetricValue,mbuBasis:'measured_hbm'|'estimated_hbm'|'unavailable';
    if(record.actualBytes){bytes=metrics.available((record.actualBytes.readBytes+record.actualBytes.writeBytes)/(record.actualBytes.basis==='interval_total'?record.count:1),'byte','measured');mbuBasis=bytes.status==='available'?'measured_hbm':'unavailable';}
    else {bytes=cost.hbmBytes;mbuBasis=bytes.status==='available'?'estimated_hbm':'unavailable';}
    let mbu:MetricValue;
    if(bytes.status==='unavailable')mbu=bytes;
    else {
      let peak=0,valid=true;for(const h of hardware){const matches=h.memoryCapabilities.filter(c=>c.key==='hbm'&&c.kind==='peak');if(matches.length!==1||!matches[0]){valid=false;break;}peak+=matches[0].bytesPerSecond;}
      mbu=valid?ratio(bytes.quantity.value,peak,mbuBasis==='measured_hbm'?'measured':'estimated'):metrics.unavailable('missing_peak_bandwidth','MBU 需要对应设备范围的峰值 HBM 带宽');
    }
    for(const metric of [...mfu.map(m=>m.value),mbu])if(metric.status==='available'&&metric.quantity.value>1)diagnostics.push({diagnosticId:`utilization-${diagnostics.length}`,severity:'warning',code:'utilization_above_one',message:'利用率超过 100%，保留原值；请检查模型成本、峰值与测量范围，不进行截断',location:{kind:'scenario',scenarioId:scenario.scenarioId}});
    // Append separately, preserving the original MFU/MBU values, provenance and diagnostic IDs.
    const executedCompute=cost.compute.map(segment=>{
      const numerator=segment.executedOperations;
      if(numerator.status==='unavailable')return {computeClass:segment.computeClass,value:numerator};
      const factory=new MetricFactory(diagnostics,{...numerator.provenance,assumptions:[...numerator.provenance.assumptions,`Measurement ${record.measurementId}; time kind=${time.kind}, count=${record.count}; per-call equivalent ${perCallEquivalentSeconds} second.`,
        'Executed-work utilization uses declared physical executed operations and unique matching peak capability on each actual device. It is separate from model-useful MFU and is not a measured hardware counter.']},scenario.scenarioId,'comparison-executed-'+record.measurementId);
      let peak=0;
      for(const h of hardware){const matches=h.computeCapabilities.filter(c=>c.kind==='peak'&&canonical(c.computeClass)===canonical(segment.computeClass));if(matches.length!==1||!matches[0])return {computeClass:segment.computeClass,value:factory.unavailable('missing_peak_capability','执行工作量利用率需要每个实际设备同计算类别的唯一peak能力')};peak+=matches[0].operationsPerSecond;}
      const value=ratio(numerator.quantity.value,peak,'estimated',factory);
      if(value.status==='available'&&value.quantity.value>1){const diagnosticId='executed-utilization-'+diagnostics.length;diagnostics.push({diagnosticId,severity:'warning',code:'utilization_above_one',message:'此计算类别的执行工作量利用率超过100%；请检查执行工作、测量统计区间和设备峰值。保留原值。',location:{kind:'scenario',scenarioId:scenario.scenarioId}});value.diagnosticIds.push(diagnosticId);}
      return {computeClass:segment.computeClass,value};
    });
    const measurementHash=await measurementRecordHash(record);
    return MeasurementComparisonAttempt.parse({status:'available',comparison:{measurementId:record.measurementId,inputHash:record.inputHash,measurementHash,engineVersion:result.engineVersion,scope:cost.scope,mfuScope,mbuScope:cost.scope,executedUtilization:{version:'executed-utilization.1',scope:cost.scope,compute:executedCompute},normalizedTime:{kind:time.kind,count:record.count,intervalSeconds,perCallEquivalentSeconds},mfu,mbu,mbuBasis,diagnostics}});
  }catch(e){const code=e instanceof FormulaError?e.code:'invalid_measurement',pending=['unknown_measurement_scope','unbound_measurement','measurement_input_mismatch'].includes(code);diagnostics.push({diagnosticId:'measurement-comparison-failure',severity:pending?'warning':'error',code,message:e instanceof Error?e.message:'测量比较失败',location:{kind:'scenario',scenarioId:scenario.scenarioId}});return MeasurementComparisonAttempt.parse({status:'unavailable',diagnostics});}
}
