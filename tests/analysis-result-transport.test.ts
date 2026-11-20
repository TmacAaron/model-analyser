import {expect,it} from 'vitest';
import {analyzeScenario} from '@model-analyser/core';
import {encodeAnalysisCompletion,readAnalysisCompletion} from '../apps/web/src/analysis-result-transport.js';
import {makeDecodeProject} from '../scripts/decode-project.js';
import {c01Project} from './model-fixtures.js';

async function analyzed(){
  const project=c01Project(),scenario=project.scenarios[0];
  if(!scenario)throw Error('Missing fixture configuration');
  const attempt=await analyzeScenario(scenario,project.assetSnapshots);
  if(attempt.status!=='available')throw Error('Missing fixture analysis');
  return attempt;
}

it('transfers a complete validated analysis without altering its fields',async()=>{
  const attempt=await analyzed(),reply=encodeAnalysisCompletion(attempt,17);
  if(!('payload'in reply))throw Error('Expected UTF-8 transport');
  const received=structuredClone(reply,{transfer:[reply.payload]});
  expect(reply.payload.byteLength).toBe(0);
  expect(readAnalysisCompletion(received,17)).toStrictEqual(attempt);
  expect(()=>readAnalysisCompletion(received,18)).toThrow('任务身份');
});

it('uses structured cloning for exact values outside the JSON representation',async()=>{
  const attempt=await analyzed();
  const signedZero=structuredClone(attempt),seconds=signedZero.result.total.seconds;
  if(seconds.status!=='available')throw Error('Missing fixture metric');
  seconds.quantity.value=-0;
  const explicitUndefined=structuredClone(attempt);
  explicitUndefined.result.parameterTrace=undefined;
  for(const original of [signedZero,explicitUndefined]){
    const reply=encodeAnalysisCompletion(original,3);
    expect(reply).toHaveProperty('attempt');
    expect(readAnalysisCompletion(structuredClone(reply),3)).toStrictEqual(original);
  }
});

it('rejects corrupted and ambiguous wire payloads',async()=>{
  const attempt=await analyzed(),identity={kind:'analyzed',taskId:9};
  const invalidUtf8=new Uint8Array([0xff]).buffer;
  expect(()=>readAnalysisCompletion({...identity,payload:invalidUtf8},9)).toThrow('无法读取');
  expect(()=>readAnalysisCompletion({...identity,payload:new TextEncoder().encode('{').buffer},9)).toThrow('无法读取');
  expect(()=>readAnalysisCompletion({...identity,payload:invalidUtf8,attempt},9)).toThrow('无效结果');
});

it('pools repeated Decode provenance and restores exact evidence for every metric',async()=>{
  const project=makeDecodeProject(c01Project()),attempt=await analyzeScenario(project.scenarios[0]!,project.assetSnapshots);
  if(attempt.status!=='available'||!attempt.result.decode)throw Error('Missing Decode fixture');
  const reply=encodeAnalysisCompletion(attempt,19);
  if(!('payload'in reply)||reply.encoding!=='decode-provenance.1')throw Error('Missing pooled transport');
  expect(reply.payload.byteLength).toBeLessThan(new TextEncoder().encode(JSON.stringify(attempt)).byteLength);
  expect(readAnalysisCompletion(reply,19)).toStrictEqual(attempt);
  const packet=JSON.parse(new TextDecoder().decode(reply.payload));
  packet.attempt.result.total.seconds.provenance=packet.provenance.length;
  const broken={...reply,payload:new TextEncoder().encode(JSON.stringify(packet)).buffer};
  expect(()=>readAnalysisCompletion(broken,19)).toThrow('无法读取');
});
