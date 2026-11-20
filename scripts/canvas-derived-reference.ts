import assert from 'node:assert/strict';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { ProjectDocument,NodeId } from '@model-analyser/contracts';
import { analyzeScenario,computeInputHash } from '@model-analyser/core';
import { buildManualMeasurement,emptyManualMeasurement,manualFrame } from '../apps/web/src/manual-measurement.js';
import { runMeasurementComparisons,type MeasurementComparisonMessage } from '../apps/web/src/measurement-comparison-task.js';
import { timelineContext,inTimelineContext } from '../apps/web/src/timeline-context.js';
import { resolveSourceSelection } from '../apps/web/src/cost-source-view.js';
import { makeStreamProject } from './stream-project.js';
import { makeFusedProject } from './fused-project.js';
import { makeDecodeProject } from './decode-project.js';
const base=ProjectDocument.parse(JSON.parse(await readFile('examples/contracts/project.json','utf8'))),dir='examples/canvas-derived';await mkdir(dir,{recursive:true});
const evidence=[];
for(const [name,p] of [['c01-page',base],['c05-stream',makeStreamProject(base)],['atomic-fusion',makeFusedProject(base)],['decode-third',makeDecodeProject(base)]] as const){
  const s=p.scenarios[0];if(!s)throw Error();const analysis=await analyzeScenario(s,p.assetSnapshots);if(analysis.status!=='available')throw Error(JSON.stringify(analysis));const result=analysis.result,before=await computeInputHash(s,p.assetSnapshots),frame=manualFrame(result,s,result.decode?'2':'all');
  p.measurements=Array.from({length:name==='c01-page'?20:1},(_,index)=>buildManualMeasurement({...emptyManualMeasurement(),seconds:'5',step:result.decode?'2':'all'},{kind:'model'},s,result,name+'-'+index,frame.result.scope.deviceIds));const messages:MeasurementComparisonMessage[]=[];
  await runMeasurementComparisons({scenario:s,assets:p.assetSnapshots,result,records:p.measurements},message=>messages.push(message));assert.equal(messages.filter(m=>m.kind==='item'&&m.attempt.status==='available').length,p.measurements.length);assert.deepEqual(messages.at(-1),{kind:'complete',count:p.measurements.length});
  let timelineProof:unknown;
  if(name==='c05-stream'){
    const context=timelineContext(result,{key:'B',label:'B',target:{kind:'node',nodeId:NodeId.parse('B')}}),execution=result.distributed?.layout.execution;if(execution?.status!=='available')throw Error();const steps=execution.result.steps.filter(step=>inTimelineContext(context,step.nodeId));assert.deepEqual(steps.map(step=>step.nodeId),['B']);assert.equal(steps[0]?.startSeconds,.001);assert.equal(steps[0]?.endSeconds,.006);assert.equal(execution.result.makespan.status,'available');if(execution.result.makespan.status==='available')assert.ok(Math.abs(execution.result.makespan.quantity.value-.0065)<1e-12);timelineProof={selected:'B',startSeconds:.001,endSeconds:.006,globalMakespanSeconds:.0065,originalOrdinal:execution.result.steps.findIndex(step=>step.nodeId==='B')+1};assert.equal((timelineProof as {originalOrdinal:number}).originalOrdinal,3);
  }else if(name==='atomic-fusion'){
    const context=timelineContext(result,{key:'A',label:'A',target:{kind:'node',nodeId:NodeId.parse('A')}}),group=result.fusions?.[0]?.evaluation.application.nodeId;assert.ok(group);assert.equal(context.atomic,true);assert.equal(inTimelineContext(context,group),true);timelineProof={selected:'A',wholeExecutionUnit:group};
  }else if(name==='decode-third'){
    assert.equal(p.measurements[0]?.inputHash,result.decode?.steps[2]?.result.inputHash);assert.notEqual(p.measurements[0]?.inputHash,result.inputHash);assert.equal(resolveSourceSelection(result,'99','model','seconds').metric,undefined);const context=timelineContext(result,{key:'update',label:'update',target:{kind:'node',nodeId:NodeId.parse('update')}}),bars=result.schedule.filter(entry=>inTimelineContext(context,entry.nodeId,entry.decodeStepIndex));assert.deepEqual(bars.map(e=>e.decodeStepIndex),[0,1,2]);timelineProof={steps:bars,actualThirdHash:p.measurements[0]?.inputHash};
  }else{
    const item=messages[0];if(item?.kind!=='item'||item.attempt.status!=='available')throw Error();const mfu=item.attempt.comparison.mfu[0]?.value,mbu=item.attempt.comparison.mbu;assert.equal(mfu?.status,'available');if(mfu?.status==='available')assert.ok(Math.abs(mfu.quantity.value-.2048)<1e-12);assert.equal(mbu.status,'available');if(mbu.status==='available')assert.ok(Math.abs(mbu.quantity.value-.896)<1e-12);timelineProof={mfu:.2048,estimatedMbu:.896,records:20};
  }
  assert.equal(result.inputHash,before);assert.equal(await computeInputHash(s,p.assetSnapshots),before);
  await writeFile(dir+'/'+name+'-project.json',JSON.stringify(p,null,2)+'\n');await writeFile(dir+'/'+name+'-comparisons.json',JSON.stringify(messages,null,2)+'\n');evidence.push({name,inputHash:before,timelineProof});
}
await writeFile(dir+'/hand-ledger.json',JSON.stringify({scope:'View filtering and background dispatch retain original math. C05: prepare 1ms, B 5ms, join .5ms, B original ordinal3 and absolute interval1..6ms; whole-model makespan6.5ms. A fusion member shows its complete execution unit. C01:1024/(1000*5)=.2048 MFU;448/(100*5)=.896 estimated MBU. Decode uses the third actual call.',evidence},null,2)+'\n');console.log('Canvas-derived reference: 4 portable projects, 23 accepted comparisons, atomic/absolute/step timeline and exact source checks passed.');
