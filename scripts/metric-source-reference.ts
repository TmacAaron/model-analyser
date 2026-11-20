import assert from 'node:assert/strict';
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { ProjectDocument,type AnalysisResult } from '@model-analyser/contracts';
import { analyzeScenario,compareScenarios,computeInputHash } from '@model-analyser/core';
import { makeMetricSourceProject,makeMetricCommunicationProject } from './metric-source-project.js';
import { makeDecodeProject } from './decode-project.js';
import { comparisonRows,comparisonMetricEvidence,comparisonDeltaEvidence } from '../apps/web/src/comparison-metrics.js';

const base=ProjectDocument.parse(JSON.parse(await readFile('examples/contracts/project.json','utf8')) as unknown),decode=makeDecodeProject(base);
if(!decode.scenarios[0])throw Error('Decode scenario missing');decode.scenarios.push({...structuredClone(decode.scenarios[0]),scenarioId:'example:scenario:metric-source-decode-copy',name:'Decode copy'});
const fixtures=[['same-model',makeMetricSourceProject(base)],['mixed',makeMetricSourceProject(base,true)],['communication',makeMetricCommunicationProject(base)],['sequence',decode]] as const;
await mkdir('examples/metric-sources',{recursive:true});const ledgers=[];
const available=(m:AnalysisResult['total']['seconds']|AnalysisResult['total']['compute'][number]['usefulOperations'])=>{assert.equal(m.status,'available');if(m.status!=='available')throw Error();return m.quantity.value;};
for(const [name,p] of fixtures){
  const snapshot=JSON.stringify(p),attempt=await compareScenarios(p.scenarios,p.assetSnapshots,{scenarioIds:p.scenarios.map(s=>s.scenarioId)});assert.equal(attempt.status,'available');if(attempt.status!=='available')throw Error();const report=attempt.result,rows=comparisonRows(report),results=report.entries.map(e=>{if(e.analysis.status!=='available')throw Error('Unavailable entry');return e.analysis.result;});
  assert.equal(JSON.stringify(p),snapshot);assert.deepEqual(p.scenarios[0]?.model,p.scenarios[1]?.model);
  const seconds=rows.find(r=>r.key==='seconds')?.values,capacity=rows.find(r=>r.key==='capacity:gpu0')?.values;
  if(name==='same-model'||name==='mixed'){
    assert.deepEqual(seconds,[2,5]);assert.deepEqual(capacity,[64,128]);assert.equal(comparisonDeltaEvidence(report,'seconds',1).delta,3);
    assert.deepEqual(rows.find(r=>r.label.startsWith('模型有效 float matrix'))?.values,[1024,1280]);
    const h=comparisonMetricEvidence(report,'capacity:gpu0',1);assert.equal(h.kind,'hardware');if(h.kind!=='hardware')throw Error();assert.equal(h.matches,true);assert.equal(h.hardwareRef.assetId,'example:hardware:metric-source128');
  }
  if(name==='mixed'){assert.deepEqual(rows.find(r=>r.label.startsWith('模型有效 float vector'))?.values,[2,2]);assert.deepEqual(rows.find(r=>r.label.startsWith('物理执行 float vector'))?.values,[3,3]);}
  if(name==='communication'){
    assert.deepEqual(rows.find(r=>r.key==='send:tp')?.values,[128,128]);const sum=comparisonMetricEvidence(report,'send:tp',0);assert.equal(sum.kind,'sum');if(sum.kind!=='sum')throw Error();assert.deepEqual(sum.parts.map(p=>p.metric.status==='available'?p.metric.quantity.value:undefined),[64,64]);assert.deepEqual(sum.parts.map(p=>p.metricId),['group-send:0','group-send:1']);
    assert.ok(seconds?.every(s=>s!==undefined&&Math.abs(s-2.946)<1e-12));
  }
  if(name==='sequence'){assert.deepEqual(rows.find(r=>r.label.startsWith('模型有效 float matrix'))?.values,[12,12]);assert.equal(available(results[0]!.decode!.steps[2]!.result.total.compute[0]!.usefulOperations),5);}
  const path='examples/metric-sources/'+name+'-project.json';await writeFile(path,JSON.stringify(p,null,2)+'\n');const portable=ProjectDocument.parse(JSON.parse(await readFile(path,'utf8')) as unknown);
  for(const [i,s] of portable.scenarios.entries()){const a=await analyzeScenario(s,portable.assetSnapshots);assert.equal(a.status,'available');if(a.status!=='available')throw Error();assert.equal(a.result.inputHash,results[i]?.inputHash);assert.equal(a.result.inputHash,await computeInputHash(s,portable.assetSnapshots));assert.equal(available(a.result.total.seconds),seconds?.[i]);}
  await writeFile('examples/metric-sources/'+name+'-comparison.json',JSON.stringify(report,null,2)+'\n');
  ledgers.push({name,scope:'Same fixed model, independently configured results; no project or numeric algorithm changes',engine:report.engineVersion,hashes:results.map(r=>r.inputHash),seconds,capacity,rows,sourceIdentities:rows.map(row=>({key:row.key,entries:report.entries.map((_,i)=>{const e=comparisonMetricEvidence(report,row.key,i);return e.kind==='metric'||e.kind==='sum'?{kind:e.kind,parts:e.parts.map(p=>({targetId:p.targetId,metricId:p.metricId,value:p.metric.status==='available'?p.metric.quantity:undefined}))}:e.kind==='hardware'?{kind:e.kind,deviceId:e.deviceId,hardwareRef:e.hardwareRef,capacity:e.recordedCapacity,matches:e.matches}:e;})}))});
}
await writeFile('examples/metric-sources/hand-ledger.json',JSON.stringify({version:'metric-source-reference.1',notes:['Independent2s→5s/64B→128B/1024→1280 operations; no class-count metric.','Two declared32B/member sends on two devices give64B/event,128B total.','Three calls3+4+5=12 operations; step3 is5, not the aggregate.','Shared provenance is preserved as recorded and is not independent per-component formula attribution.'],ledgers},null,2)+'\n');
console.log('Metric source reference:4 same-model portable projects and independent value/delta/class/device/communication/sequence ledgers verified; input hashes and original calculation paths preserved.');
