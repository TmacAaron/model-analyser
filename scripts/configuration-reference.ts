import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { ProjectDocument } from '@model-analyser/contracts';
import { analyzeScenario,computeInputHash,instantiateModel } from '@model-analyser/core';
import { applyConfigurationEdit } from '../packages/core/src/configuration-edit.js';
import { configurationDraft,configurationFields,writeConfigurationDraft } from '../packages/contracts/src/configuration-edit.js';
import { validateProject } from '../packages/contracts/src/validation.js';
import { makeLocalGemmProject } from './local-gemm-project.js';
import { makeSerialGatherProject } from './serial-gather-project.js';

const base=ProjectDocument.parse(JSON.parse(await readFile('examples/contracts/project.json','utf8')) as unknown),directory='examples/configuration-editing';await mkdir(directory,{recursive:true});
const pending=configurationDraft(base,base.scenarios[0]!.scenarioId);pending.text='{unfinished';pending.inputs={'parameter.key':'M','parameter.value':'-'};const staged=writeConfigurationDraft(base,pending),initialHash=await computeInputHash(base.scenarios[0]!,base.assetSnapshots);assert.equal(await computeInputHash(staged.scenarios[0]!,staged.assetSnapshots),initialHash);assert.deepEqual(validateProject(staged),[]);await writeFile(directory+'/pending-project.json',JSON.stringify(staged,null,2)+'\n');
const records=[];
for(const mode of ['single','local','communication'] as const){const project=mode==='single'?ProjectDocument.parse(base):mode==='local'?makeLocalGemmProject(base):makeSerialGatherProject(base),scenario=project.scenarios[0]!,fields=configurationFields(scenario),draft=configurationDraft(project,scenario.scenarioId),before=await computeInputHash(scenario,project.assetSnapshots),fixedAssets=JSON.stringify(project.assetSnapshots);
  if(mode!=='communication'){const parameterKey=mode==='single'?'M':'N',value=mode==='single'?8:16;fields.bindings=[...fields.bindings.filter(b=>b.parameterKey!==parameterKey),{parameterKey,value:{kind:'integer',value}}];}
  else {const expanded=instantiateModel(scenario,project.assetSnapshots);if(expanded.status!=='available')throw Error();fields.numericOverrides.push({target:{kind:'node',nodeId:expanded.resolved.graph.nodes[0]!.nodeId},field:'fixed_seconds',value:{value:1.25,unit:'second'},description:'Authored 1.25s node barrier, not a hardware measurement'});}
  draft.text=JSON.stringify(fields);const next=await applyConfigurationEdit(writeConfigurationDraft(project,draft),scenario.scenarioId),analysis=await analyzeScenario(next.scenarios[0]!,next.assetSnapshots);assert.equal(analysis.status,'available');if(analysis.status!=='available')throw Error();const result=analysis.result;
  // Scalar oracle uses declared dimensions and independent byte arithmetic, never engine formula helpers.
  const expectations=mode==='single'?{operations:2*8*8*16,hbm:8*16*2+16*8*2+8*8*2,peakPerDevice:640,seconds:640/100}:mode==='local'?{operations:2*4*16*16,hbm:2*(4*16*2+16*8*2+4*8*2),peakPerDevice:448,seconds:448/100}:{operations:2*4*8*16,hbm:undefined,peakPerDevice:128+64+200,seconds:1.25+32/1000+0.001};
  assert.equal(result.total.seconds.status,'available');if(result.total.seconds.status==='available')assert.ok(Math.abs(result.total.seconds.quantity.value-expectations.seconds)<1e-12);
  assert.equal(result.total.compute.find(c=>c.computeClass.resource==='matrix')?.usefulOperations.status,'available');const work=result.total.compute.find(c=>c.computeClass.resource==='matrix')?.usefulOperations;if(work?.status==='available')assert.equal(work.quantity.value,expectations.operations);
  if(expectations.hbm!==undefined){assert.equal(result.total.hbmBytes.status,'available');if(result.total.hbmBytes.status==='available')assert.equal(result.total.hbmBytes.quantity.value,expectations.hbm);}else assert.equal(result.total.hbmBytes.status,'unavailable');
  for(const memory of result.memory){assert.equal(memory.peakBytes.status,'available');if(memory.peakBytes.status==='available')assert.equal(memory.peakBytes.quantity.value,expectations.peakPerDevice);}
  assert.equal(JSON.stringify(next.assetSnapshots),fixedAssets);assert.deepEqual(validateProject(next),[]);assert.notEqual(result.inputHash,before);assert.deepEqual(next.configurationDrafts,[]);
  await writeFile(directory+'/'+mode+'-project.json',JSON.stringify(next,null,2)+'\n');await writeFile(directory+'/'+mode+'-result.json',JSON.stringify(result,null,2)+'\n');records.push({mode,scope:'Authored synthetic equations / explicit configuration edits, not measured hardware performance',expectations,beforeHash:before,afterHash:result.inputHash,assetsUnchanged:true});
}
await writeFile(directory+'/reference.json',JSON.stringify({pendingHash:initialHash,pendingChangesCalculation:false,cases:records},null,2)+'\n');console.log('Configuration edits: pending hash stable; single M8 = 2048 operations / 640 B / 6.4s; local N16 = 448 B per actual device / 4.48s; explicit gather + node override = 392 B / 1.283s, collective HBM remains unknown. Eight portable evidence files written.');
