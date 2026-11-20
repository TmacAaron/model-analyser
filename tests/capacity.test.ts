import { describe,it,expect } from 'vitest';
import { z } from 'zod';
import Ajv2020 from 'ajv/dist/2020.js';
import { AssetDocument,StateId,StorageId,CapacitySearchRequest,CapacitySearchResult,type CapacitySearchAttempt,type CapacitySearchRequest as Request,type CapacitySearchResult as Result } from '@model-analyser/contracts';
import { searchCapacity,computeInputHash,MAX_CAPACITY_POINTS } from '@model-analyser/core';
import { validateCapacitySearch } from '../packages/contracts/src/capacity-validation.js';
import { c01Project } from './model-fixtures.js';
const report=(attempt:CapacitySearchAttempt)=>{expect(attempt.status,JSON.stringify(attempt)).toBe('available');if(attempt.status!=='available')throw Error();return attempt.result;};
const request=(min=1,max=8):Request=>({variable:{kind:'parameter',parameterKey:'P'},searchRange:{min,max}});
function fixture(expression='ceil(P / 3) * 16',capacity=32){
  const project=c01Project(),scenario=project.scenarios[0];if(!scenario)throw Error();
  const hardware=project.assetSnapshots.find(a=>a.definition.kind==='hardware');if(hardware?.definition.kind!=='hardware')throw Error();hardware.definition.hardware.capacityBytes=capacity;
  const formula=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'memory-formula',revision:1,name:'Synthetic capacity formula',tags:[],sources:[],parameters:[],definition:{kind:'formula',formula:{inputs:{P:{unit:'count',integerRequired:true,min:0}},expression,output:{unit:'byte',integerRequired:true,nonNegative:true},description:'Synthetic byte oracle'}}});
  const model=AssetDocument.parse({...formula,assetId:'capacity-model',parameters:[{key:'P',name:'Size',type:'integer',unit:'count',min:0,max:10000,default:{kind:'integer',value:1}}],definition:{kind:'model',family:'synthetic',variant:'capacity',graph:{inputs:[],outputs:[],nodes:[],edges:[],dependencies:[],tensors:[],states:[],storages:[{storageId:'resident',name:'State-sized resident allocation',category:'runtime',sharingDomain:'instance',allocation:{kind:'bytes',value:{kind:'formula',call:{formula:{assetId:formula.assetId,revision:1,kind:'formula'},bindings:{P:{kind:'symbol',name:'P'}}}}}}]}}});
  scenario.model={assetId:model.assetId,revision:1,kind:'model'};scenario.bindings=[];
  return {scenario,assets:[model,formula,hardware]};
}
describe('bounded exhaustive capacity search',()=>{
  it('finds the exact integer boundary across rounding and records reproducible hashes and peak bytes',async()=>{
    const {scenario,assets}=fixture(),r=report(await searchCapacity(scenario,assets,request(1,9)));expect(r.completion).toBe('complete');expect(r.points).toHaveLength(9);expect(r.capacityStatus).toMatchObject({kind:'solved',maximum:6,searchRange:{min:1,max:9},limitingDeviceIds:['gpu0']});
    expect(r.points.map(p=>p.status==='available'&&[p.value,p.fit,p.memory[0]?.peakBytes.status==='available'&&p.memory[0].peakBytes.quantity.value])).toEqual([[1,'fits',16],[2,'fits',16],[3,'fits',16],[4,'fits',32],[5,'fits',32],[6,'fits',32],[7,'exceeds',48],[8,'exceeds',48],[9,'exceeds',48]]);
    const clone=structuredClone(scenario);clone.bindings=[{parameterKey:'P',value:{kind:'integer',value:6}}];expect(r.points[5]?.status==='available'&&r.points[5].inputHash).toBe(await computeInputHash(clone,assets));expect(scenario.bindings).toEqual([]);expect(r.baseInputHash).toBe(await computeInputHash(scenario,assets));
  });
  it('does not infer monotonicity: finds a later fitting island after an exceeded point',async()=>{
    const {scenario,assets}=fixture('if(P == 3, 20, if(P == 7, 10, 1000))'),r=report(await searchCapacity(scenario,assets,request()));expect(r.capacityStatus).toMatchObject({kind:'solved',maximum:7});expect(r.points[3]).toMatchObject({fit:'exceeds'});
  });
  it('labels a fitting upper bound as range-limited and never invents zero when no point fits',async()=>{
    const a=fixture('P',100),r=report(await searchCapacity(a.scenario,a.assets,request()));expect(r.capacityStatus).toMatchObject({kind:'solved',maximum:8});expect(r.diagnostics.map(d=>d.code)).toContain('capacity_range_ceiling');
    const b=fixture('1000',32),none=report(await searchCapacity(b.scenario,b.assets,request()));expect(none.capacityStatus.kind).toBe('unavailable');expect(none.diagnostics.map(d=>d.code)).toContain('no_feasible_capacity');
  });
  it('does not treat formula errors above the best point as an out-of-capacity proof',async()=>{
    const a=fixture('if(P == 8, 1 / 0, P)'),r=report(await searchCapacity(a.scenario,a.assets,request()));expect(r.points[7]?.status).toBe('unavailable');expect(r.capacityStatus.kind).toBe('unavailable');expect(r.diagnostics.map(d=>d.code)).toContain('capacity_indeterminate');
    const b=fixture('if(P == 2, 1 / 0, P)'),known=report(await searchCapacity(b.scenario,b.assets,request()));expect(known.capacityStatus).toMatchObject({kind:'solved',maximum:8});
  });
  it('varies workload symbols with other inputs fixed and handles the correct prefill/decode length field',async()=>{
    const {scenario,assets}=fixture('P * 8',32);scenario.bindings=[{parameterKey:'P',value:{kind:'symbol',name:'batchSize'}}];const r=report(await searchCapacity(scenario,assets,{variable:{kind:'workload',field:'batchSize'},searchRange:{min:1,max:8}}));expect(r.capacityStatus).toMatchObject({kind:'solved',maximum:4});expect(r.baseScenario).toEqual(scenario);
    scenario.bindings=[{parameterKey:'P',value:{kind:'symbol',name:'contextTokensPerRequest'}}];const ctx=report(await searchCapacity(scenario,assets,{variable:{kind:'workload',field:'contextTokensPerRequest'},searchRange:{min:0,max:8}}));expect(ctx.capacityStatus).toMatchObject({kind:'solved',maximum:4});
    expect((await searchCapacity(scenario,assets,{variable:{kind:'workload',field:'pastTokensPerRequest'},searchRange:{min:0,max:8}})).status).toBe('unavailable');
    scenario.workload={kind:'prefill',batchSize:1,queryTokensPerRequest:1,pastTokensPerRequest:0};scenario.bindings=[{parameterKey:'P',value:{kind:'symbol',name:'pastTokensPerRequest'}}];expect(report(await searchCapacity(scenario,assets,{variable:{kind:'workload',field:'pastTokensPerRequest'},searchRange:{min:0,max:8}})).capacityStatus).toMatchObject({kind:'solved',maximum:4});
  });
  it('solves ordinary BF16 KV capacity with fixed batch or fixed context, retaining weights and initialized state',async()=>{
    const {scenario,assets}=fixture('2 * B * P * 2 * 4 * 2',1152),model=assets[0],formula=assets[1];if(model?.definition.kind!=='model'||formula?.definition.kind!=='formula')throw Error();
    formula.definition.formula.inputs.B={unit:'count',integerRequired:true,min:1};model.parameters.push({key:'B',name:'Batch',type:'integer',unit:'count',min:1,default:{kind:'integer',value:2}});
    const state=model.definition.graph.storages[0];if(!state||state.allocation.kind!=='bytes'||state.allocation.value.kind!=='formula')throw Error();state.category='state';state.allocation.value.call.bindings.B={kind:'symbol',name:'B'};
    model.definition.graph.states=[{stateId:StateId.parse('kv'),name:'Initialized ordinary BF16 KV',stateKind:'kv',storageIds:[state.storageId],creator:{kind:'initialized'},readers:[],writers:[],updatePolicy:{kind:'static'}}];
    model.definition.graph.storages.push({...state,storageId:StorageId.parse(state.storageId+'-weights'),name:'Fixed weights',category:'weight',allocation:{kind:'bytes',value:{kind:'literal',quantity:{value:128,unit:'byte'}}}});
    scenario.workload.batchSize=2;if(scenario.workload.kind!=='decode')throw Error();scenario.workload.contextTokensPerRequest=16;scenario.bindings=[{parameterKey:'P',value:{kind:'symbol',name:'contextTokensPerRequest'}},{parameterKey:'B',value:{kind:'symbol',name:'batchSize'}}];
    const length=report(await searchCapacity(scenario,assets,{variable:{kind:'workload',field:'contextTokensPerRequest'},searchRange:{min:0,max:20}}));expect(length.capacityStatus).toMatchObject({kind:'solved',maximum:16});expect(length.points[16]).toMatchObject({value:16,memory:[{peakBytes:{quantity:{value:1152}}}]});
    const batch=report(await searchCapacity(scenario,assets,{variable:{kind:'workload',field:'batchSize'},searchRange:{min:1,max:4}}));expect(batch.capacityStatus).toMatchObject({kind:'solved',maximum:2});expect(batch.points[1]).toMatchObject({value:2,memory:[{peakBytes:{quantity:{value:1152}}}]});
  });
  it('varies the effective root parameter even when a higher-priority root override existed',async()=>{
    const {scenario,assets}=fixture('P * 8',32);scenario.numericOverrides=[{target:{kind:'scenario',scenarioId:scenario.scenarioId},field:'parameter',parameterKey:'P',value:{value:100,unit:'count'}}];const r=report(await searchCapacity(scenario,assets,request()));expect(r.capacityStatus).toMatchObject({kind:'solved',maximum:4});expect(scenario.numericOverrides[0]?.value.value).toBe(100);
  });
  it('limits ranges and rejects invalid variables/types/unknown fields without starting evaluation',async()=>{
    const {scenario,assets}=fixture();for(const search of [request(9,1),request(0,MAX_CAPACITY_POINTS),{...request(),variable:{kind:'parameter',parameterKey:'missing'}},{...request(),variable:{kind:'workload',field:'batchSize'},searchRange:{min:0,max:3}}])expect((await searchCapacity(scenario,assets,search as Request)).status).toBe('unavailable');
    expect(CapacitySearchRequest.safeParse({...request(),extra:1}).success).toBe(false);expect(CapacitySearchRequest.safeParse({...request(),searchRange:{min:'1',max:3}}).success).toBe(false);
  });
  it('cancels with partial evidence but never reports a partial search as solved; snapshots inputs during progress',async()=>{
    const {scenario,assets}=fixture();let done=0;const r=report(await searchCapacity(scenario,assets,request(),{isCancelled:()=>done===3,onProgress:(count,total)=>{done=count;expect(total).toBe(8);scenario.name='edited';const model=assets[0];if(model)model.name='edited';},yieldControl:()=>Promise.resolve()}));expect(r.completion).toBe('cancelled');expect(r.points).toHaveLength(3);expect(r.capacityStatus.kind).toBe('unavailable');expect(r.baseScenario.name).not.toBe('edited');
    const none=report(await searchCapacity(scenario,assets,request(),{isCancelled:()=>true}));expect(none.points).toEqual([]);expect(none.completion).toBe('cancelled');
  });
  it('exports strict schemas for the request and complete/cancelled result variants',async()=>{
    const ajv=new Ajv2020({strict:false,validateFormats:false}),validate=ajv.compile(z.toJSONSchema(CapacitySearchResult));const {scenario,assets}=fixture();const samples:Result[]=[report(await searchCapacity(scenario,assets,request())),report(await searchCapacity(scenario,assets,request(),{isCancelled:()=>true}))];for(const sample of [...samples,{...samples[0],unexpected:true}])expect(Boolean(validate(sample))).toBe(CapacitySearchResult.safeParse(sample).success);
  });
  it('rejects forged completeness, maximum, device fit and missing diagnostic evidence after structural parsing',async()=>{
    const {scenario,assets}=fixture(),good=report(await searchCapacity(scenario,assets,request()));expect(validateCapacitySearch(good)).toEqual([]);
    for(const mutate of [
      (r:Result)=>{r.points.splice(3,1);},
      (r:Result)=>{r.completion='cancelled';},
      (r:Result)=>{if(r.capacityStatus.kind==='solved')r.capacityStatus.maximum=8;},
      (r:Result)=>{const p=r.points[0];if(p?.status==='available')p.fit='exceeds';},
      (r:Result)=>{const p=r.points[7];if(p?.status==='available')p.seconds={status:'unavailable',diagnosticIds:['absent']};},
    ]){const changed=structuredClone(good);mutate(changed);expect(CapacitySearchResult.safeParse(changed).success).toBe(true);expect(validateCapacitySearch(changed).length).toBeGreaterThan(0);}
  });
});
