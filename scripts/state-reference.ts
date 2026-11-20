import { mkdir,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { NodeId,type MetricValue } from '@model-analyser/contracts';
import { analyzeScenario,ENGINE_VERSION } from '@model-analyser/core';
import { validateProject } from '../packages/contracts/src/validation.js';
import { validateResult } from '../packages/contracts/src/result-validation.js';
import { makeStateProject } from './state-project.js';
const value=(m:MetricValue|undefined)=>{if(m?.status!=='available')throw Error('Missing reference metric');return m.quantity.value;};
const rows=[];await mkdir('examples/computed',{recursive:true});
for(const [name,kind,seconds,peak,hbm] of [['shared-serial','shared',3.84,192,384],['shared-ideal','shared',1.92,192,384],['shared-bandwidth','shared',3.84,192,384],['recurrent-sequence','recurrent',5.28,128,528]] as const){
  const p=makeStateProject(kind),s=p.scenarios[0];if(!s)throw Error();p.projectId+=':'+name;p.name+=' · '+name;if(name==='shared-ideal'||name==='shared-bandwidth')s.executionPlan={kind:'streams',assignments:[{nodeId:NodeId.parse('layer[0]'),groupId:'main',streamId:'a'},{nodeId:NodeId.parse('layer[1]'),groupId:'main',streamId:'b'}],extraDependencies:[],resourcePolicy:{kind:name==='shared-ideal'?'ideal':'shared_bandwidth'}};
  assert.deepEqual(validateProject(p).filter(d=>d.severity==='error'),[]);const a=await analyzeScenario(s,p.assetSnapshots);if(a.status!=='available')throw Error(JSON.stringify(a.diagnostics));const r=a.result;assert.deepEqual(validateResult(r),[]);assert.ok(Math.abs(value(r.total.seconds)-seconds)<1e-12);assert.equal(value(r.memory[0]?.peakBytes),peak);assert.equal(value(r.total.hbmBytes),hbm);
  await writeFile('examples/computed/state-'+name+'-project.json',JSON.stringify(p,null,2)+'\n');await writeFile('examples/computed/state-'+name+'-result.json',JSON.stringify(r,null,2)+'\n');rows.push({name,inputHash:r.inputHash,seconds:value(r.total.seconds),peakBytes:peak,hbmBytes:hbm,afterVersions:r.decode?.steps.map(s=>s.stateTransitions.map(t=>t.afterVersion))});
}
await writeFile('examples/computed/state-reference.json',JSON.stringify({engineVersion:ENGINE_VERSION,description:'Independent paper-sized C04 sharing and recurrent update examples, synthetic device. Residency does not multiply by reader or decode-step count; every declared read remains.',hand:{sharedB1:{residentBytes:64,readBytes:128},sharedB3:{residentBytes:192,readBytes:384},recurrentB2H4:{weightBytes:64,stateBytes:16,inputBytes:16,projectionBytes:32,peakBytes:128,matrixOpsPerCall:128,vectorProxyOpsPerCall:16,hbmBytesPerCall:176,secondsPerCall:1.76,capacityFormula:'64 + 32*B',maxBatchAt4096Bytes:126}},rows},null,2)+'\n');console.log('C04: 192 B resident / 384 B reads; serial/shared-HBM 3.84 s, ideal 1.92 s. Recurrent: three versions, 128 B peak / 528 B HBM / 5.28 s. Four portable projects/results generated.');
