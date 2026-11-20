import { MeasurementComparisonReport,type AnalysisResult,type Scenario,type AssetDocument,type MeasurementRecord,type MetricValue } from '@model-analyser/contracts';
import { measurementRecordHash,stableStringify } from '@model-analyser/core';
import { measurementFrame } from './analysis-focus.js';
import type { ComparedMeasurement } from './measurement-comparison-task.js';

export async function createMeasurementReport(input:{scenario:Scenario;assets:AssetDocument[];result:AnalysisResult;records:MeasurementRecord[];items:ComparedMeasurement[];offset:number;totalRecords:number;completion:MeasurementComparisonReport['completion'];error?:string|undefined}):Promise<MeasurementComparisonReport>{
  const {scenario,assets,result,records,items,offset,totalRecords,completion,error}=input;
  if(result.scenarioId!==scenario.scenarioId||records.some(r=>r.scenarioId!==scenario.scenarioId)||new Set(records.map(r=>r.measurementId)).size!==records.length||items.length>records.length||offset%20!==0||offset+records.length>totalRecords||records.length!==Math.min(20,totalRecords-offset))throw Error('比较导出的页范围或记录集合无效。');
  if(completion==='complete'&&items.length!==records.length)throw Error('不完整的比较页不能标记完成。');
  for(const [index,item] of items.entries()){
    const record=records[index];if(!record||record.measurementId!==item.id)throw Error('比较导出的记录顺序或身份不匹配。');
    if(item.attempt.status==='available'){
      const c=item.attempt.comparison,frame=measurementFrame(result,record.inputHash)?.result??(record.inputHash===result.inputHash?result:undefined);
      const target=record.target,cost=frame?(target.kind==='model'?frame.total:target.kind==='module'?frame.modules.find(m=>m.nodeId===target.nodeId)?.cost:target.kind==='node'?frame.nodes.find(n=>n.nodeId===target.nodeId)?.cost??frame.fusions?.find(f=>f.evaluation.application.nodeId===target.nodeId)?.cost:undefined):undefined;
      if(!cost||stableStringify(c.scope)!==stableStringify(cost.scope))throw Error('比较导出的实际计算目标或范围不匹配。');
      if(!frame||c.measurementId!==record.measurementId||c.inputHash!==record.inputHash||c.engineVersion!==frame.engineVersion||c.measurementHash!==await measurementRecordHash(record)||c.scope.phase!==record.phase||stableStringify(c.scope.target)!==stableStringify(record.target)||stableStringify([...c.scope.deviceIds].sort())!==stableStringify([...record.deviceIds].sort())||c.executedUtilization&&stableStringify(c.executedUtilization.scope)!==stableStringify(c.scope))throw Error('比较导出的原记录、实际调用或结果范围不匹配。');
    }
  }
  return MeasurementComparisonReport.parse({version:'measurement-comparison-report.1',analysisEngineVersion:result.engineVersion,rootInputHash:result.inputHash,scenario,assets,page:{offset,pageSize:20,totalRecords},completion,...(error?{error}:{}),entries:records.map((record,i)=>({record,...(items[i]?{attempt:items[i]!.attempt}:{})}))});
}

const columns=['report_version','root_input_hash','analysis_engine','scenario_id','page_offset','page_total_records','page_completion','page_error','record_index','measurement_id','record_input_hash','comparison_input_hash','measurement_hash','entry_status','metric','compute_class','metric_scope','value','unit','basis','diagnostic_ids','diagnostics','time_kind','count','record_time','interval_seconds','per_call_seconds','actual_bytes_basis','actual_read_bytes','actual_write_bytes','record_target','record_phase','record_device_ids','record_interval'] as const;
export function measurementReportCsv(input:MeasurementComparisonReport){
  const report=MeasurementComparisonReport.parse(input),rows:Record<string,string|number>[]=[];
  for(const [index,entry] of report.entries.entries()){
    const r=entry.record,c=entry.attempt?.status==='available'?entry.attempt.comparison:undefined;
    const base:Record<string,string|number>={report_version:report.version,root_input_hash:report.rootInputHash,analysis_engine:report.analysisEngineVersion,scenario_id:report.scenario.scenarioId,page_offset:report.page.offset,page_total_records:report.page.totalRecords,page_completion:report.completion,page_error:report.error??'',record_index:report.page.offset+index,measurement_id:r.measurementId,record_input_hash:r.inputHash??'',comparison_input_hash:c?.inputHash??'',measurement_hash:c?.measurementHash??'',entry_status:entry.attempt?.status??'pending',time_kind:r.time.kind,count:r.count,record_time:JSON.stringify(r.time),interval_seconds:c?.normalizedTime.intervalSeconds??'',per_call_seconds:c?.normalizedTime.perCallEquivalentSeconds??'',actual_bytes_basis:r.actualBytes?.basis??'',actual_read_bytes:r.actualBytes?.readBytes??'',actual_write_bytes:r.actualBytes?.writeBytes??'',record_target:JSON.stringify(r.target),record_phase:r.phase,record_device_ids:JSON.stringify(r.deviceIds),record_interval:r.interval};
    const append=(metric:string,value:MetricValue|undefined,scope:unknown,cls?:unknown)=>rows.push({...base,metric,compute_class:cls?JSON.stringify(cls):'',metric_scope:scope?JSON.stringify(scope):'',value:value?.status==='available'?value.quantity.value:'',unit:'ratio',basis:value?.status==='available'?value.basis:'',diagnostic_ids:JSON.stringify(value?.diagnosticIds??[]),diagnostics:JSON.stringify(c?.diagnostics??(entry.attempt?.status==='unavailable'?entry.attempt.diagnostics:[]))});
    if(!c){append(entry.attempt?'comparison_unavailable':'comparison_pending',undefined,undefined);continue;}
    for(const item of c.mfu)append('model_useful_mfu',item.value,c.mfuScope??c.scope,item.computeClass);
    if(!c.mfu.length)append('model_work_no_declared_segments',undefined,c.mfuScope??c.scope);
    if(c.executedUtilization){for(const item of c.executedUtilization.compute)append('executed_work_utilization',item.value,c.executedUtilization.scope,item.computeClass);if(!c.executedUtilization.compute.length)append('executed_work_no_declared_segments',undefined,c.executedUtilization.scope);}
    else append('executed_evidence_missing',undefined,c.scope);
    append('mbu_'+c.mbuBasis,c.mbu,c.mbuScope??c.scope);
  }
  const quote=(value:unknown)=>'"'+String(value??'').replaceAll('"','""')+'"';
  return [columns.map(quote).join(','),...rows.map(row=>columns.map(key=>quote(row[key])).join(','))].join('\r\n')+'\r\n';
}
