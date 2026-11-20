import assert from 'node:assert/strict';
import { mkdir,readFile,writeFile,readdir } from 'node:fs/promises';
import { AssetDocument,type MetricValue } from '@model-analyser/contracts';
import { analyzeScenario,ENGINE_VERSION } from '@model-analyser/core';
import { canonical,validateAssets,validateProject } from '../packages/contracts/src/validation.js';
import { validateResult } from '../packages/contracts/src/result-validation.js';
import { makeNamedParallelBase,makeNamedParallelProject,type NamedParallelKind } from './named-parallel-project.js';
import { ulyssesOracle } from './ulysses-oracle.js';
import { moeOracle } from './moe-oracle.js';
import ulyssesSource from '../references/parallel/ulysses-source-lock.json' with {type:'json'};
import moeSource from '../references/parallel/moe-source-lock.json' with {type:'json'};
const value=(m:MetricValue|undefined)=>{assert.ok(m?.status==='available');return m.quantity.value;};
const rows=[],written=new Set<string>();let added=0,reused=0;
await mkdir('examples/named-parallel',{recursive:true});
for(const kind of ['sp2','ep2','ep2-tp2'] as NamedParallelKind[]){
  const base=makeNamedParallelBase(kind),{project,preview}=await makeNamedParallelProject(kind),s=project.scenarios[0];if(!s)throw Error();assert.deepEqual(validateAssets(base.assetSnapshots).filter(d=>d.severity==='error'),[]);assert.deepEqual(validateProject(project).filter(d=>d.severity==='error'),[]);
  for(const asset of base.assetSnapshots){if(written.has(asset.assetId))continue;written.add(asset.assetId);const dir='assets/builtin/'+asset.definition.kind,file=dir+'/'+asset.assetId.split(':').slice(2).join('-')+'.json';await mkdir(dir,{recursive:true});let old:AssetDocument|undefined;try{old=AssetDocument.parse(JSON.parse(await readFile(file,'utf8')) as unknown);}catch(e){if(!(e instanceof Error&&'code'in e&&e.code==='ENOENT'))throw e;}if(old){assert.equal(canonical(old),canonical(asset),'Fixed revision collision: '+file);reused++;}else{await writeFile(file,JSON.stringify(asset,null,2)+'\n');added++;}}
  const a=await analyzeScenario(s,project.assetSnapshots);if(a.status!=='available')throw Error(JSON.stringify(a.diagnostics));const r=a.result,o=kind==='sp2'?ulyssesOracle(1,4,2,2,2,'ulysses'):moeOracle(1,4,4,8,kind==='ep2'?1:2);assert.deepEqual(validateResult(r),[]);assert.ok(Math.abs(value(r.total.seconds)-o.seconds)<1e-10);assert.deepEqual(r.memory.map(m=>value(m.peakBytes)),Array(preview.deviceIds.length).fill(o.peakPerDevice));assert.deepEqual(r.distributed?.layout.localCosts.deviceSubtotals.map(d=>value(d.knownLeafCost.hbmBytes)),Array(preview.deviceIds.length).fill(o.hbmPerDevice));
  await writeFile('examples/named-parallel/'+kind+'-base.json',JSON.stringify(base,null,2)+'\n');await writeFile('examples/named-parallel/'+kind+'-project.json',JSON.stringify(project,null,2)+'\n');
  rows.push({kind,inputHash:r.inputHash,devices:preview.deviceIds,groups:s.deviceTopology.groups,bindings:s.parallelPlan.nativeBindings,communicationCount:preview.communicationCount,allocations:preview.allocations,seconds:value(r.total.seconds),peakPerDevice:r.memory.map(m=>value(m.peakBytes)),oracle:o,communications:r.distributed?.layout.communications.map(c=>({nodeId:c.origin?.nodeId,operation:c.evaluation.definition.operation,groupId:c.evaluation.definition.groupId,perDevice:c.evaluation.perDevice.map(d=>({deviceId:d.deviceId,sendBytes:value(d.sendBytes),receiveBytes:value(d.receiveBytes),remoteBytes:value(d.algorithmTrafficBytes)})),seconds:value(c.evaluation.cost.seconds)}))});console.log(kind+': '+preview.deviceIds.length+' physical devices, '+preview.communicationCount+' communications, '+value(r.total.seconds)+' s, peak '+r.memory.map(m=>value(m.peakBytes)).join('/'));
}
let jsonFiles=0;const heads=new Set<string>();for(const dir of await readdir('assets/builtin',{withFileTypes:true}))if(dir.isDirectory())for(const f of await readdir('assets/builtin/'+dir.name))if(f.endsWith('.json')){jsonFiles++;const a=AssetDocument.parse(JSON.parse(await readFile('assets/builtin/'+dir.name+'/'+f,'utf8')) as unknown);heads.add(a.assetId);}
await writeFile('examples/named-parallel/reference.json',JSON.stringify({engineVersion:ENGINE_VERSION,sources:{ulysses:ulyssesSource,moe:moeSource},fixedAssets:{publishedAssets:written.size,totalAssetHeads:heads.size,totalJsonFiles:jsonFiles},rows},null,2)+'\n');console.log(JSON.stringify({added,reused,assetHeads:heads.size,jsonFiles}));
