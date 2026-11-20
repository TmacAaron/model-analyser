import { describe,it,expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { analyzeScenario,computeInputHash } from '@model-analyser/core';
import { ProjectDocument,NodeId,StorageId,ModulePeakOverride,type MetricValue,type AnalysisResult } from '@model-analyser/contracts';
import { validateResult } from '../packages/contracts/src/result-validation.js';
import { validateParallelResolution } from '../packages/contracts/src/parallel-validation.js';
import { memoryAllocationMetric,memoryEvidenceMetric } from '../packages/contracts/src/memory-evidence-metric.js';
import { makeLocalGemmProject } from '../scripts/local-gemm-project.js';
import { selectedMemoryView,knownAllocationSum,selectedMemoryExport } from '../apps/web/src/selected-memory.js';
import { SelectedMemoryView } from '../apps/web/src/selected-memory-view.js';
import { c01Project,echo } from './model-fixtures.js';
import { makeStateProject } from '../scripts/state-project.js';
import { makeDecodeProject } from '../scripts/decode-project.js';
import { makeFusedProject } from '../scripts/fused-project.js';
import { makeStreamProject } from '../scripts/stream-project.js';
import { makeModulePeakProject } from '../scripts/module-peak-project.js';
const value=(m:MetricValue|undefined)=>m?.status==='available'?m.quantity.value:undefined;
const model={kind:'model'} as const,node=(id:string)=>({kind:'node' as const,nodeId:NodeId.parse(id)}),module=(id:string)=>({kind:'module' as const,nodeId:NodeId.parse(id)});
async function setup(p=c01Project()){const s=p.scenarios[0]!,before=await computeInputHash(s,p.assetSnapshots),a=await analyzeScenario(s,p.assetSnapshots);if(a.status!=='available')throw Error(JSON.stringify(a));expect(validateResult(a.result)).toEqual([]);expect(a.result.inputHash).toBe(before);return {p,s,r:a.result};}
describe('selected canonical memory evidence',()=>{
  it('keeps unaccessed scratch as recorded conservative allocation, without inventing a private owner',async()=>{
    const p=makeStreamProject(c01Project()),asset=p.assetSnapshots.find(a=>a.definition.kind==='model');if(asset?.definition.kind!=='model')throw Error();asset.definition.graph.storages.push({storageId:StorageId.parse('unaccessed'),name:'Unaccessed overhead',category:'workspace',sharingDomain:'instance',allocation:{kind:'bytes',value:{kind:'literal',quantity:{value:5,unit:'byte'}}}});const {r}=await setup(p),row=selectedMemoryView(r,model,'0').rows.find(row=>row.storage.storageId==='unaccessed')!;expect(value(row.value)).toBe(5);expect(row.accessors).toEqual([]);expect(row.private).toBe(false);expect(row.storage.intervals?.[0]?.start).toBe(0);expect(row.storage.intervals?.[0]?.end).toBeCloseTo(.0065,12);expect(selectedMemoryView(r,node('B'),'0').rows.map(r=>r.storage.storageId)).not.toContain('unaccessed');
  });
  it('preserves independently packed W4 payload/scales per physical copy:64+8=72B single or32+4=36B per TP member',async()=>{
    for(const local of [false,true]){const p=local?makeLocalGemmProject(c01Project()):c01Project();p.scenarios[0]!.quantizationOverrides=[{selector:{kind:'subtree',rootNodeId:NodeId.parse('$model')},weight:{payloadBits:4,packingUnitElements:1,alignmentBytes:1,auxiliaries:[{name:'scale',dtype:{category:'float',bits:16,format:'fp16'},count:{kind:'group',groupSize:32}}]}}];const {r}=await setup(p),rows=selectedMemoryView(r,model,'0').rows.filter(row=>row.storage.storageId==='sW');expect(rows).toHaveLength(local?2:1);for(const row of rows){const f=row.storage.perCopyAllocation!;expect(f.copies).toBe(1);expect(value(memoryEvidenceMetric(row,f.payloadBytes))).toBe(local?32:64);expect(value(memoryEvidenceMetric(row,f.auxiliaryBytes[0]!.bytes))).toBe(local?4:8);expect(value(memoryEvidenceMetric(row,f.totalBytes))).toBe(local?36:72);expect(value(row.value)).toBe(local?36:72);}const bad=structuredClone(r),e=bad.distributed?.layout.memoryEvidence?.[0]??bad.memoryEvidence![0]!,a=e.allocations.find(a=>a.storageId==='sW')!,f=a.perCopyAllocation!;if(f.payloadBytes.status!=='available')throw Error();f.payloadBytes.quantity.value++;expect(validateResult(bad).some(d=>d.message.includes('payload')||d.message.includes('逐副本'))).toBe(true);}
  });
  it('retains a declared repeat-wrapper output boundary even when no outside consumer reads it',async()=>{
    const f=echo('chain'),p=c01Project();if(f.model.definition.kind!=='model')throw Error();f.model.definition.graph.outputs=[];f.model.definition.graph.edges=f.model.definition.graph.edges.filter(e=>e.to.kind!=='graph_output');p.scenarios=[f.scenario];p.assetSnapshots=f.assets;const {r}=await setup(p),v=selectedMemoryView(r,module('block'),'0'),boundary=v.rows.find(row=>row.interfaceBoundary&&!row.input);expect(boundary).toBeDefined();expect(boundary?.interfaceKnown).toBe(true);expect(boundary?.shared).toBe(false);expect(boundary?.output).toBe(false);expect(boundary?.private).toBe(false);
  });
  it('keeps one192B shared backing with both actual reader identities and independent384B read traffic',async()=>{
    const {p,s,r}=await setup(makeStateProject('shared')),before=JSON.stringify(r);
    for(const id of ['layer[0]','layer[1]']){const v=selectedMemoryView(r,module(id),'0');expect(v.problem).toBeUndefined();expect(v.rows).toHaveLength(1);const row=v.rows[0]!;expect(row.storage.storageId).toBe('state');expect(row.storage.resident).toBe(true);expect(row.shared).toBe(true);expect(row.private).toBe(false);expect(value(row.value)).toBe(192);expect(row.accessors.map(a=>a.nodeId)).toEqual(['layer[0]/read','layer[1]/read']);expect(row.selectedAccessors.map(a=>a.nodeId)).toEqual([id+'/read']);}
    expect(value(r.total.logicalReadBytes)).toBe(384);expect(JSON.stringify(r)).toBe(before);expect(await computeInputHash(s,p.assetSnapshots)).toBe(r.inputHash);
  });
  it('records aliases and shares the unchanged actual allocation source instead of copying it into every row',async()=>{
    const f=echo('chain'),p=c01Project();if(f.model.definition.kind!=='model')throw Error();f.model.definition.graph.storages.push({storageId:StorageId.parse('alias-X'),name:'Explicit alias X',category:'activation',sharingDomain:'request',allocation:{kind:'alias',targetStorageId:StorageId.parse('sX')}});p.scenarios=[f.scenario];p.assetSnapshots=f.assets;const {r}=await setup(p),e=r.memoryEvidence![0]!;expect(e.provenancePool).toHaveLength(1);expect(e.allocations.some(a=>a.aliasIds.length>0)).toBe(true);
    for(const a of e.allocations){expect(a.bytes.status).toBe('available');if(a.bytes.status==='available'){expect(a.bytes.provenanceIndex).toBe(0);expect(a.bytes).not.toHaveProperty('provenance');expect(memoryAllocationMetric(e,a)).toMatchObject({provenance:e.provenancePool[0]});}}
  });
  it('uses actual physical members/unequal local allocations while logical group aliases never add a card',async()=>{
    const p=ProjectDocument.parse(JSON.parse(readFileSync('examples/computed/serial-gather-project.json','utf8'))),s=p.scenarios[0]!;s.deviceTopology.groups.push({...structuredClone(s.deviceTopology.groups[0]!),groupId:'another-role-same-devices'});const {r}=await setup(p),layout=r.distributed!.layout,v=selectedMemoryView(r,model,'0');expect(new Set(v.rows.map(r=>r.deviceId)).size).toBe(2);expect(layout.memoryEvidence).toHaveLength(2);
    for(const e of layout.memoryEvidence!){const rows=v.rows.filter(r=>r.deviceId===e.deviceId);expect(new Set(rows.map(r=>r.storage.storageId)).size).toBe(rows.length);for(const row of rows){const expected=layout.storageAllocations.find(a=>a.storageId===row.storage.storageId)!.allocation.perDevice.find(d=>d.deviceId===row.deviceId)!.totalBytes;expect(row.originalValue).toEqual(expected);}}
  });
  it('shows whole atomic fusion participation and never restores an eliminated intermediate allocation',async()=>{
    const {r}=await setup(makeFusedProject(c01Project())),v=selectedMemoryView(r,node('A'),'0');expect(v.atomic).toBe(true);expect(value(v.rows.find(r=>r.storage.storageId==='sT')?.value)).toBe(0);expect(v.rows.find(r=>r.storage.storageId==='sT')?.storage.eliminatedBy).toEqual(['pair']);expect(knownAllocationSum(v.rows).known).toBe(4);expect(v.rows.map(r=>r.storage.storageId)).toEqual(expect.arrayContaining(['sX','sY']));expect(v.rows.flatMap(r=>r.selectedAccessors.map(a=>a.nodeId))).toContain('B');expect(value(r.total.seconds)).toBeCloseTo(3.1,12);
  });
  it('keeps3GiB branchB allocation, actual1..6ms lifetime and5GiB full overlap peak separate',async()=>{
    const {r}=await setup(makeStreamProject(c01Project())),v=selectedMemoryView(r,node('B'),'0');expect(v.rows).toHaveLength(1);const row=v.rows[0]!;expect(row.storage.storageId).toBe('scratchB');expect(value(row.value)).toBe(3*2**30);expect(row.private).toBe(true);expect(row.axis).toBe('second');expect(row.storage.intervals).toEqual([{start:.001,end:.006}]);expect(value(v.memory[0]?.peakBytes)).toBe(5*2**30);expect(knownAllocationSum(v.rows)).toEqual({known:3*2**30,missing:0,overflow:false});
  });
  it('projects the third growing call8→10B reserve once, and keeps windowed6B capacity and exact child hash',async()=>{
    for(const windowed of [false,true]){const {r}=await setup(makeDecodeProject(c01Project(),windowed)),v=selectedMemoryView(r,node('update'),'2'),row=v.rows.find(r=>r.storage.storageId==='cache')!;expect(v.inputHash).toBe(r.decode!.steps[2]!.result.inputHash);expect(v.inputHash).not.toBe(r.inputHash);expect(value(row.originalValue)).toBe(windowed?6:8);expect(value(row.value)).toBe(windowed?6:10);expect(value(row.reservation?.reserved)).toBe(windowed?6:10);expect(v.rows.filter(r=>r.storage.storageId==='cache')).toHaveLength(1);expect(selectedMemoryView(r,node('update'),'9').rows).toEqual([]);expect(selectedMemoryView(r,node('update'),'9').problem).toContain('不会改用');}
  });
  it('keeps module-private budget and total override separate from original physical allocations',async()=>{
    const p=makeModulePeakProject(c01Project()),s=p.scenarios[0]!;s.modulePeakOverrides=[ModulePeakOverride.parse({overrideId:'budget-A',nodeId:'A',phases:['decode'],peakBytes:{kind:'literal',quantity:{value:2**30,unit:'byte'}},description:'Private scratch budget only'})];s.memoryPeakOverrides=[{overrideId:'total',phases:['decode'],target:{kind:'device',deviceId:s.deviceTopology.devices[0]!.deviceId},peakBytes:{kind:'literal',quantity:{value:777,unit:'byte'}},description:'Independent total assumption'}];const {r}=await setup(p),v=selectedMemoryView(r,module('A'),'0');expect(v.rows).toHaveLength(1);expect(value(v.rows[0]?.value)).toBe(2*2**30);expect(v.rows[0]?.replacedBy).toEqual(['budget-A']);expect(value(v.memory[0]?.peakBytes)).toBe(777);expect(v.memory[0]?.totalOverride?.classification).toBe('unknown');
  });
  it('keeps missing scopes, old evidence and unavailable byte values explicit without reporting them as zero',async()=>{
    const {r}=await setup(),old:AnalysisResult=structuredClone(r);delete old.memoryEvidence;expect(validateResult(old)).toEqual([]);expect(selectedMemoryView(old,model,'0').problem).toContain('重新计算');expect(selectedMemoryView(r,node('absent'),'0').rows).toEqual([]);expect(selectedMemoryView(r,node('absent'),'0').problem).toContain('不会改用');const html=renderToStaticMarkup(createElement(SelectedMemoryView,{result:old}));expect(html).toContain('不能报告完整分配合计');expect(html).not.toContain('分配合计 0');
    const row=selectedMemoryView(r,model,'0').rows[0]!;expect(knownAllocationSum([{...row,value:{status:'unavailable',diagnosticIds:['missing']}},row])).toMatchObject({known:value(row.value),missing:1});
  });
  it('rejects bad source references, duplicate canonical IDs and altered distributed allocations/intervals',async()=>{
    const {r}=await setup(),bad=structuredClone(r);const a=bad.memoryEvidence![0]!.allocations[0]!;if(a.bytes.status!=='available')throw Error();a.bytes.provenanceIndex=999;expect(validateResult(bad).some(d=>d.code==='invalid_memory_evidence')).toBe(true);const duplicate=structuredClone(r);duplicate.memoryEvidence![0]!.allocations.push(duplicate.memoryEvidence![0]!.allocations[0]!);expect(validateResult(duplicate).some(d=>d.message.includes('重复'))).toBe(true);
    const stream=(await setup(makeStreamProject(c01Project()))).r.distributed!.layout,changed=structuredClone(stream),storage=changed.memoryEvidence![0]!.allocations[0]!;if(storage.bytes.status!=='available')throw Error();storage.bytes.quantity.value++;expect(validateParallelResolution(changed).some(d=>d.message.includes('实际设备规范分配'))).toBe(true);const interval=structuredClone(stream);interval.memoryEvidence![0]!.allocations[0]!.intervals![0]!.end+=1;expect(validateParallelResolution(interval).some(d=>d.message.includes('实际时间生命周期'))).toBe(true);
  });
  it('exports scope, actual call, one canonical row and a resolvable source pool without repeating source lists',async()=>{
    const {r}=await setup(makeStateProject('shared')),v=selectedMemoryView(r,module('layer[0]'),'0'),file=selectedMemoryExport(r,v,v.rows,module('layer[0]'),'0','all','');expect(file.rows).toHaveLength(1);const row=file.rows[0]!,source=file.sources.find(s=>s.deviceId===row.deviceId)!;expect(row.storage.bytes.status).toBe('available');if(row.storage.bytes.status==='available')expect(source.provenancePool[row.storage.bytes.provenanceIndex]).toEqual(v.rows[0]?.value?.status==='available'?v.rows[0].value.provenance:undefined);expect(row).not.toHaveProperty('value');expect(file.inputHash).toBe(r.inputHash);expect(file.semantics).toContain('not module peak');
  });
});
