import { expect,it } from 'vitest';
import { compareScenarios } from '@model-analyser/core';
import { createComparisonCompletion,readComparisonCompletion } from '../apps/web/src/comparison-result-transport.js';
import { comparisonRows } from '../apps/web/src/comparison-metrics.js';
import { makeComparisonProject } from '../scripts/comparison-project.js';
import { c01Project } from './model-fixtures.js';

async function comparison(cancelled=false){
  const project=makeComparisonProject(c01Project()),scenarioIds=project.scenarios.slice(0,2).map(s=>s.scenarioId);
  const request={scenarioIds,...(cancelled?{scan:{variable:{kind:'parameter' as const,parameterKey:'X'},searchRange:{min:1,max:4}}}:{})};
  let stop=false;
  const attempt=await compareScenarios(project.scenarios,project.assetSnapshots,request,{
    isCancelled:()=>stop,onProgress:completed=>{if(cancelled&&completed>=2)stop=true;},
  });
  if(attempt.status!=='available')throw Error('Expected fixture report');
  return {attempt,request,scenarios:project.scenarios};
}

it('receives the validated report and preserves the bounded table',async()=>{
  const {attempt,request,scenarios}=await comparison(),reply=createComparisonCompletion(attempt,5);
  const received=structuredClone(reply);
  const rows=comparisonRows(attempt.result);
  expect(readComparisonCompletion(received,5,request,scenarios)).toStrictEqual({
    attempt,preview:{rowCount:rows.length,rows:rows.slice(0,300)},
  });
});

it('preserves non-JSON values through cloning and accepts the actual cancelled prefix',async()=>{
  const {attempt,request,scenarios}=await comparison(true);
  expect(attempt.result.completion).toBe('cancelled');
  expect(attempt.result.entries).toHaveLength(1);
  const analysis=attempt.result.entries[0]!.analysis;
  if(analysis.status!=='available'||analysis.result.total.seconds.status!=='available')throw Error('Missing timed entry');
  analysis.result.total.seconds.quantity.value=-0;
  analysis.result.parameterTrace=undefined;
  const reply=createComparisonCompletion(attempt,6);
  const received=readComparisonCompletion(structuredClone(reply),6,request,scenarios);
  expect(received.attempt).toStrictEqual(attempt);
  expect(received.preview?.rows.find(row=>row.key==='seconds')?.values[0]).toBe(-0);
});

it('rejects the wrong run, request, phase, corrupted report and mismatched row shape',async()=>{
  const {attempt,request,scenarios}=await comparison(),reply=createComparisonCompletion(attempt,7);
  expect(()=>readComparisonCompletion(reply,8,request,scenarios)).toThrow('任务身份');
  expect(()=>readComparisonCompletion(reply,7,{scenarioIds:[...request.scenarioIds].reverse()},scenarios)).toThrow('当前请求');
  expect(()=>readComparisonCompletion({...reply,attempt:{status:'available',result:null}},7,request,scenarios)).toThrow('无效结果');
  expect(()=>readComparisonCompletion({...reply,preview:{rowCount:400,rows:reply.preview?.rows}},7,request,scenarios)).toThrow('指标表无效');
  const invalidAssumptions=structuredClone(attempt);
  Reflect.set(invalidAssumptions.result,'assumptions',[null]);
  expect(()=>readComparisonCompletion(createComparisonCompletion(invalidAssumptions,7),7,request,scenarios)).toThrow('假设结构');
  const bad=structuredClone(attempt),analysis=bad.result.entries[0]!.analysis;
  if(analysis.status!=='available')throw Error('Missing analysed fixture');
  analysis.result.phase=analysis.result.phase==='decode'?'prefill':'decode';
  expect(()=>readComparisonCompletion(createComparisonCompletion(bad,7),7,request,scenarios)).toThrow('分析身份');
});
