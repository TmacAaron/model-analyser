import {AnalysisAttempt,MetricScope,type AnalysisResult} from '@model-analyser/contracts';

export type AnalysisCompletion={kind:'analyzed';taskId:number}&({attempt:AnalysisAttempt}|{payload:ArrayBuffer});
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const resultArrays=['nodes','modules','memory','schedule','roofline','diagnostics'] as const;
const optionalResultArrays=['memoryEvidence','parameterTrace','quantizationApplications','fusions'] as const;
const scalarTotals=['seconds','logicalReadBytes','logicalWriteBytes','hbmBytes'] as const;

/** Transfer the bytes of a JSON result and retain exact non-JSON values via structured cloning. */
export function encodeAnalysisCompletion(attempt:AnalysisAttempt,taskId:number):AnalysisCompletion{
  const identity={kind:'analyzed' as const,taskId};
  if(attempt.status==='available'){
    try{
      const json=JSON.stringify(attempt,(_key,value:unknown)=>{
        if(value===undefined||typeof value==='number'&&(!Number.isFinite(value)||Object.is(value,-0)))throw Error('The result requires structured cloning');
        return value;
      });
      return {...identity,payload:new TextEncoder().encode(json).buffer};
    }catch{/* The original validated attempt is still available for structured cloning. */}
  }
  return {...identity,attempt};
}

function decodeAttempt(data:Record<string,unknown>):unknown{
  if(!('payload'in data))return data.attempt;
  if('attempt'in data||!(data.payload instanceof ArrayBuffer)||!data.payload.byteLength)throw Error('分析线程返回了无效结果');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data.payload));}
  catch{throw Error('分析线程返回了无法读取的结果');}
}

function isMetricEnvelope(value:unknown){
  return record(value)&&Array.isArray(value.diagnosticIds)&&(value.status==='unavailable'||value.status==='available'&&
    record(value.quantity)&&typeof value.quantity.value==='number'&&typeof value.quantity.unit==='string'&&record(value.provenance));
}

export function isAnalysisResultEnvelope(value:unknown):value is AnalysisResult{
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
    const attempt=decodeAttempt(data);
    if(record(attempt)&&attempt.status==='available'){
      if(!isAnalysisResultEnvelope(attempt.result))throw Error('分析线程返回了无效结果');
      return {status:'available',result:attempt.result};
    }
    data=attempt;
  }
  const parsed=AnalysisAttempt.safeParse(data);
  if(!parsed.success)throw Error('分析线程返回了无效结果');
  return parsed.data;
}
