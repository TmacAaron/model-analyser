import { Diagnostic,ScenarioComparisonRequest,Unit,type Scenario,type ScenarioComparisonAttempt,type ScenarioComparisonResult } from '@model-analyser/contracts';
import { ENGINE_VERSION,stableStringify } from '@model-analyser/core';
import { z } from 'zod';
import { isAnalysisResultEnvelope } from './analysis-result-transport.js';
import { comparisonRows } from './comparison-metrics.js';

const visibleRowLimit=300;
const Preview=z.strictObject({
  rowCount:z.number().int().min(1),
  rows:z.array(z.strictObject({
    key:z.string().min(1),label:z.string().min(1),unit:Unit,
    values:z.array(z.number().optional()).min(1).max(4),
  })).max(visibleRowLimit),
});
export type ComparisonPreview=z.infer<typeof Preview>;
export type ComparisonCompletion={kind:'result';runId:number;attempt:ScenarioComparisonAttempt;preview?:ComparisonPreview};
const record=(input:unknown):input is Record<string,unknown>=>input!==null&&typeof input==='object'&&!Array.isArray(input);
const failedAttempt=z.strictObject({status:z.literal('unavailable'),diagnostics:z.array(Diagnostic).min(1)});

export function createComparisonCompletion(attempt:ScenarioComparisonAttempt,runId:number):ComparisonCompletion{
  if(attempt.status==='unavailable')return {kind:'result',runId,attempt};
  const rows=comparisonRows(attempt.result);
  const preview:ComparisonPreview={
    rowCount:rows.length,rows:rows.slice(0,visibleRowLimit).map(row=>({...row,unit:Unit.parse(row.unit)})),
  };
  return {kind:'result',runId,preview,attempt};
}

function validScan(scan:unknown,result:Record<string,unknown>,scenario:Scenario,wanted:ScenarioComparisonRequest){
  if(scan===undefined)return !wanted.scan||result.completion==='cancelled';
  if(!wanted.scan||!record(scan))return false;
  if(scan.status==='unavailable')return Array.isArray(scan.diagnostics)&&scan.diagnostics.length>0;
  if(scan.status!=='available'||!record(scan.result))return false;
  const value=scan.result;
  return value.engineVersion===ENGINE_VERSION&&record(value.baseScenario)&&value.baseScenario.scenarioId===scenario.scenarioId&&
    record(value.request)&&stableStringify(value.request)===stableStringify(wanted.scan)&&
    Array.isArray(value.points)&&value.points.length<=512&&record(value.capacityStatus)&&Array.isArray(value.diagnostics);
}

/** The bundled worker has already run the full structural and semantic checks. Keep reply validation bounded on the UI thread. */
function readReport(data:unknown,wanted:ScenarioComparisonRequest,scenarios:Scenario[]):ScenarioComparisonResult{
  if(!record(data)||data.version!=='scenario-comparison.1'||data.engineVersion!==ENGINE_VERSION||
    !Array.isArray(data.assets)||!Array.isArray(data.entries)||!Array.isArray(data.pairs)||!Array.isArray(data.assumptions)||
    data.completion!=='complete'&&data.completion!=='cancelled')throw Error('比较线程返回无效结果');
  const actual=ScenarioComparisonRequest.safeParse(data.request);
  if(!actual.success||stableStringify(actual.data)!==stableStringify(wanted))throw Error('比较回复与当前请求不同');
  if(data.entries.length===0||data.entries.length>wanted.scenarioIds.length||
    data.completion==='complete'&&data.entries.length!==wanted.scenarioIds.length)throw Error('比较回复的配置数量无效');
  const pairs=wanted.scan?data.entries.length*(data.entries.length-1)/2:0;
  if(data.pairs.length!==pairs||data.pairs.some(pair=>!record(pair)||typeof pair.leftScenarioId!=='string'||
    typeof pair.rightScenarioId!=='string'||!Array.isArray(pair.crossings))||
    data.assumptions.some(assumption=>typeof assumption!=='string'))throw Error('比较回复的扫描或假设结构无效');

  for(const [index,entry] of data.entries.entries()){
    const scenario=scenarios.find(item=>item.scenarioId===wanted.scenarioIds[index]);
    if(!scenario||!record(entry)||!record(entry.scenario)||entry.scenario.scenarioId!==scenario.scenarioId||
      !record(entry.scenario.model)||!record(entry.scenario.workload)||
      stableStringify(entry.scenario.model)!==stableStringify(scenario.model)||
      stableStringify(entry.scenario.workload)!==stableStringify(scenario.workload)||
      !Array.isArray(entry.changes)||!record(entry.analysis))throw Error('比较回复与当前配置不同');
    const analysis=entry.analysis;
    if(analysis.status==='available'){
      if(!isAnalysisResultEnvelope(analysis.result)||analysis.result.engineVersion!==ENGINE_VERSION||
        analysis.result.scenarioId!==scenario.scenarioId||analysis.result.phase!==scenario.workload.kind||
        !/^[0-9a-f]{64}$/i.test(analysis.result.inputHash))throw Error('比较回复的分析身份或结构无效');
    }else if(analysis.status!=='unavailable'||!Array.isArray(analysis.diagnostics)||!analysis.diagnostics.length){
      throw Error('比较回复的分析结构无效');
    }
    if(!validScan(entry.scan,data,scenario,wanted))throw Error('比较回复的扫描结构无效');
  }
  return data as unknown as ScenarioComparisonResult;
}

export function readComparisonCompletion(data:unknown,runId:number,wanted:ScenarioComparisonRequest,scenarios:Scenario[]):{
  attempt:ScenarioComparisonAttempt;preview?:ComparisonPreview;
}{
  if(!record(data)||data.kind!=='result'||data.runId!==runId)throw Error('比较回复的任务身份不同');
  const attempt=data.attempt;
  if(record(attempt)&&attempt.status==='available'){
    const result=readReport(attempt.result,wanted,scenarios);
    if(!record(data.preview)||!Array.isArray(data.preview.rows)||data.preview.rows.length>visibleRowLimit)throw Error('比较回复的指标表无效');
    const preview=Preview.safeParse(data.preview);
    if(!preview.success||preview.data.rows.length!==Math.min(visibleRowLimit,preview.data.rowCount)||
      preview.data.rows.some(row=>row.values.length!==result.entries.length)||
      new Set(preview.data.rows.map(row=>row.key)).size!==preview.data.rows.length)throw Error('比较回复的指标表无效');
    return {attempt:{status:'available',result},preview:preview.data};
  }
  const failure=failedAttempt.safeParse(attempt);
  if(!failure.success)throw Error('比较线程返回无效结果');
  return {attempt:failure.data};
}
