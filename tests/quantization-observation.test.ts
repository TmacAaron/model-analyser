import {it,expect} from 'vitest';
import {NodeId,StorageId,StorageSpec,ParameterDef,type Scenario} from '@model-analyser/contracts';
import {instantiateModel} from '@model-analyser/core';
import {makeQuantizationScopeProject} from '../scripts/quantization-scope-project.js';
import {quantizationEmitter,type QuantizationObservation} from '../packages/core/src/quantization-observation.js';
import {applyStorageAllocationOverrides} from '../packages/core/src/storage-allocation-overrides.js';
import type {InstantiatedCostCapture} from '../packages/core/src/instantiate.js';
import {assetParameterFrameId,type ParameterCaptureTrace} from '../packages/core/src/parameter-observation.js';
import {parameterBindingGraph} from '../packages/core/src/parameter-binding-graph.js';

it('captures a later shared consumer by actual frame identity, while preserving selected-call snapshots and execution',()=>{
 const p=makeQuantizationScopeProject('shared'),s=p.scenarios[0]!,calls:InstantiatedCostCapture[]=[],traces:ParameterCaptureTrace[]=[];
 p.assetSnapshots.find(a=>a.definition.kind==='operator')!.parameters.push(ParameterDef.parse({key:'Unused',name:'Unused count',type:'integer',unit:'count',default:{kind:'integer',value:99}}));
 const ordinary=instantiateModel(s,p.assetSnapshots),observed=instantiateModel(s,p.assetSnapshots,undefined,undefined,{nodeId:'a',cost:c=>{calls.push(c);},bindings:true,bindingNodes:['b'],bindingTraceReady:trace=>{traces.push(structuredClone(trace));for(const frame of trace.frames)if(frame.symbols['P'])frame.symbols['P'].value=999;}});
 expect(observed).toEqual(ordinary);expect(calls).toHaveLength(1);expect(traces).toHaveLength(1);
 expect(calls[0]!.bindingContext!.trace.frames.some(f=>f.nodeId==='b')).toBe(false);expect(traces[0]!.frames.some(f=>f.id===assetParameterFrameId('b')&&f.symbols['P']?.value===3)).toBe(true);
 const call={...calls[0]!,bindingContext:{...calls[0]!.bindingContext!,trace:traces[0]!}},graph=parameterBindingGraph(call,p.assetSnapshots,256,[{frameId:assetParameterFrameId('b'),name:'P',quantity:{value:3,unit:'count'},target:'shared auxiliary count'}]);
 expect(graph.scope).toBe('actual_call_storage_and_quantization_parameter_context');expect(graph.complete).toBe(true);expect(graph.roots.filter(r=>r.role==='quantization').map(r=>r.name)).toEqual(['P']);const root=graph.roots.find(r=>r.role==='quantization');expect(root).toMatchObject({target:'shared auxiliary count',name:'P',frameId:assetParameterFrameId('b')});
});

for(const kind of ['short','nested','ancestor','repeat','shared','conflict'] as const)it(`quantization observation preserves the complete ${kind} result, including failures`,()=>{
 const p=makeQuantizationScopeProject(kind),s=p.scenarios[0]!,before=structuredClone(p);
 const original=instantiateModel(s,p.assetSnapshots),plain=instantiateModel({...s,quantizationOverrides:[]},p.assetSnapshots);
 if(plain.status!=='available')throw Error('Unquantized fixture must expand');
 const ids=new Set(plain.resolved.graph.storages.filter(x=>x.allocation.kind!=='alias').map(x=>x.storageId)),events:QuantizationObservation[]=[];
 const observed=instantiateModel(s,p.assetSnapshots,undefined,undefined,{nodeId:'$unused',cost:()=>{},quantization:{storageIds:ids,record:event=>{events.push(event);}}});
 expect(observed).toEqual(original);expect(p).toEqual(before);
 expect(events.some(e=>e.kind==='scope_assignment')).toBe(true);
 if(kind==='conflict'){expect(original.status).toBe('unavailable');expect(events.some(e=>e.kind==='storage_applied'&&e.storageId==='shared')).toBe(false);}
 else expect(events.filter(e=>e.kind==='storage_applied').map(e=>e.application)).toEqual(original.status==='available'?original.resolved.quantizationApplications:[]);
});

it('records actual scoped winners and allocator values only for the selected storage',()=>{
 const p=makeQuantizationScopeProject(),events:QuantizationObservation[]=[],selected=StorageId.parse('x::left');
 instantiateModel(p.scenarios[0]!,p.assetSnapshots,undefined,undefined,{nodeId:'x',cost:()=>{},quantization:{storageIds:new Set([selected]),record:e=>{events.push(e);}}});
 expect(new Set(events.map(e=>e.storageId))).toEqual(new Set([selected]));
 expect(events.filter(e=>e.kind==='scope_assignment').filter(e=>e.assignment.name==='P').map(e=>[e.assignment.source.kind==='parameter'?e.assignment.source.parameter.nodeId:undefined,e.assignment.quantity.value])).toEqual([['$model',2],['x',3]]);
 expect(events.find(e=>e.kind==='storage_before')).toMatchObject({allocation:{totalBytes:{status:'available',quantity:{value:8,unit:'byte'}}}});
 expect(events.find(e=>e.kind==='storage_applied')).toMatchObject({allocation:{totalBytes:{status:'available',quantity:{value:14,unit:'byte'}}},application:{beforeBytes:8,afterBytes:14,assignmentIndices:[0]}});
});

it('mutating or stopping quantization evidence cannot change calculation or source inputs',()=>{
 const p=makeQuantizationScopeProject(),s=p.scenarios[0]!,before=structuredClone(p),normal=instantiateModel(s,p.assetSnapshots);
 const mutate=instantiateModel(s,p.assetSnapshots,undefined,undefined,{nodeId:'x',cost:()=>{},quantization:{storageIds:new Set(['x::left','x::right']),record:event=>{
  if(event.kind==='scope_assignment')event.assignment.quantity.value=999;
  if(event.kind==='storage_applied'){event.application.afterBytes=999;event.storage.name='mutated';}
  if(event.kind==='specification_bound')event.specification.payloadBits=1;
 }}});expect(mutate).toEqual(normal);expect(p).toEqual(before);
 let count=0,truncated=0;const limited=instantiateModel(s,p.assetSnapshots,undefined,undefined,{nodeId:'x',cost:()=>{},quantization:{storageIds:new Set(['x::left']),record:()=>{count++;return false;},truncated:()=>{truncated++;}}});
 expect(limited).toEqual(normal);expect(count).toBe(1);expect(truncated).toBe(1);
});

it('bounds quantization evidence before cloning further events',()=>{
 let count=0,truncated=0;const emit=quantizationEmitter({storageIds:new Set(['s']),record:()=>{count++;},truncated:()=>{truncated++;}})!;
 const event:QuantizationObservation={kind:'rule_decision',storageId:StorageId.parse('s'),nodeId:NodeId.parse('n'),winners:[],losers:[]};
 for(let i=0;i<1100;i++)emit(event);expect(count).toBe(1024);expect(truncated).toBe(1);
});

it('records storage overrides in execution order as detached explicit allocation roots',()=>{
 const storages=[StorageSpec.parse({storageId:'s',name:'Storage',category:'weight',sharingDomain:'instance',allocation:{kind:'bytes',value:{kind:'literal',quantity:{value:14,unit:'byte'}}}})];
 const overrides:Scenario['numericOverrides']=[2,0].map(value=>({target:{kind:'storage',storageId:StorageId.parse('s')},field:'memory_bytes',value:{value,unit:'byte'}})),seen:number[]=[];
 applyStorageAllocationOverrides(storages,overrides,e=>{seen.push(e.overrideIndex);e.override.value.value=999;e.after={kind:'bytes',value:{kind:'literal',quantity:{value:999,unit:'byte'}}};});
 expect(seen).toEqual([0,1]);expect(overrides.map(o=>o.value.value)).toEqual([2,0]);expect(storages[0]!.allocation).toEqual({kind:'bytes',value:{kind:'literal',quantity:{value:0,unit:'byte'}}});
 const missing:Scenario['numericOverrides']=[{...overrides[0]!,target:{kind:'storage',storageId:StorageId.parse('missing')}}];expect(()=>applyStorageAllocationOverrides(storages,missing)).toThrow('显存覆盖引用缺失存储');
 storages.push(StorageSpec.parse({...storages[0],storageId:'alias',allocation:{kind:'alias',targetStorageId:'s'}}));expect(()=>applyStorageAllocationOverrides(storages,[{...overrides[0]!,target:{kind:'storage',storageId:StorageId.parse('alias')}}])).toThrow('不能独立覆盖 alias');
});
