import { describe,it,expect } from 'vitest';
import { DeviceId,NodeId,StorageId } from '@model-analyser/contracts';
import { MetricFactory } from '../packages/core/src/metrics.js';
import { lifetimePeak } from '../packages/core/src/liveness.js';
const metrics=()=>new MetricFactory([],{assetRefs:[],formulaRefs:[],parameterSources:[],assumptions:[]},'liveness-test');
describe('canonical allocation event sweep',()=>{
  it('counts a pass-through initial input even when there are no compute nodes',()=>{
    const m=metrics(),id=StorageId.parse('input');const peak=lifetimePeak([{storageId:id,category:'activation',bytes:m.available(64,'byte')}],[],[id],[id],[],DeviceId.parse('gpu'),1024,m);expect(peak.peakBytes).toMatchObject({status:'available',quantity:{value:64}});
  });
  it('retains a returned workspace through the phase instead of releasing it as scratch',()=>{
    const m=metrics(),out=StorageId.parse('out'),scratch=StorageId.parse('scratch'),steps=[{nodeId:NodeId.parse('produce'),reads:[],writes:[out],temporary:[]},{nodeId:NodeId.parse('middle'),reads:[],writes:[],temporary:[]},{nodeId:NodeId.parse('last'),reads:[],writes:[],temporary:[scratch]}];const peak=lifetimePeak([{storageId:out,category:'workspace',bytes:m.available(64,'byte')},{storageId:scratch,category:'workspace',bytes:m.available(128,'byte')}],steps,[],[out],[],DeviceId.parse('gpu'),1024,m);expect(peak.peakBytes).toMatchObject({quantity:{value:192}});expect(peak.peakPoint).toEqual({kind:'order',index:2,nodeId:'last'});
  });
  it('refuses an inexact allocation sum rather than rounding the peak',()=>{
    const m=metrics(),peak=lifetimePeak([{storageId:StorageId.parse('a'),category:'weight',bytes:m.available(Number.MAX_SAFE_INTEGER,'byte')},{storageId:StorageId.parse('b'),category:'weight',bytes:m.available(1,'byte')}],[],[],[],[],DeviceId.parse('gpu'),Number.MAX_SAFE_INTEGER,m);expect(peak.peakBytes.status).toBe('unavailable');expect(m.diagnostics.map(d=>d.code)).toContain('numeric_overflow');
  });
  it('retains an initial workspace until a later consumer across unrelated scratch use',()=>{
    const m=metrics(),input=StorageId.parse('input'),scratch=StorageId.parse('scratch'),steps=[{nodeId:NodeId.parse('first'),reads:[],writes:[],temporary:[]},{nodeId:NodeId.parse('middle'),reads:[],writes:[],temporary:[scratch]},{nodeId:NodeId.parse('consume'),reads:[input],writes:[],temporary:[]}];const peak=lifetimePeak([{storageId:input,category:'workspace',bytes:m.available(64,'byte')},{storageId:scratch,category:'workspace',bytes:m.available(128,'byte')}],steps,[input],[],[],DeviceId.parse('gpu'),1024,m);expect(peak.peakBytes).toMatchObject({quantity:{value:192}});expect(peak.peakPoint).toEqual({kind:'order',index:1,nodeId:'middle'});
  });
});
