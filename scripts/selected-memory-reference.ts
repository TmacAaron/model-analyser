import assert from 'node:assert/strict';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { ProjectDocument,NodeId,ModulePeakOverride,type MetricTarget,type MetricValue } from '@model-analyser/contracts';
import { analyzeScenario,computeInputHash } from '@model-analyser/core';
import { selectedMemoryView,knownAllocationSum,selectedMemoryExport } from '../apps/web/src/selected-memory.js';
import { makeStateProject } from './state-project.js';
import { makeDecodeProject } from './decode-project.js';
import { makeFusedProject } from './fused-project.js';
import { makeStreamProject } from './stream-project.js';
import { makeModulePeakProject } from './module-peak-project.js';
const base=ProjectDocument.parse(JSON.parse(await readFile('examples/contracts/project.json','utf8'))),budget=makeModulePeakProject(base),bs=budget.scenarios[0];if(!bs)throw Error();bs.modulePeakOverrides=[ModulePeakOverride.parse({overrideId:'budget-A',nodeId:'A',phases:['decode'],peakBytes:{kind:'literal',quantity:{value:2**30,unit:'byte'}},description:'Explicit private-only budget; theoretical scratch remains separately recorded'})];
const quantized=ProjectDocument.parse(base),qs=quantized.scenarios[0];if(!qs)throw Error();qs.quantizationOverrides=[{selector:{kind:'subtree',rootNodeId:NodeId.parse('$model')},weight:{payloadBits:4,packingUnitElements:1,alignmentBytes:1,auxiliaries:[{name:'scale',dtype:{category:'float',bits:16,format:'fp16'},count:{kind:'group',groupSize:32}}]}}];
const dir='examples/selected-memory';await mkdir(dir,{recursive:true});const value=(m:MetricValue|undefined)=>m?.status==='available'?m.quantity.value:undefined,observations=[];
const cases:{name:string;project:ProjectDocument;target:MetricTarget;step:string}[]=[
  {name:'quantized',project:quantized,target:{kind:'model'},step:'0'},
  {name:'shared',project:makeStateProject('shared'),target:{kind:'module',nodeId:NodeId.parse('layer[0]')},step:'0'},
  {name:'growing',project:makeDecodeProject(base),target:{kind:'node',nodeId:NodeId.parse('update')},step:'2'},
  {name:'windowed',project:makeDecodeProject(base,true),target:{kind:'node',nodeId:NodeId.parse('update')},step:'2'},
  {name:'fusion',project:makeFusedProject(base),target:{kind:'node',nodeId:NodeId.parse('A')},step:'0'},
  {name:'streams',project:makeStreamProject(base),target:{kind:'node',nodeId:NodeId.parse('B')},step:'0'},
  {name:'budget',project:budget,target:{kind:'module',nodeId:NodeId.parse('A')},step:'0'},
  {name:'physical',project:ProjectDocument.parse(JSON.parse(await readFile('examples/computed/serial-gather-project.json','utf8'))),target:{kind:'model'},step:'0'},
];
for(const {name,project,target,step} of cases){const scenario=project.scenarios[0];if(!scenario)throw Error();const before=await computeInputHash(scenario,project.assetSnapshots),attempt=await analyzeScenario(scenario,project.assetSnapshots);if(attempt.status!=='available')throw Error(JSON.stringify(attempt));const result=attempt.result,view=selectedMemoryView(result,target,step);assert.equal(view.problem,undefined);
  if(name==='shared'){assert.equal(view.rows.length,1);assert.equal(value(view.rows[0]?.value),192);assert.equal(view.rows[0]?.accessors.length,2);assert.equal(value(result.total.logicalReadBytes),384);assert.equal(view.rows[0]?.shared,true);}
  if(name==='quantized'){const row=view.rows.find(r=>r.storage.storageId==='sW');assert.equal(value(row?.value),72);const format=row?.storage.perCopyAllocation;if(!format)throw Error();assert.equal(format.copies,1);assert.equal(format.payloadBytes.status,'available');if(format.payloadBytes.status==='available')assert.equal(format.payloadBytes.quantity.value,64);assert.equal(format.auxiliaryBytes[0]?.bytes.status,'available');if(format.auxiliaryBytes[0]?.bytes.status==='available')assert.equal(format.auxiliaryBytes[0].bytes.quantity.value,8);}
  if(name==='growing'||name==='windowed'){const row=view.rows.find(r=>r.storage.storageId==='cache');assert.equal(value(row?.originalValue),name==='growing'?8:6);assert.equal(value(row?.value),name==='growing'?10:6);assert.equal(view.inputHash,result.decode?.steps[2]?.result.inputHash);assert.notEqual(view.inputHash,result.inputHash);}
  if(name==='fusion'){assert.equal(view.atomic,true);const removed=view.rows.find(r=>r.storage.storageId==='sT');assert.equal(value(removed?.value),0);assert.deepEqual(removed?.storage.eliminatedBy,['pair']);assert.equal(knownAllocationSum(view.rows).known,4);}
  if(name==='streams'){assert.equal(view.rows.length,1);assert.equal(value(view.rows[0]?.value),3*2**30);assert.deepEqual(view.rows[0]?.storage.intervals,[{start:.001,end:.006}]);assert.equal(value(view.memory[0]?.peakBytes),5*2**30);}
  if(name==='budget'){assert.equal(value(view.rows[0]?.value),2*2**30);assert.deepEqual(view.rows[0]?.replacedBy,['budget-A']);assert.equal(view.memory[0]?.moduleOverrides?.applications[0]?.evaluatedBytes,2**30);}
  if(name==='physical'){assert.equal(new Set(view.rows.map(r=>r.deviceId)).size,2);assert.equal(new Set(view.rows.map(r=>JSON.stringify([r.deviceId,r.storage.storageId]))).size,view.rows.length);}
  assert.equal(result.inputHash,before);assert.equal(await computeInputHash(scenario,project.assetSnapshots),before);const exported=selectedMemoryExport(result,view,view.rows,target,step,'all','');
  for(const row of exported.rows)if(row.storage.bytes.status==='available')assert.ok(exported.sources.find(s=>s.deviceId===row.deviceId)?.provenancePool[row.storage.bytes.provenanceIndex]);
  await writeFile(dir+'/'+name+'-project.json',JSON.stringify(project,null,2)+'\n');await writeFile(dir+'/'+name+'-view.json',JSON.stringify(exported,null,2)+'\n');observations.push({name,inputHash:result.inputHash,actualCallHash:view.inputHash,rows:view.rows.length,knownAllocationSum:knownAllocationSum(view.rows),originalGlobalPeaks:view.memory.map(m=>({device:m.deviceScope,peak:m.peakBytes})),atomic:view.atomic});
}
await writeFile(dir+'/hand-ledger.json',JSON.stringify({scope:'Canonical allocation participation is not module peak attribution; W4 payload64B+scales8B=72B per copy; one192B shared backing, two192B reads=384B total; growing third8→10B vs window6B; fused2+0+2=4B; branchB3GiB with1..6ms lifetime while full overlap peak5GiB; private2GiB scratch replaced by1GiB budget separately; actual two-card allocations.',observations},null,2)+'\n');console.log('Selected-memory reference:8 portable projects and exact scope/source/alias/fusion/step/device/override/quantization ledgers verified. Numeric inputs and hashes unchanged.');
