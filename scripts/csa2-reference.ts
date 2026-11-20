import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { analyzeScenario,searchCapacity,ENGINE_VERSION } from '@model-analyser/core';
import type { MetricValue } from '@model-analyser/contracts';
import { validateProject } from '../packages/contracts/src/validation.js';
import { validateResult } from '../packages/contracts/src/result-validation.js';
import { makeCsa2Project } from './csa2-project.js';
import { csa2Oracle } from './csa2-oracle.js';
import lock from '../references/parallel/csa2-source-lock.json' with {type:'json'};
const value=(m:MetricValue|undefined)=>{assert.ok(m?.status==='available');return m.quantity.value;};
for(const f of lock.files)try{const raw=await readFile('.runtime/csa2-review/'+f.path.split('/').at(-1));assert.equal(createHash('sha256').update(raw).digest('hex'),f.sha256);}catch(e){if(!(e instanceof Error&&'code' in e&&e.code==='ENOENT'))throw e;}
await mkdir('examples/csa2',{recursive:true});const rows=[];
for(const [name,profile,policy,storage] of [['independent','independent','serial','packed'],['kv-only','kv-only','serial','packed'],['shared','csa2','serial','packed'],['overlap','csa2','ideal','packed'],['bandwidth','csa2','shared_bandwidth','packed'],['bf16','csa2','serial','bf16']] as const){
  const p=makeCsa2Project(profile,policy,storage),s=p.scenarios[0];if(!s)throw Error();assert.deepEqual(validateProject(p).filter(d=>d.severity==='error'),[]);
  const a=await analyzeScenario(s,p.assetSnapshots);if(a.status!=='available')throw Error(name+' '+JSON.stringify(a.diagnostics));const r=a.result;assert.deepEqual(validateResult(r),[]);
  const oracle=csa2Oracle(1,5,4,profile,storage,policy==='ideal'?'ideal':'serial');assert.equal(value(r.total.hbmBytes),oracle.hbm);assert.equal(value(r.total.compute.find(c=>c.computeClass.resource==='matrix')?.executedOperations),oracle.matrix);assert.equal(value(r.total.compute.find(c=>c.computeClass.resource==='vector')?.executedOperations),oracle.vector);assert.equal(value(r.total.compute.find(c=>c.computeClass.resource==='vector')?.usefulOperations),oracle.usefulVector);assert.equal(value(r.memory[0]?.peakBytes),oracle.peak);const expectedSeconds=policy==='shared_bandwidth'?(assert.ok(oracle.allMemoryBound),oracle.hbm/100):oracle.seconds;assert.ok(Math.abs(value(r.total.seconds)-expectedSeconds)<1e-10);
  for(const [part,v] of Object.entries({project:p,result:r}))await writeFile('examples/csa2/'+name+'-'+part+'.json',JSON.stringify(v,null,2)+'\n');
  const maximum=storage==='bf16'?3:profile==='independent'?1:5,capacity=await searchCapacity(s,p.assetSnapshots,{variable:{kind:'workload',field:'batchSize'},searchRange:{min:Math.max(1,maximum-1),max:maximum+1}});assert.ok(capacity.status==='available'&&capacity.result.capacityStatus.kind==='solved'&&capacity.result.capacityStatus.maximum===maximum);await writeFile('examples/csa2/'+name+'-batch-capacity.json',JSON.stringify(capacity,null,2)+'\n');
  if(profile==='csa2'&&policy==='serial')for(const asset of p.assetSnapshots){const dir='assets/builtin/'+asset.definition.kind;await mkdir(dir,{recursive:true});const filename='csa2-'+createHash('sha256').update(asset.assetId).digest('hex').slice(0,16)+'.json';if(asset.assetId.startsWith('builtin:csa2:')||asset.assetId==='builtin:hardware:csa2-research')await writeFile(dir+'/'+filename,JSON.stringify(asset,null,2)+'\n');}
  const row={name,profile,policy,storage,oracle,maximumBatchInCheckedRange:maximum,seconds:value(r.total.seconds),hbm:value(r.total.hbmBytes),peak:r.memory.map(m=>value(m.peakBytes)),matrix:value(r.total.compute.find(c=>c.computeClass.resource==='matrix')?.executedOperations),vector:value(r.total.compute.find(c=>c.computeClass.resource==='vector')?.executedOperations)};rows.push(row);console.log(JSON.stringify({name,seconds:row.seconds,hbm:row.hbm,peak:row.peak}));
}
await writeFile('examples/csa2/reference.json',JSON.stringify({engineVersion:ENGINE_VERSION,source:lock,rows},null,2)+'\n');
