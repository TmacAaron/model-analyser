import type { AnalysisResult,Scenario,AssetDocument,MeasurementRecord,MeasurementComparison,MetricValue } from '@model-analyser/contracts';
import { stableStringify } from '@model-analyser/core';
import { measurementFrame } from './analysis-focus.js';
import type { ScalarEvidence,ScalarOperand,ScalarContext } from './scalar-source.js';
export type MeasurementSourceField={kind:'mfu';index:number}|{kind:'executed';index:number}|{kind:'mbu'};
export function measurementScalarSource(record:MeasurementRecord,comparison:MeasurementComparison,result:AnalysisResult,scenario:Scenario,assets:AssetDocument[],field:MeasurementSourceField):{evidence:ScalarEvidence;context:ScalarContext}|{problem:string}{
  const child=measurementFrame(result,record.inputHash??''),frame:AnalysisResult|undefined=child?.result??(result.inputHash===record.inputHash?result:undefined),actualScenario=child?.scenario??scenario;
  if(!frame||comparison.measurementId!==record.measurementId||comparison.inputHash!==record.inputHash||frame.inputHash!==comparison.inputHash)return {problem:'测量来源缺少精确匹配的记录与实际调用，未回退序列或另一输入。'};
  const target=record.target;if(target.kind==='unmapped')return {problem:'原测量尚未映射。'};
  const cost=target.kind==='model'?frame.total:target.kind==='module'?frame.modules.find(m=>m.nodeId===target.nodeId)?.cost:frame.nodes.find(n=>n.nodeId===target.nodeId)?.cost??frame.fusions?.find(f=>f.evaluation.application.nodeId===target.nodeId)?.cost;
  if(!cost)return {problem:'请求的实际测量目标不存在。'};if(record.scenarioId!==actualScenario.scenarioId||record.phase!==frame.phase||stableStringify(comparison.scope)!==stableStringify(cost.scope)||stableStringify([...record.deviceIds].sort())!==stableStringify([...cost.scope.deviceIds].sort()))return {problem:'测量记录与实际调用的阶段、设备或目标范围不匹配。'};if(field.kind==='executed'&&(!comparison.executedUtilization||stableStringify(comparison.executedUtilization.scope)!==stableStringify(cost.scope)))return {problem:'此比较没有匹配实际范围的执行工作量利用率，请重新比较。'};
  const context:ScalarContext={assets,parameters:frame.parameterTrace,diagnostics:comparison.diagnostics,inputHash:frame.inputHash,scope:JSON.stringify(field.kind==='mfu'?comparison.mfuScope??comparison.scope:field.kind==='executed'?comparison.executedUtilization!.scope:comparison.mbuScope??comparison.scope),missingParameterReason:frame.decode?'序列汇总参数属于各实际调用，未用某一步补填。':undefined};
  const time=comparison.normalizedTime,operands:ScalarOperand[]=[{label:'原始统计次数',value:time.count,unit:'count'},{label:'原始统计区间秒数',value:time.intervalSeconds,unit:'second',note:'kind='+time.kind+'；span/count是区间归一化，不等同单次延迟。'},{label:'每调用等效秒数',value:time.perCallEquivalentSeconds,unit:'second'}];
  const hardware=record.deviceIds.map(id=>{const device=actualScenario.deviceTopology.devices.find(d=>d.deviceId===id),asset=device?assets.find(a=>a.assetId===device.hardware.assetId&&a.revision===device.hardware.revision&&a.definition.kind==='hardware'):undefined;return {id,device,asset};});
  const recordProof={record,normalizedTime:time,mfuScope:comparison.mfuScope,mbuScope:comparison.mbuScope,hardware:hardware.map(h=>({deviceId:h.id,ref:h.device?.hardware,sources:h.asset?.sources,definition:h.asset?.definition})),comparison};
  let value:MetricValue,expression:string;
  if(field.kind!=='mbu'){
    const executed=field.kind==='executed',item=executed?comparison.executedUtilization?.compute[field.index]:comparison.mfu[field.index];if(!item)return {problem:'请求的完整计算类别不存在。'};
    value=item.value;const logical=(frame.decode?.logicalCompute??frame.distributed?.logicalCompute)?.find(c=>stableStringify(c.scope.target)===stableStringify(cost.scope.target));if(!executed&&(frame.decode||frame.distributed)&&!logical)return {problem:'缺少同范围的模型有效工作量，不改用物理执行工作。'};const compute=executed?cost.compute:logical?.compute??cost.compute,segment=compute.find(c=>stableStringify(c.computeClass)===stableStringify(item.computeClass));
    if(!segment)return {problem:'缺少同范围的有效工作量，未改用物理执行工作。'};
    operands.unshift({label:executed?'同范围该类实际执行工作':'同范围该类模型有效工作（未按复制设备倍增）',metric:executed?segment.executedOperations:segment.usefulOperations});
    for(const h of hardware){const matches=h.asset?.definition.kind==='hardware'?h.asset.definition.hardware.computeCapabilities.filter(c=>c.kind==='peak'&&stableStringify(c.computeClass)===stableStringify(item.computeClass)):[];operands.push({label:h.id+' 唯一匹配峰值能力',value:matches.length===1&&matches[0]?.kind==='peak'?matches[0].operationsPerSecond:undefined,unit:'operation_per_second',note:h.device?h.device.hardware.assetId+'@r'+h.device.hardware.revision:'固定设备缺失'});}
    expression=executed?'执行工作量利用率 = 该范围实际执行operations / 每调用等效秒数 / Σ实际设备同类peak operation/s。该工作量来自执行成本，不由有效MFU或复制倍数推导。':'该类有效工作利用率 = 有效operations / 每调用等效秒数 / Σ实际设备同类peak operation/s。不得用effective算力替代，不合并整数与浮点分类。';
  }else{
    value=comparison.mbu;
    if(record.actualBytes){const b=record.actualBytes;operands.unshift({label:'原始实测读bytes',value:b.readBytes,unit:'byte'},{label:'原始实测写bytes',value:b.writeBytes,unit:'byte'},{label:'实测bytes除数',value:b.basis==='interval_total'?record.count:1,unit:'count',note:'basis='+b.basis});}
    else operands.unshift({label:'估算HBM（没有实测bytes）',metric:cost.hbmBytes});
    for(const h of hardware){const matches=h.asset?.definition.kind==='hardware'?h.asset.definition.hardware.memoryCapabilities.filter(c=>c.key==='hbm'&&c.kind==='peak'):[];operands.push({label:h.id+' 唯一峰值HBM带宽',value:matches.length===1&&matches[0]?.kind==='peak'?matches[0].bytesPerSecond:undefined,unit:'byte_per_second',note:h.device?h.device.hardware.assetId+'@r'+h.device.hardware.revision:'固定设备缺失'});}
    expression=record.actualBytes?'MBU = ((实测读bytes + 实测写bytes) / bytes除数) / 每调用等效秒数 / Σ实际设备peak HBM byte/s。':'估算MBU = 同范围估算HBM bytes / 每调用等效秒数 / Σ实际设备peak HBM byte/s。';
  }
  return {context,evidence:{kind:'derived',label:field.kind==='mfu'?'该类有效工作利用率':field.kind==='executed'?'该类执行工作量利用率':'MBU · '+comparison.mbuBasis,value:value.status==='available'?value.quantity.value:undefined,unit:'ratio',metric:value,expression,operands,record:recordProof,note:'按原比较结果解释实际统计归一化与同范围分子、分母；超过100%不裁剪，缺峰值不补有效能力。'}};
}
