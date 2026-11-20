import { MeasurementImportPreviewRequest,MeasurementImportPreview,MeasurementRecord,type MeasurementImportRow,type AnalysisResult,type Scenario,type AssetDocument } from '@model-analyser/contracts';
import { canonical } from '../../contracts/src/validation.js';
import { compareMeasurement } from './measurement.js';
import { checkMeasurementFile,sameMeasurement } from '../../contracts/src/measurement-file.js';

/** Missing identities stay pending. A trial binding only checks eligibility; it never changes the file. */
export async function previewMeasurementImport(input:MeasurementImportPreviewRequest):Promise<MeasurementImportPreview>{
  const r=MeasurementImportPreviewRequest.parse(input),rows:MeasurementImportRow[]=[];checkMeasurementFile(r.file);let newRecordCount=0;
  for(const m of r.file.records){
    const old=r.existing.find(x=>x.measurementId===m.measurementId);if(old){const same=sameMeasurement(old,m);rows.push({measurementId:m.measurementId,status:same?'duplicate':'conflict',message:same?'已有同 ID/同内容记录，将跳过，不再次计数':'同 ID 内容冲突，请保留已有记录或明确创建新 ID'});continue;}
    newRecordCount++;if(!r.result){rows.push({measurementId:m.measurementId,status:'needs_analysis',message:'可保留原记录；先计算当前方案才能核对输入版本、范围和利用率'});continue;}
    if(m.target.kind==='unmapped'){rows.push({measurementId:m.measurementId,status:'unmatched',message:'目标尚未映射，保留原事件；不会按显示名称猜测节点'});continue;}
    const attempt=await compareMeasurement(m.inputHash?m:{...m,inputHash:r.result.inputHash},r.scenario,r.result,r.assets);
    if(attempt.status==='available')rows.push(m.inputHash?{measurementId:m.measurementId,status:'ready',message:'输入版本、阶段、目标及物理设备范围匹配',comparison:attempt.comparison}:{measurementId:m.measurementId,status:'needs_confirmation',message:'目标和范围可匹配；尚无 inputHash，需明确确认后才能绑定当前输入并计算指标'});
    else rows.push({measurementId:m.measurementId,status:attempt.diagnostics.at(-1)?.code==='measurement_input_mismatch'?'stale':'unmatched',message:attempt.diagnostics.at(-1)?.message??'不能匹配当前理论结果'});
  }
  return MeasurementImportPreview.parse({version:'measurement-import.1',rows,canApply:!rows.some(r=>r.status==='conflict'),newRecordCount});
}
/** Called only by an explicit user confirmation; rejects stale hashes and incompatible phase/device ranges. */
export async function confirmMeasurementBinding(record:MeasurementRecord,scenario:Scenario,result:AnalysisResult,assets:AssetDocument[],target?:MeasurementRecord['target']):Promise<MeasurementRecord>{
  if(record.inputHash)throw Error('已有 inputHash 的记录保留原版本；不能自动重绑定历史测量');
  const candidate=MeasurementRecord.parse({...record,...(target?{target,scenarioId:scenario.scenarioId}:{}),inputHash:result.inputHash,source:{...record.source,mappingBasis:[record.source.mappingBasis,`User confirmed current input ${result.inputHash}, target ${canonical(target??record.target)}, phase ${record.phase}, devices ${record.deviceIds.join(',')}.`].filter(Boolean).join('\n')}}),attempt=await compareMeasurement(candidate,scenario,result,assets);
  if(attempt.status==='unavailable')throw Error(attempt.diagnostics.at(-1)?.message??'当前结果不匹配');return candidate;
}
