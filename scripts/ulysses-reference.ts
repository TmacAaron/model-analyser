import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { analyzeScenario,searchCapacity,ENGINE_VERSION } from '@model-analyser/core';
import type { MetricValue } from '@model-analyser/contracts';
import { validateProject } from '../packages/contracts/src/validation.js';
import { makeUlyssesProject } from './ulysses-project.js';
import lock from '../references/parallel/ulysses-source-lock.json' with {type:'json'};
import { ulyssesOracle } from './ulysses-oracle.js';
const value=(m:MetricValue|undefined)=>{assert.ok(m?.status==='available');return m.quantity.value;};
try{const raw=await readFile('.runtime/ulysses-review/README.md');assert.equal(createHash('sha256').update(raw).digest('hex'),lock.sha256);}catch(e){if(!(e instanceof Error&&'code' in e&&e.code==='ENOENT'))throw e;}
await mkdir('examples/ulysses',{recursive:true});const rows=[];
for(const [name,degree,mode] of [['single',1,'replicated'],['sequence-heads',2,'ulysses'],['redundant',2,'replicated']] as const){
  const project=makeUlyssesProject(degree,mode),s=project.scenarios[0];if(!s)throw Error();const issues=validateProject(project).filter(d=>d.severity==='error');assert.deepEqual(issues,[]);
  const a=await analyzeScenario(s,project.assetSnapshots);if(a.status!=='available')throw Error(JSON.stringify(a));const r=a.result;
  const oracle=ulyssesOracle(1,4,2,2,degree,mode);assert.ok(Math.abs(value(r.total.seconds)-oracle.seconds)<1e-12);assert.deepEqual(r.memory.map(m=>value(m.peakBytes)),Array(degree).fill(oracle.peakPerDevice));assert.equal(value(r.total.compute.find(c=>c.computeClass.resource==='matrix')?.executedOperations),oracle.physicalMatrix);assert.deepEqual(r.distributed?.layout.localCosts.deviceSubtotals.map(d=>value(d.knownLeafCost.hbmBytes)),Array(degree).fill(oracle.hbmPerDevice));
  const maximum=mode==='ulysses'?24:12,capacity=await searchCapacity(s,project.assetSnapshots,{variable:{kind:'workload',field:'batchSize'},searchRange:{min:maximum-1,max:maximum+1}});assert.ok(capacity.status==='available'&&capacity.result.capacityStatus.kind==='solved'&&capacity.result.capacityStatus.maximum===maximum);await writeFile('examples/ulysses/'+name+'-batch-capacity.json',JSON.stringify(capacity,null,2)+'\n');
  const summary={name,physicalDevices:s.deviceTopology.devices.length,time:r.total.seconds,peak:r.memory.map(m=>({deviceScope:m.deviceScope,bytes:m.peakBytes})),physicalCompute:r.total.compute,logicalCompute:r.distributed?.logicalCompute.find(c=>c.scope.target.kind==='model')?.compute,communications:r.distributed?.layout.communications.map(c=>({operation:c.evaluation.definition.operation,send:c.evaluation.cost.communications[0]?.sendBytesPerMember,remote:c.evaluation.cost.communications[0]?.algorithmTrafficBytesPerMember,seconds:c.evaluation.cost.seconds})),known:r.distributed?.layout.localCosts.deviceSubtotals.map(d=>({id:d.deviceId,hbm:d.knownLeafCost.hbmBytes})),diagnostics:r.diagnostics.filter(d=>d.severity==='error').map(d=>({code:d.code,message:d.message}))};
  for(const [part,value] of Object.entries({project,result:r,summary}))await writeFile('examples/ulysses/'+name+'-'+part+'.json',JSON.stringify(value,null,2)+'\n');rows.push({name,oracle,maximumBatchInCheckedRange:maximum});console.log(name+' '+JSON.stringify({seconds:r.total.seconds.status==='available'?r.total.seconds.quantity.value:null,peaks:r.memory.map(m=>m.peakBytes.status==='available'?m.peakBytes.quantity.value:null),diagnostics:summary.diagnostics.slice(0,5)}));
}
await writeFile('examples/ulysses/reference.json',JSON.stringify({engineVersion:ENGINE_VERSION,source:lock,rows},null,2)+'\n');
