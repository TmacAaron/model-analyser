import {expect,it} from 'vitest';
import {analyzeScenario} from '@model-analyser/core';
import {analysisCompletionTransfers,encodeAnalysisCompletion,readAnalysisCompletion} from '../apps/web/src/analysis-result-transport.js';
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
  expect(await readAnalysisCompletion(received,17)).toStrictEqual(attempt);
  await expect(readAnalysisCompletion(received,18)).rejects.toThrow('任务身份');
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
    expect(await readAnalysisCompletion(structuredClone(reply),3)).toStrictEqual(original);
  }
});

it('rejects corrupted and ambiguous wire payloads',async()=>{
  const attempt=await analyzed(),identity={kind:'analyzed',taskId:9};
  const invalidUtf8=new Uint8Array([0xff]).buffer;
  await expect(readAnalysisCompletion({...identity,payload:invalidUtf8},9)).rejects.toThrow('无法读取');
  await expect(readAnalysisCompletion({...identity,payload:new TextEncoder().encode('{').buffer},9)).rejects.toThrow('无法读取');
  await expect(readAnalysisCompletion({...identity,payload:invalidUtf8,attempt},9)).rejects.toThrow('无效结果');
});

it('transfers Decode sections and restores nested arrays and shared provenance exactly',async()=>{
  const project=makeDecodeProject(c01Project()),attempt=await analyzeScenario(project.scenarios[0]!,project.assetSnapshots);
  if(attempt.status!=='available'||!attempt.result.decode)throw Error('Missing Decode fixture');
  const [first,second]=attempt.result.decode.steps;
  if(!first||!second)throw Error('Expected two Decode steps');
  first.result.nodes=Array.from({length:130},()=>first.result.nodes[0]!);
  attempt.result.decode.steps=[first,...Array.from({length:129},()=>second)];
  const reply=encodeAnalysisCompletion(attempt,19);
  if(!('segments'in reply))throw Error('Missing segmented transport');
  const buffers=analysisCompletionTransfers(reply),received=structuredClone(reply,{transfer:buffers});
  expect(buffers.every(buffer=>buffer.byteLength===0)).toBe(true);
  expect(received.segments.sections.length).toBeGreaterThan(1);
  expect(await readAnalysisCompletion(received,19)).toStrictEqual(attempt);
  await expect(readAnalysisCompletion({...received,attempt},19)).rejects.toThrow('无效结果');
  const badRows={...received.segments,sections:[[new TextEncoder().encode('[{"$analysisRows":0}]').buffer],
    ...received.segments.sections.slice(1)]};
  await expect(readAnalysisCompletion({...received,segments:badRows},19)).rejects.toThrow('无法读取');
  let reads=0;
  await expect(readAnalysisCompletion(received,19,()=>++reads<4)).rejects.toThrow('无法读取');
  expect(reads).toBe(4);
});

it('accepts older pooled reports and rejects broken provenance references',async()=>{
  const attempt=await analyzed(),provenance:unknown[]=[];
  const json=JSON.stringify(attempt,function(this:{status?:string},key,value:unknown){
    return key==='provenance'&&this.status==='available'?provenance.push(value)-1:value;
  });
  const packet={provenance,attempt:JSON.parse(json)};
  const reply={kind:'analyzed',taskId:19,encoding:'decode-provenance.1'};
  const payload=()=>new TextEncoder().encode(JSON.stringify(packet)).buffer;
  expect(await readAnalysisCompletion({...reply,payload:payload()},19)).toStrictEqual(attempt);
  packet.attempt.result.total.seconds.provenance=provenance.length;
  await expect(readAnalysisCompletion({...reply,payload:payload()},19)).rejects.toThrow('无法读取');
});
