import { describe,it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ProjectDocument,StorageSpec,StorageId,MetricScope,CostDefinition } from '@model-analyser/contracts';
import { allocateStorage,evaluateCost } from '@model-analyser/core';
const project=ProjectDocument.parse(JSON.parse(readFileSync('examples/contracts/project.json','utf8')) as unknown);
const context={assets:project.assetSnapshots,symbols:{M:{value:4,unit:'count' as const},N:{value:8,unit:'count' as const},K:{value:16,unit:'count' as const}}};
const op=project.assetSnapshots.find(a=>a.definition.kind==='operator')?.definition;
const hw=project.assetSnapshots.find(a=>a.definition.kind==='hardware')?.definition;
if(op?.kind!=='operator'||hw?.kind!=='hardware')throw Error('Missing C01 fixtures');
const operator=op.operator,hardware=hw.hardware;
const scope=MetricScope.parse({phase:'decode',target:{kind:'node',nodeId:'gemm'},deviceIds:['gpu0'],aggregation:'per_device'});
const value=(metric:{status:string;quantity?:{value:number}})=>{expect(metric.status).toBe('available');return metric.quantity?.value;};
describe('standalone exact storage and leaf cost calculations',()=>{
  it('C01 evaluates the independent hand arithmetic without UI, service, or Node/GPU in core',()=>{
    const evaluated=evaluateCost(operator.cost,scope,context,hardware);expect(evaluated.diagnostics).toEqual([]);
    expect(value(evaluated.cost.compute[0]?.usefulOperations??{status:'missing'})).toBe(1024);
    expect(value(evaluated.cost.logicalReadBytes)).toBe(384);expect(value(evaluated.cost.logicalWriteBytes)).toBe(64);expect(value(evaluated.cost.hbmBytes)).toBe(448);expect(value(evaluated.cost.seconds)).toBe(4.48);
    const allocation=allocateStorage(StorageId.parse('sW'),operator.storages,context);expect(value(allocation.totalBytes)).toBe(256);
    const changed=evaluateCost(operator.cost,scope,{...context,symbols:{...context.symbols,M:{value:8,unit:'count'}}},hardware);expect(value(changed.cost.compute[0]?.usefulOperations??{status:'missing'})).toBe(2048);
  });
  it('C02 distinguishes tight and padded W4 payload from scale storage without changing internal compute class',()=>{
    const make=(elements:number,packing:number)=>StorageSpec.parse({storageId:'w4',name:'W4',category:'weight',sharingDomain:'instance',allocation:{kind:'tensor',shape:[{axisId:'elements',semantic:'custom',size:{kind:'literal',quantity:{value:elements,unit:'count'}}}],dtype:{category:'float',bits:16,format:'bf16'},quantization:{payloadBits:4,packingUnitElements:packing,alignmentBytes:1,auxiliaries:[{name:'scale',dtype:{category:'float',bits:16,format:'fp16'},count:{kind:'group',groupSize:32}}]}}});
    for(const [elements,packing,payload,total] of [[128,1,64,72],[130,1,65,75],[130,32,80,90]]){const s=make(elements??0,packing??0),r=allocateStorage(s.storageId,[s],context);expect(value(r.payloadBytes)).toBe(payload);expect(value(r.totalBytes)).toBe(total);}
    expect(operator.cost.compute[0]?.computeClass.multiplyDtype.format).toBe('bf16');
  });
  it('does not infer HBM traffic or hardware speed from logical bytes or dtype bit width',()=>{
    const noEstimate=structuredClone(operator.cost);for(const access of noEstimate.memoryAccess)delete access.hbmEstimate;
    const missing=evaluateCost(noEstimate,scope,context,hardware);expect(value(missing.cost.logicalReadBytes)).toBe(384);expect(missing.cost.hbmBytes.status).toBe('unavailable');expect(missing.cost.seconds.status).toBe('unavailable');
    const noCapability=evaluateCost(operator.cost,scope,context,{...hardware,computeCapabilities:[]});expect(noCapability.cost.seconds.status).toBe('unavailable');expect(value(noCapability.cost.compute[0]?.usefulOperations??{status:'missing'})).toBe(1024);
  });
  it('supports serial overlap and rejects double application of efficiencies to effective hardware',()=>{
    const cost=structuredClone(operator.cost);if(cost.timing.kind!=='roofline_bound')throw Error();cost.timing.computeMemoryOverlap='serial';
    expect(value(evaluateCost(cost,scope,context,hardware).cost.seconds)).toBeCloseTo(5.504,12);
    const effective={...hardware,computeCapabilities:hardware.computeCapabilities.map(c=>({...c,kind:'effective' as const}))};cost.timing.computeEfficiency=0.5;
    const r=evaluateCost(cost,scope,context,effective);expect(r.cost.seconds.status).toBe('unavailable');expect(r.diagnostics.some(d=>d.code==='invalid_efficiency')).toBe(true);
  });
  it('refuses nonzero time underflow and recovers a finite ratio when the intermediate effective denominator underflows',()=>{
    const c=CostDefinition.parse(operator.cost),h=structuredClone(hardware),segment=c.compute[0],cap=h.computeCapabilities[0];if(!segment||!cap||c.timing.kind!=='roofline_bound')throw Error();c.memoryAccess=[];segment.usefulOperations={kind:'literal',quantity:{value:1e-300,unit:'operation'}};segment.executedOperations=segment.usefulOperations;cap.operationsPerSecond=1e308;
    const tiny=evaluateCost(c,scope,context,h);expect(tiny.cost.seconds.status).toBe('unavailable');expect(tiny.diagnostics.map(d=>d.code)).toContain('numeric_overflow');
    segment.usefulOperations={kind:'literal',quantity:{value:1e-308,unit:'operation'}};segment.executedOperations=segment.usefulOperations;cap.operationsPerSecond=1e-308;c.timing.computeEfficiency=1e-308;const recovered=evaluateCost(c,scope,context,h).cost.seconds;expect(recovered.status).toBe('available');if(recovered.status!=='available')throw Error();expect(recovered.quantity.value/1e308).toBeCloseTo(1,11);
    segment.usefulOperations={kind:'literal',quantity:{value:0,unit:'operation'}};segment.executedOperations=segment.usefulOperations;expect(value(evaluateCost(c,scope,context,h).cost.seconds)).toBe(0);
  });
  it('does not report positive HBM estimates as zero after multiplication underflow',()=>{
    const c=CostDefinition.parse(operator.cost);c.compute=[];c.memoryAccess=c.memoryAccess.slice(0,1);const a=c.memoryAccess[0];if(!a)throw Error();a.logicalBytes={kind:'literal',quantity:{value:1e-300,unit:'byte'}};a.hbmEstimate={kind:'factor',value:1e-300};const r=evaluateCost(c,scope,context,hardware);expect(r.cost.hbmBytes.status).toBe('unavailable');expect(r.cost.seconds.status).toBe('unavailable');expect(r.diagnostics.map(d=>d.code)).toContain('numeric_overflow');
  });
  it('retains independent reads of aliased state while exposing a canonical storage identity',()=>{
    const state=StorageSpec.parse({storageId:'state',name:'state',category:'state',sharingDomain:'request',allocation:{kind:'bytes',value:{kind:'literal',quantity:{value:64,unit:'byte'}}}});
    const alias=StorageSpec.parse({...state,storageId:'alias',allocation:{kind:'alias',targetStorageId:'state'}});
    const first=allocateStorage(state.storageId,[state,alias],context),second=allocateStorage(alias.storageId,[state,alias],context);expect(first.canonicalStorageId).toBe(second.canonicalStorageId);expect(value(first.totalBytes)).toBe(64);
    const cost=CostDefinition.parse({compute:[],memoryAccess:['state','alias'].map(storageId=>({accessId:storageId,storageId,mode:'read',logicalBytes:{kind:'literal',quantity:{value:64,unit:'byte'}},hbmEstimate:{kind:'factor',value:1}})),temporaryStorageIds:[],timing:{kind:'fixed',seconds:1,description:'C04 independent state readers'}});
    expect(value(evaluateCost(cost,scope,context).cost.logicalReadBytes)).toBe(128);
  });
  it('returns unavailable for wrong units, alias cycles and exact allocation overflow, but allows a safe byte count with a larger bit count',()=>{
    const bad=StorageSpec.parse({storageId:'s',name:'s',category:'state',sharingDomain:'request',allocation:{kind:'bytes',value:{kind:'literal',quantity:{value:1,unit:'second'}}}});expect(allocateStorage(bad.storageId,[bad],context).totalBytes.status).toBe('unavailable');
    const cycle=StorageSpec.parse({...bad,allocation:{kind:'alias',targetStorageId:'s'}});expect(allocateStorage(cycle.storageId,[cycle],context).diagnostics[0]?.code).toBe('dependency_cycle');
    const large=StorageSpec.parse({...bad,allocation:{kind:'tensor',shape:[{axisId:'n',semantic:'custom',size:{kind:'literal',quantity:{value:Number.MAX_SAFE_INTEGER,unit:'count'}}}],dtype:{category:'uint',bits:8,format:'u8'}}});expect(value(allocateStorage(large.storageId,[large],context).totalBytes)).toBe(Number.MAX_SAFE_INTEGER);
    if(large.allocation.kind!=='tensor')throw Error();large.allocation.dtype.bits=16;expect(allocateStorage(large.storageId,[large],context).totalBytes.status).toBe('unavailable');
  });
});
