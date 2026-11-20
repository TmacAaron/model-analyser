import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { analyzeScenario,searchCapacity,ENGINE_VERSION } from '@model-analyser/core';
import type { MetricValue } from '@model-analyser/contracts';
import { validateProject } from '../packages/contracts/src/validation.js';
import { makeMoeProject } from './moe-project.js';
import lock from '../references/parallel/moe-source-lock.json' with {type:'json'};
import { moeOracle } from './moe-oracle.js';
const value=(m:MetricValue|undefined)=>{assert.ok(m?.status==='available');return m.quantity.value;};
try{const data=await readFile('.runtime/moe-review/token_dispatcher.py');assert.equal(createHash('sha256').update(data).digest('hex'),lock.sha256);}catch(e){if(!(e instanceof Error&&'code' in e&&e.code==='ENOENT'))throw e;}
await mkdir('examples/moe',{recursive:true});const summaries=[];
for(const [name,tp,policy,profile] of [['ep-only',1,'serial','balanced'],['mixed',2,'serial','balanced'],['mixed-overlap',2,'streams','balanced'],['mixed-concentrated',2,'serial','concentrated']] as const){
  const p=makeMoeProject(tp,policy,profile),s=p.scenarios[0];if(!s)throw Error();const issues=validateProject(p).filter(d=>d.severity==='error');assert.deepEqual(issues,[]);
  const a=await analyzeScenario(s,p.assetSnapshots);if(a.status!=='available')throw Error(JSON.stringify(a));const r=a.result;
  const oracle=moeOracle(1,4,4,8,tp,policy,profile);assert.ok(Math.abs(value(r.total.seconds)-oracle.seconds)<1e-11);assert.deepEqual(r.memory.map(m=>value(m.peakBytes)),Array(2*tp).fill(oracle.peakPerDevice));assert.deepEqual(r.distributed?.layout.localCosts.deviceSubtotals.map(d=>value(d.knownLeafCost.hbmBytes)),Array(2*tp).fill(oracle.hbmPerDevice));assert.equal(value(r.total.compute.find(c=>c.computeClass.resource==='matrix')?.executedOperations),oracle.logicalMatrix);assert.equal(value(r.total.compute.find(c=>c.computeClass.resource==='vector')?.executedOperations),oracle.logicalVector);
  const maximum=tp===1?14:23,capacity=await searchCapacity(s,p.assetSnapshots,{variable:{kind:'workload',field:'batchSize'},searchRange:{min:maximum-1,max:maximum+1}});assert.ok(capacity.status==='available'&&capacity.result.capacityStatus.kind==='solved'&&capacity.result.capacityStatus.maximum===maximum);await writeFile('examples/moe/'+name+'-batch-capacity.json',JSON.stringify(capacity,null,2)+'\n');
  for(const [part,value] of Object.entries({project:p,result:r}))await writeFile('examples/moe/'+name+'-'+part+'.json',JSON.stringify(value,null,2)+'\n');
  const summary={name,oracle,maximumBatchInCheckedRange:maximum,seconds:r.total.seconds,peaks:r.memory.map(m=>m.peakBytes),known:r.distributed?.layout.localCosts.deviceSubtotals.map(d=>({id:d.deviceId,hbm:d.knownLeafCost.hbmBytes})),communications:r.distributed?.layout.communications.map(c=>({id:c.origin?.nodeId,seconds:c.evaluation.cost.seconds,traffic:c.evaluation.perDevice.map(p=>p.algorithmTrafficBytes)})),diagnostics:r.diagnostics.filter(d=>d.severity==='error').map(d=>({code:d.code,message:d.message}))};summaries.push(summary);console.log(name+' '+JSON.stringify({seconds:r.total.seconds.status==='available'?r.total.seconds.quantity.value:null,peaks:r.memory.map(m=>m.peakBytes.status==='available'?m.peakBytes.quantity.value:null),diag:summary.diagnostics.slice(0,6)}));
}
await writeFile('examples/moe/reference.json',JSON.stringify({engineVersion:ENGINE_VERSION,source:lock,summaries},null,2)+'\n');
