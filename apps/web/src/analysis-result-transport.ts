import {AnalysisAttempt,MetricScope,type AnalysisResult} from '@model-analyser/contracts';

export type AnalysisCompletion={kind:'analyzed';taskId:number;attempt:AnalysisAttempt};
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const resultArrays=['nodes','modules','memory','schedule','roofline','diagnostics'] as const;
const optionalResultArrays=['memoryEvidence','parameterTrace','quantizationApplications','fusions'] as const;
const scalarTotals=['seconds','logicalReadBytes','logicalWriteBytes','hbmBytes'] as const;

function isMetricEnvelope(value:unknown){
  return record(value)&&Array.isArray(value.diagnosticIds)&&(value.status==='unavailable'||value.status==='available'&&
    record(value.quantity)&&typeof value.quantity.value==='number'&&typeof value.quantity.unit==='string'&&record(value.provenance));
}

function isResultEnvelope(value:unknown):value is AnalysisResult{
  if(!record(value)||typeof value.inputHash!=='string'||typeof value.engineVersion!=='string'||typeof value.scenarioId!=='string'||
    (value.phase!=='prefill'&&value.phase!=='decode')||!MetricScope.safeParse(value.scope).success||
    !record(value.total)||!Array.isArray(value.total.compute))return false;
  const {total}=value;
  if(!scalarTotals.every(key=>isMetricEnvelope(total[key])))return false;
  if(!resultArrays.every(key=>Array.isArray(value[key]))||!optionalResultArrays.every(key=>value[key]===undefined||Array.isArray(value[key])))return false;
  const {decode,distributed}=value;
  return (decode===undefined||record(decode)&&Array.isArray(decode.steps)&&Array.isArray(decode.logicalCompute))&&
    (distributed===undefined||record(distributed)&&record(distributed.layout)&&Array.isArray(distributed.logicalCompute));
}

/** The bundled analysis worker returns the graph validated by the core contract. */
export function readAnalysisCompletion(data:unknown,taskId:number):AnalysisAttempt{
  if(record(data)&&data.kind==='analyzed'){
    if(data.taskId!==taskId)throw Error('分析回复的任务身份与当前请求不同');
    const attempt=data.attempt;
    if(record(attempt)&&attempt.status==='available'){
      if(!isResultEnvelope(attempt.result))throw Error('分析线程返回了无效结果');
      return {status:'available',result:attempt.result};
    }
    data=attempt;
  }
  const parsed=AnalysisAttempt.safeParse(data);
  if(!parsed.success)throw Error('分析线程返回了无效结果');
  return parsed.data;
}
