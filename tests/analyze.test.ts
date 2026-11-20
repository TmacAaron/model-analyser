import { describe,it,expect } from 'vitest';
import { stringify } from 'yaml';
import { AssetDocument,Scenario,NodeId,StorageId,DeviceId,StateId,TensorId,type AnalysisAttempt,type MetricValue } from '@model-analyser/contracts';
import { analyzeScenario,computeInputHash,stableStringify } from '@model-analyser/core';
import { decodeDocument } from '../apps/local/src/documents.js';
import { validateResult } from '../packages/contracts/src/result-validation.js';
import { c01Project,echo } from './model-fixtures.js';
const available=(attempt:AnalysisAttempt)=>{expect(attempt.status,JSON.stringify(attempt.status==='unavailable'?attempt.diagnostics:attempt.result.diagnostics)).toBe('available');if(attempt.status!=='available')throw Error('No report');expect(validateResult(attempt.result)).toEqual([]);return attempt.result;};
const number=(metric:MetricValue|undefined)=>{expect(metric?.status).toBe('available');if(metric?.status!=='available')throw Error('Missing metric');return metric.quantity.value;};
const c01=()=>{const p=c01Project(),scenario=p.scenarios[0];if(!scenario)throw Error();return {scenario,assets:p.assetSnapshots};};
describe('graph-level serial baseline and input identity',()=>{
  it('C01 computes one leaf, module and model without double counting, with a real hash and matching lifetime peak',async()=>{
    const {scenario,assets}=c01(),r=available(await analyzeScenario(scenario,assets));expect(r.inputHash).toMatch(/^[a-f0-9]{64}$/);expect(r.engineVersion).toBe('0.1.0-execution.20');
    expect(r.nodes).toHaveLength(1);expect(r.modules).toHaveLength(1);expect(number(r.total.compute[0]?.usefulOperations)).toBe(1024);expect(number(r.modules[0]?.cost.compute[0]?.usefulOperations)).toBe(1024);
    expect(number(r.total.logicalReadBytes)).toBe(384);expect(number(r.total.logicalWriteBytes)).toBe(64);expect(number(r.total.hbmBytes)).toBe(448);expect(number(r.total.seconds)).toBe(4.48);
    expect(number(r.memory[0]?.peakBytes)).toBe(448);expect(r.memory[0]?.peakPoint).toEqual({kind:'time',seconds:0,nodeId:'module/op'});expect(r.memory[0]?.capacityBytes).toBe(4096);
    expect(r.schedule.map(s=>[s.startSeconds,s.endSeconds])).toEqual([[0,4.48]]);expect(r.roofline[0]?.arithmeticIntensity).toEqual({status:'available',operationsPerByte:16/7});expect(r.diagnostics).toEqual([]);
    expect(r.total.seconds.status==='available'&&r.total.seconds.provenance.formulaRefs).toHaveLength(2);
  });
  it('hash excludes display metadata and unrelated assets but tracks workload, formulas and hardware',async()=>{
    const {scenario,assets}=c01(),hash=await computeInputHash(scenario,assets);scenario.name='renamed';for(const a of assets){a.name='display';a.description='comment';a.tags=['tag'];a.sources=[];a.extensions={note:'ignored'};for(const p of a.parameters){p.name='name';p.description='comment';}if(a.definition.kind==='formula')a.definition.formula.description='new comment';if(a.definition.kind==='model')for(const n of a.definition.graph.nodes)n.name='node name';}
    expect(await computeInputHash(scenario,assets)).toBe(hash);const unrelated=AssetDocument.parse({...assets[0],assetId:'unrelated'});expect(await computeInputHash(scenario,[...assets,unrelated])).toBe(hash);
    const changed=structuredClone(scenario);changed.workload.batchSize++;expect(await computeInputHash(changed,assets)).not.toBe(hash);
    const formula=assets.find(a=>a.definition.kind==='formula');if(formula?.definition.kind!=='formula')throw Error();formula.definition.formula.expression='3 * M * N * K';expect(await computeInputHash(scenario,assets)).not.toBe(hash);
  });
  it('normalizes JSON/YAML and Unicode key ordering identically without locale-dependent key collisions',async()=>{
    const {scenario,assets}=c01();expect(await computeInputHash(Scenario.parse(decodeDocument(stringify(scenario),'yaml')),assets.map(a=>AssetDocument.parse(decodeDocument(stringify(a),'yaml'))))).toBe(await computeInputHash(scenario,assets));
    expect(stableStringify({'é':1,'e\u0301':2})).toBe(stableStringify({'e\u0301':2,'é':1}));
  });
  it('chain lifetime frees intermediates, so peak is not the sum of every declared activation',async()=>{
    const {scenario,assets}=echo('chain'),r=available(await analyzeScenario(scenario,assets));expect(number(r.total.compute[0]?.usefulOperations)).toBe(3);expect(number(r.total.seconds)).toBe(3);expect(number(r.memory[0]?.peakBytes)).toBe(16);expect(r.schedule).toHaveLength(3);
  });
  it('C05 serial scratch lifetime gives 8.5 ms and 3 GiB rather than summing both workspaces',async()=>{
    const {scenario,assets,model}=echo();if(model.definition.kind!=='model')throw Error();const g=model.definition.graph;g.inputs=[];g.outputs=[];g.tensors=[];g.states=[];g.edges=[];
    g.storages=[['wa',2*2**30],['wb',3*2**30]].map(([id,bytes])=>{if(typeof id!=='string'||typeof bytes!=='number')throw Error();return {storageId:StorageId.parse(id),name:id,category:'workspace',sharingDomain:'instance',allocation:{kind:'bytes',value:{kind:'literal',quantity:{value:bytes,unit:'byte'}}}};});
    g.nodes=[['prepare',0.001],['A',0.002],['B',0.005],['join',0.0005]].map(([id,seconds])=>{if(typeof id!=='string'||typeof seconds!=='number')throw Error();return {nodeId:NodeId.parse(id),name:id,phases:['decode'],portBindings:[],stateBindings:[],body:{kind:'opaque',inputs:[],outputs:[],cost:{compute:[],memoryAccess:[],temporaryStorageIds:id==='A'?[StorageId.parse('wa')]:id==='B'?[StorageId.parse('wb')]:[],timing:{kind:'fixed',seconds,description:'Synthetic branch'}}}};});
    g.dependencies=[['prepare','A'],['prepare','B'],['A','join'],['B','join']].map(([from,to],i)=>({edgeId:String(i),fromNodeId:NodeId.parse(from),toNodeId:NodeId.parse(to),kind:'control'}));
    const hw=assets.find(a=>a.definition.kind==='hardware');if(hw?.definition.kind!=='hardware')throw Error();hw.definition.hardware.capacityBytes=16*2**30;
    const r=available(await analyzeScenario(scenario,assets));expect(number(r.total.seconds)).toBeCloseTo(0.0085,12);expect(number(r.memory[0]?.peakBytes)).toBe(3*2**30);expect(r.memory[0]?.peakPoint).toMatchObject({kind:'time',nodeId:'B',seconds:0.003});
  });
  it('missing compute/HBM inputs preserve known work and memory while time is unavailable, not zero',async()=>{
    const {scenario,assets}=c01(),hardware=assets.find(a=>a.definition.kind==='hardware');if(hardware?.definition.kind!=='hardware')throw Error();hardware.definition.hardware.computeCapabilities=[];
    const r=available(await analyzeScenario(scenario,assets));expect(r.total.seconds.status).toBe('unavailable');expect(number(r.total.compute[0]?.usefulOperations)).toBe(1024);expect(number(r.memory[0]?.peakBytes)).toBe(448);expect(r.memory[0]?.peakPoint.kind).toBe('order');expect(r.schedule).toEqual([]);
    const second=c01(),op=second.assets.find(a=>a.definition.kind==='operator');if(op?.definition.kind!=='operator')throw Error();for(const a of op.definition.operator.cost.memoryAccess)delete a.hbmEstimate;
    const missing=available(await analyzeScenario(second.scenario,second.assets));expect(missing.total.hbmBytes.status).toBe('unavailable');expect(missing.total.seconds.status).toBe('unavailable');expect(missing.roofline[0]?.trafficBasis).toBe('logical');
  });
  it('records explicit storage/timing overrides without inferring quantized compute speed or replacing other costs',async()=>{
    const {scenario,assets}=c01();scenario.numericOverrides.push({target:{kind:'storage',storageId:StorageId.parse('sW')},field:'memory_bytes',value:{value:72,unit:'byte'}},{target:{kind:'node',nodeId:NodeId.parse('module/op')},field:'fixed_seconds',value:{value:2,unit:'second'}});
    const r=available(await analyzeScenario(scenario,assets));expect(number(r.memory[0]?.peakBytes)).toBe(264);expect(number(r.total.seconds)).toBe(2);expect(number(r.total.hbmBytes)).toBe(448);expect(r.total.compute[0]?.computeClass.multiplyDtype.format).toBe('bf16');
  });
  it('reports an exceeded capacity without suppressing the declared mathematical costs',async()=>{
    const {scenario,assets}=c01(),hardware=assets.find(a=>a.definition.kind==='hardware');if(hardware?.definition.kind!=='hardware')throw Error();hardware.definition.hardware.capacityBytes=400;
    const r=available(await analyzeScenario(scenario,assets));expect(number(r.memory[0]?.peakBytes)).toBe(448);expect(r.diagnostics.some(d=>d.code==='capacity_exceeded')).toBe(true);expect(number(r.total.seconds)).toBe(4.48);
  });
  it('does not silently discard multi-device, multi-step or stream execution inputs',async()=>{
    for(const kind of ['devices','steps','streams'] as const){const {scenario,assets}=c01();if(kind==='devices'){const first=scenario.deviceTopology.devices[0];if(!first)throw Error();scenario.deviceTopology.devices.push({...first,deviceId:DeviceId.parse('gpu1')});}else if(kind==='steps'){if(scenario.workload.kind==='decode')scenario.workload.steps=2;}else scenario.executionPlan={kind:'streams',assignments:[],extraDependencies:[],resourcePolicy:{kind:'ideal'}};
      const result=await analyzeScenario(scenario,assets);if(kind==='devices'){expect(result.status).toBe('available');if(result.status==='available'){expect(result.result.total.seconds.status).toBe('unavailable');expect(result.result.memory.every(m=>m.peakBytes.status==='unavailable')).toBe(true);expect(result.result.diagnostics.some(d=>d.code==='missing_local_cost_rule')).toBe(true);}}else if(kind==='steps'){expect(result.status).toBe('available');if(result.status==='available'){expect(result.result.decode?.steps).toHaveLength(2);expect(number(result.result.total.seconds)).toBe(8.96);}}else {expect(result.status).toBe('available');if(result.status==='available'){expect(result.result.distributed?.layout.execution).toMatchObject({status:'available',result:{policy:'streams'}});expect(number(result.result.total.seconds)).toBe(4.48);}}}
  });
  it('C04 keeps one aliased batch state allocation and counts both complete reads',async()=>{
    const {scenario,assets,model}=echo();if(model.definition.kind!=='model')throw Error();const g=model.definition.graph;model.parameters=[];g.inputs=[];g.outputs=[];g.edges=[];g.dependencies=[];
    g.storages=[{storageId:StorageId.parse('state'),name:'state',category:'state',sharingDomain:'request',allocation:{kind:'bytes',value:{kind:'literal',quantity:{value:192,unit:'byte'}}}},{storageId:StorageId.parse('alias'),name:'alias',category:'state',sharingDomain:'request',allocation:{kind:'alias',targetStorageId:StorageId.parse('state')}}];
    g.tensors=[{tensorId:TensorId.parse('S'),name:'state',shape:[{axisId:'bytes',semantic:'custom',size:{kind:'literal',quantity:{value:192,unit:'count'}}}],dtype:{category:'uint',bits:8,format:'u8'},storageId:StorageId.parse('state')}];
    g.nodes=['A','B'].map(id=>({nodeId:NodeId.parse(id),name:id,phases:['decode'],portBindings:[{portId:'x',tensorId:TensorId.parse('S')}],stateBindings:[],body:{kind:'opaque',inputs:[{portId:'x',tensorId:TensorId.parse('S')}],outputs:[],cost:{compute:[],memoryAccess:[{accessId:id,storageId:StorageId.parse(id==='A'?'state':'alias'),mode:'read',logicalBytes:{kind:'literal',quantity:{value:192,unit:'byte'}},hbmEstimate:{kind:'factor',value:1}}],temporaryStorageIds:[],timing:{kind:'fixed',seconds:1,description:'Explicit reader'}}}}));
    g.states=[{stateId:StateId.parse('s'),name:'shared request state (batch 3 included)',stateKind:'kv',storageIds:[StorageId.parse('state')],creator:{kind:'initialized'},readers:['A','B'].map(id=>({kind:'node',nodeId:NodeId.parse(id),portId:'x'})),writers:[],updatePolicy:{kind:'static'}}];scenario.workload.batchSize=3;
    const r=available(await analyzeScenario(scenario,assets));expect(number(r.memory[0]?.peakBytes)).toBe(192);expect(number(r.total.logicalReadBytes)).toBe(384);expect(number(r.total.hbmBytes)).toBe(384);
  });
  it('does not turn positive intervals swallowed by accumulated time precision into zero-duration work',async()=>{
    const f=echo('chain');f.scenario.numericOverrides=[{target:{kind:'node',nodeId:NodeId.parse('block[0]')},field:'fixed_seconds',value:{value:1e308,unit:'second'}}];const r=available(await analyzeScenario(f.scenario,f.assets));expect(r.total.seconds.status).toBe('unavailable');expect(r.schedule).toHaveLength(1);expect(r.diagnostics.map(d=>d.code)).toContain('numeric_overflow');expect(number(r.nodes[1]?.cost.seconds)).toBe(1);
  });
});






