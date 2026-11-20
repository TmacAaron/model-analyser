import { describe,it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { analyzeScenario,compareMeasurement } from '@model-analyser/core';
import { AssetDocument } from '@model-analyser/contracts';
import { validateAssets } from '../packages/contracts/src/validation.js';
import { makeHardwareAssets } from '../scripts/hardware-assets.js';
import { makeGqaBaseProject } from '../scripts/gqa-project.js';
import { c01Project } from './model-fixtures.js';
import lock from '../references/hardware/source-lock.json';
import { formatHardwareQuantity } from '../apps/web/src/hardware-format.js';

describe('source-checked dense hardware presets',()=>{
  it('does not round small nonzero rates to zero or hide floating-point conversion boundaries in the editor',()=>{
    expect(formatHardwareQuantity(500,1e12,'TFLOPS')).toBe('5.0000e-10 TFLOPS');expect(formatHardwareQuantity(Number.MIN_VALUE,1e12,'TFLOPS')).toBe('4.9407e-324 / 1.0000e+12 TFLOPS');expect(formatHardwareQuantity(1e308,1e9,'GB/s')).toBe('1.0000e+299 GB/s');expect(formatHardwareQuantity(0,1e9,'GB')).toBe('0 GB');expect(formatHardwareQuantity('',1e9,'GB')).toBe('待填写');
  });
  it('keeps exact SXM variants, dense versus sparse rates, SI assumptions and unknown communications explicit',()=>{
    const assets=makeHardwareAssets();expect(validateAssets(assets)).toEqual([]);expect(assets.map(a=>a.assetId)).toEqual(['builtin:hardware:nvidia-a100-sxm-80gb','builtin:hardware:nvidia-h100-sxm-80gb']);
    for(const [i,a] of assets.entries()){if(a.definition.kind!=='hardware')throw Error();const h=a.definition.hardware;expect(h.capacityBytes).toBe(80e9);expect(h.computeCapabilities.filter(c=>c.computeClass.resource==='matrix').map(c=>c.operationsPerSecond)).toEqual(Array(4).fill(i===0?312e12:989.4e12));expect(h.computeCapabilities.every(c=>c.kind==='peak')).toBe(true);expect(h.memoryCapabilities).toEqual([{key:'hbm',kind:'peak',bytesPerSecond:i===0?2039e9:3.35e12}]);expect(h.communicationDefaults).toEqual([]);expect(a.sources.some(s=>s.kind==='note'&&s.text.includes('decimal SI'))).toBe(true);expect(a.sources.filter(s=>s.kind==='url').every(s=>s.checkedOn==='2026-11-14')).toBe(true);}
    expect(lock.documents.find(d=>d.id==='h100-whitepaper')?.facts.bf16SparseFp32AccumulateTFLOPS).toBe(1978.9);expect(lock.documents.find(d=>d.id==='h100-whitepaper')?.facts.bf16DenseFp32AccumulateTFLOPS).toBe(989.4);
  });
  it('checks cached original-document byte hashes when present, without requiring a network for generation',()=>{
    for(const d of lock.documents){expect(d.sha256).toMatch(/^[a-f0-9]{64}$/);expect(d.url).toMatch(/^https:\/\/(images\.nvidia\.com|dam-cdn\.nvd\.orangelogic\.com)\//);try{const bytes=readFileSync('.runtime/hardware-review/'+d.id+'.pdf');expect(createHash('sha256').update(bytes).digest('hex')).toBe(d.sha256);}catch(e){if(!(e instanceof Error&&'code' in e&&e.code==='ENOENT'))throw e;}}
  });
  it('rejects ambiguous duplicate compute classes, memory keys or communication scopes before publishing hardware',()=>{
    for(const which of ['compute','memory','network']){const h=makeHardwareAssets()[0]!;if(h.definition.kind!=='hardware')throw Error();const d=h.definition.hardware;if(which==='compute')d.computeCapabilities.push({...d.computeCapabilities[0]!,kind:'effective'});if(which==='memory')d.memoryCapabilities.push({...d.memoryCapabilities[0]!,kind:'effective'});if(which==='network')d.communicationDefaults=[{scope:'intra_group',bytesPerSecond:1,latencySeconds:0,description:'Explicit test only'},{scope:'intra_group',bytesPerSecond:2,latencySeconds:1,description:'Conflicting test only'}];expect(validateAssets([h]).some(i=>i.code==='duplicate_id')).toBe(true);}
  });
  it('matches both supported homogeneous input conventions and independently checks C01 time, peak and MFU',async()=>{
    for(const h of makeHardwareAssets()){const p=c01Project(),s=p.scenarios[0]!;if(h.definition.kind!=='hardware')throw Error();const bw=h.definition.hardware.memoryCapabilities[0]!.bytesPerSecond,peak=h.definition.hardware.computeCapabilities[0]!.operationsPerSecond;s.deviceTopology.devices.forEach(d=>d.hardware={assetId:h.assetId,revision:1,kind:'hardware'});p.assetSnapshots=[...p.assetSnapshots.filter(a=>a.definition.kind!=='hardware'),h];const a=await analyzeScenario(s,p.assetSnapshots);expect(a.status).toBe('available');if(a.status!=='available')throw Error();expect(a.result.total.seconds).toMatchObject({status:'available',quantity:{value:expect.closeTo(448/bw,18)}});expect(a.result.memory[0]?.peakBytes).toMatchObject({status:'available',quantity:{value:448}});const old=p.measurements[0]!,m={...old,inputHash:a.result.inputHash,time:{kind:'single' as const,seconds:1e-6}},c=await compareMeasurement(m,s,a.result,p.assetSnapshots);if(c.status!=='available')throw Error();expect(c.comparison.mfu[0]?.value).toMatchObject({status:'available',quantity:{value:expect.closeTo(1024/(peak*1e-6),14)}});
      const g=makeGqaBaseProject(1),gs=g.scenarios[0]!;g.assetSnapshots=[...g.assetSnapshots.filter(a=>a.definition.kind!=='hardware'),h];gs.deviceTopology.devices.forEach(d=>d.hardware={assetId:h.assetId,revision:1,kind:'hardware'});const ga=await analyzeScenario(gs,g.assetSnapshots);if(ga.status!=='available')throw Error();expect(ga.result.total.seconds).toMatchObject({status:'available',quantity:{value:expect.closeTo(848/bw,18)}});expect(ga.result.memory[0]?.peakBytes).toMatchObject({status:'available',quantity:{value:544}});
    }
  });
  it('leaves unsupported compute classes unavailable instead of borrowing a different precision peak',async()=>{
    const h=makeHardwareAssets()[0]!,p=c01Project(),s=p.scenarios[0]!;s.deviceTopology.devices.forEach(d=>d.hardware={assetId:h.assetId,revision:1,kind:'hardware'});const op=p.assetSnapshots.find(a=>a.definition.kind==='operator')!;if(op.definition.kind!=='operator')throw Error();const segment=op.definition.operator.cost.compute[0]!;segment.computeClass.multiplyDtype={category:'float',bits:8,format:'fp8_e4m3'};segment.computeClass.inputDtypes=[segment.computeClass.multiplyDtype];p.assetSnapshots=[...p.assetSnapshots.filter(a=>a.definition.kind!=='hardware'),h];const a=await analyzeScenario(s,p.assetSnapshots);if(a.status!=='available')throw Error();expect(a.result.total.seconds.status).toBe('unavailable');expect(a.result.total.compute[0]?.usefulOperations).toMatchObject({status:'available',quantity:{value:1024}});expect(a.result.diagnostics.map(d=>d.code)).toContain('missing_compute_capability');expect(AssetDocument.parse(h).sources.length).toBeGreaterThan(0);
  });
});
