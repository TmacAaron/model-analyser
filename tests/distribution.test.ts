import { describe,it,expect } from 'vitest';
import { z } from 'zod';
import Ajv2020 from 'ajv/dist/2020.js';
import { DeviceTopology,TensorSpec,StorageSpec,StorageId,TensorDistribution,TensorPartitionResult,StoragePartitionResult,CommunicationEvaluation,CommunicationDefinition,MetricScope,type TensorPartitionAttempt,type StoragePartitionAttempt,type CommunicationAttempt,type MetricValue } from '@model-analyser/contracts';
import { partitionTensor,allocateDistributedStorage,evaluateCommunication } from '@model-analyser/core';
const literal=(value:number,unit='count')=>({kind:'literal',quantity:{value,unit}});
const context={symbols:{},assets:[]};
function topology(n=2){return DeviceTopology.parse({devices:Array.from({length:n},(_,i)=>({deviceId:'gpu'+i,hardware:{assetId:'synthetic-hardware',revision:1,kind:'hardware'}})),groups:[{groupId:'tp',members:Array.from({length:n},(_,i)=>'gpu'+i),mesh:{axes:[{axisId:'tp',size:n}],coordinates:Array.from({length:n},(_,i)=>({deviceId:'gpu'+i,coordinates:[i]}))}}]});}
function tensor(n=8){return TensorSpec.parse({tensorId:'T',name:'Synthetic tensor',storageId:'S',shape:[{axisId:'n',semantic:'token',size:literal(n)}],dtype:{category:'float',bits:16,format:'bf16'}});}
const sharded=(policy:Extract<TensorDistribution,{kind:'sharded'}>['policy']={kind:'even'}):TensorDistribution=>({kind:'sharded',groupId:'tp',axes:[{tensorAxisId:'n',meshAxisId:'tp'}],policy});
const split=(attempt:TensorPartitionAttempt)=>{expect(attempt.status,JSON.stringify(attempt)).toBe('available');if(attempt.status!=='available')throw Error();return attempt.result;};
const allocation=(attempt:StoragePartitionAttempt)=>{expect(attempt.status,JSON.stringify(attempt)).toBe('available');if(attempt.status!=='available')throw Error();return attempt.result;};
const communication=(attempt:CommunicationAttempt)=>{expect(attempt.status,JSON.stringify(attempt)).toBe('available');if(attempt.status!=='available')throw Error();return attempt.result;};
const value=(metric:MetricValue|undefined)=>{expect(metric?.status).toBe('available');if(metric?.status!=='available')throw Error();return metric.quantity.value;};
function comm(operation:CommunicationDefinition['operation']='all_reduce'){
  return CommunicationDefinition.parse({operation,groupId:'tp',source:{tensorId:'T',distribution:{kind:'partial',groupId:'tp',reduceOperation:'sum'}},destination:{tensorId:'T',distribution:{kind:'replicated',groupId:'tp'}},payloadDtype:{category:'float',bits:16,format:'bf16'},sendBytesPerMember:literal(1000,'byte'),receiveBytesPerMember:literal(1000,'byte'),algorithm:{name:'Explicit ring coefficient for four members',trafficFactor:1.5,startupRounds:3},timing:{kind:'bandwidth_latency',bytePerSecond:1e6,latencySeconds:0.001}});
}
const scope=(n=4)=>MetricScope.parse({phase:'decode',target:{kind:'node',nodeId:'collective'},deviceIds:Array.from({length:n},(_,i)=>'gpu'+i),aggregation:'group_total'});

describe('logical tensor to physical device placement',()=>{
  it('partitions exact and padded dimensions without counting padding as useful data',()=>{
    expect(split(partitionTensor(tensor(),sharded(),topology(),context)).placements.map(p=>[p.logicalElements,p.allocatedElements,p.slices[0]?.start,p.slices[0]?.end])).toEqual([[4,4,0,4],[4,4,4,8]]);
    expect(partitionTensor(tensor(9),sharded(),topology(),context).status).toBe('unavailable');
    const padded=split(partitionTensor(tensor(9),sharded({kind:'padded'}),topology(),context));expect(padded.coverage).toBe('padded');expect(padded.placements.map(p=>[p.logicalElements,p.allocatedElements,p.slices[0]?.start,p.slices[0]?.end])).toEqual([[5,5,0,5],[4,5,5,9]]);
    expect(split(partitionTensor(tensor(1),sharded({kind:'padded'}),topology(4),context)).placements.map(p=>[p.logicalElements,p.allocatedElements])).toEqual([[1,1],[0,1],[0,1],[0,1]]);
    expect(split(partitionTensor(tensor(0),sharded(),topology(),context)).placements.every(p=>p.allocatedElements===0)).toBe(true);
  });
  it('spreads a balanced remainder without inflating useful work or truncating padded slots',()=>{
    const policy=sharded({kind:'balanced'}),devices=topology(8),observed:unknown[]=[];
    const balanced=split(partitionTensor(tensor(10),policy,devices,context,{
      deviceId:devices.devices[6]!.deviceId,record:operation=>observed.push(operation),
    }));
    expect(balanced.coverage).toBe('padded');
    expect(balanced.placements.map(p=>[p.logicalElements,p.allocatedElements,p.slices[0]?.start,p.slices[0]?.end]))
      .toEqual([[2,2,0,2],[2,2,2,4],[1,2,4,5],[1,2,5,6],[1,2,6,7],[1,2,7,8],[1,2,8,9],[1,2,9,10]]);
    expect(observed).toContainEqual({kind:'axis',axisId:'n',method:'balanced',extent:10,logical:1,allocated:2,start:8,end:9,
      mesh:{axisId:'tp',width:8,rank:6}});
    expect(split(partitionTensor(tensor(2),policy,topology(4),context)).placements.map(p=>[p.logicalElements,p.allocatedElements]))
      .toEqual([[1,1],[1,1],[0,1],[0,1]]);
  });
  it('retains replicas along unused mesh axes, and reuses actual devices across differently named groups',()=>{
    const t=topology(4),g=t.groups[0];if(!g)throw Error();g.mesh={axes:[{axisId:'tp',size:2},{axisId:'dp',size:2}],coordinates:t.devices.map((d,i)=>({deviceId:d.deviceId,coordinates:[Math.floor(i/2),i%2]}))};
    const r=split(partitionTensor(tensor(),sharded(),t,context));expect(r.placements.map(p=>[p.deviceId,p.slices[0]?.start,p.logicalElements])).toEqual([['gpu0',0,4],['gpu1',0,4],['gpu2',4,4],['gpu3',4,4]]);
    t.groups.push({...g,groupId:'reused'});expect(split(partitionTensor(tensor(),{kind:'replicated',groupId:'reused'},t,context)).placements.map(p=>p.deviceId)).toEqual(t.devices.map(d=>d.deviceId));
  });
  it('validates complete explicit slices, including uneven sizes, gaps, overlaps, duplicates and replica consistency',()=>{
    const t=topology(),slices=[{deviceId:t.devices[0]?.deviceId,axisId:'n',start:0,end:3},{deviceId:t.devices[1]?.deviceId,axisId:'n',start:3,end:8}],policy={kind:'explicit',slices} as const;
    const layout=TensorDistribution.parse({...sharded(),policy});expect(split(partitionTensor(tensor(),layout,t,context)).placements.map(p=>p.allocatedElements)).toEqual([3,5]);
    for(const boundaries of [[4,3],[2,3],[3,2]]){const invalid=structuredClone(layout);if(invalid.kind!=='sharded'||invalid.policy.kind!=='explicit')throw Error();const a=invalid.policy.slices[0],b=invalid.policy.slices[1];if(!a||!b)throw Error();a.end=boundaries[0]??0;b.start=boundaries[1]??0;expect(partitionTensor(tensor(),invalid,t,context).status).toBe('unavailable');}
    const missing=structuredClone(layout);if(missing.kind!=='sharded'||missing.policy.kind!=='explicit')throw Error();missing.policy.slices.pop();expect(partitionTensor(tensor(),missing,t,context).status).toBe('unavailable');
    const replicatedMesh=topology(4),rg=replicatedMesh.groups[0];if(!rg)throw Error();rg.mesh={axes:[{axisId:'tp',size:2},{axisId:'dp',size:2}],coordinates:replicatedMesh.devices.map((d,i)=>({deviceId:d.deviceId,coordinates:[Math.floor(i/2),i%2]}))};
    const copies=TensorDistribution.parse({...sharded(),policy:{kind:'explicit',slices:replicatedMesh.devices.map((d,i)=>({deviceId:d.deviceId,axisId:'n',start:i<2?0:3,end:i<2?3:8}))}});expect(split(partitionTensor(tensor(),copies,replicatedMesh,context)).placements.map(p=>p.logicalElements)).toEqual([3,3,5,5]);if(copies.kind!=='sharded'||copies.policy.kind!=='explicit')throw Error();const altered=copies.policy.slices[1];if(!altered)throw Error();altered.end=4;expect(partitionTensor(tensor(),copies,replicatedMesh,context).status).toBe('unavailable');
  });
  it('supports multi-axis rectangular partitions, while rejecting reuse of a mesh axis for diagonal fragments',()=>{
    const t=topology(4),g=t.groups[0],x=tensor();if(!g)throw Error();g.mesh={axes:[{axisId:'x',size:2},{axisId:'y',size:2}],coordinates:t.devices.map((d,i)=>({deviceId:d.deviceId,coordinates:[Math.floor(i/2),i%2]}))};x.shape.push({axisId:'h',semantic:'head',size:literal(4,'count') as typeof x.shape[number]['size']});
    const d:TensorDistribution={kind:'sharded',groupId:'tp',axes:[{tensorAxisId:'n',meshAxisId:'x'},{tensorAxisId:'h',meshAxisId:'y'}],policy:{kind:'even'}};expect(split(partitionTensor(x,d,t,context)).placements.map(p=>p.allocatedElements)).toEqual([8,8,8,8]);d.axes[1]={tensorAxisId:'h',meshAxisId:'x'};expect(partitionTensor(x,d,t,context).status).toBe('unavailable');
  });
  it('keeps manual local shapes/copies explicit and partial values separate from replicated results',()=>{
    const t=topology(),d:TensorDistribution={kind:'manual',groupId:'tp',description:'User-defined irregular local workload',members:t.devices.map((device,i)=>({deviceId:device.deviceId,copies:i+1,localShape:[{axisId:'local',semantic:'custom',size:{kind:'literal',quantity:{value:i+2,unit:'count'}}}]}))};
    const r=split(partitionTensor(tensor(),d,t,context));expect(r.coverage).toBe('manual');expect(r.placements.map(p=>[p.allocatedElements,p.copies])).toEqual([[2,1],[3,2]]);
    expect(split(partitionTensor(tensor(),{kind:'partial',groupId:'tp',reduceOperation:'sum'},t,context)).coverage).toBe('partial');
  });
  it('rejects broken mesh mappings, unbound/wrong-unit dimensions and unsafe exact element counts',()=>{
    const t=topology(),g=t.groups[0];if(!g?.mesh)throw Error();g.mesh.coordinates[1]=structuredClone(g.mesh.coordinates[0]??{deviceId:t.devices[0]?.deviceId,coordinates:[0]}) as typeof g.mesh.coordinates[number];expect(partitionTensor(tensor(),sharded(),t,context).status).toBe('unavailable');
    const x=tensor();x.shape[0]={axisId:'n',semantic:'token',size:{kind:'symbol',name:'missing'}};expect(partitionTensor(x,sharded(),topology(),context).status).toBe('unavailable');
    x.shape=[{axisId:'n',semantic:'token',size:{kind:'literal',quantity:{value:Number.MAX_SAFE_INTEGER,unit:'count'}}},{axisId:'h',semantic:'head',size:{kind:'literal',quantity:{value:2,unit:'count'}}}];expect(partitionTensor(x,{kind:'replicated',groupId:'tp'},topology(),context).status).toBe('unavailable');
  });
});

describe('physical distributed storage and quantization',()=>{
  it('reproduces C03 GQA KV: sharded 512 bytes/device versus replicated 1024, with physical group reuse',()=>{
    const t=tensor();t.shape=[['kv',2],['b',2],['t',16],['h',2],['d',4]].map(([id,size])=>({axisId:String(id),semantic:'custom',size:{kind:'literal',quantity:{value:Number(size),unit:'count'}}}));
    const storage=StorageSpec.parse({storageId:'S',name:'C03 KV',category:'state',sharingDomain:'device_group',allocation:{kind:'tensor',shape:t.shape,dtype:t.dtype}}),shard:TensorDistribution={kind:'sharded',groupId:'tp',axes:[{tensorAxisId:'h',meshAxisId:'tp'}],policy:{kind:'even'}};
    expect(allocation(allocateDistributedStorage(storage.storageId,[storage],shard,topology(),context)).perDevice.map(p=>value(p.totalBytes))).toEqual([512,512]);
    expect(allocation(allocateDistributedStorage(storage.storageId,[storage],{kind:'replicated',groupId:'tp'},topology(),context)).perDevice.map(p=>value(p.totalBytes))).toEqual([1024,1024]);
    const alias=StorageSpec.parse({...storage,storageId:'alias',allocation:{kind:'alias',targetStorageId:'S'}});const r=allocation(allocateDistributedStorage(alias.storageId,[storage,alias],shard,topology(),context));expect(r.canonicalStorageId).toBe('S');expect(r.perDevice.map(p=>value(p.totalBytes))).toEqual([512,512]);
  });
  it('recomputes group scales locally rather than dividing global quantized bytes, and multiplies complete manual copies',()=>{
    const t=tensor(130),s=StorageSpec.parse({storageId:'Q',name:'W4',category:'weight',sharingDomain:'instance',allocation:{kind:'tensor',shape:t.shape,dtype:t.dtype,quantization:{payloadBits:4,packingUnitElements:1,alignmentBytes:1,auxiliaries:[{name:'scale',dtype:{category:'float',bits:16,format:'f16'},count:{kind:'group',groupSize:32}}]}}});
    const r=allocation(allocateDistributedStorage(s.storageId,[s],sharded(),topology(),context));expect(r.perDevice.map(p=>[value(p.allocation.payloadBytes),value(p.allocation.auxiliaryBytes[0]?.bytes),value(p.totalBytes)])).toEqual([[33,6,39],[33,6,39]]);
    const padded=allocation(allocateDistributedStorage(s.storageId,[s],sharded({kind:'padded'}),topology(3),context));expect(padded.perDevice.map(p=>value(p.totalBytes))).toEqual([26,26,26]);
    const manual:TensorDistribution={kind:'manual',groupId:'tp',description:'Two independent local copies',members:topology().devices.map(d=>({deviceId:d.deviceId,copies:2,localShape:[{axisId:'n',semantic:'token',size:{kind:'literal',quantity:{value:65,unit:'count'}}}]}))};expect(allocation(allocateDistributedStorage(s.storageId,[s],manual,topology(),context)).perDevice.map(p=>value(p.totalBytes))).toEqual([78,78]);
  });
  it('does not infer a byte allocation sharding axis and isolates alias cycles/missing storage',()=>{
    const s=StorageSpec.parse({storageId:'B',name:'bytes',category:'runtime',sharingDomain:'instance',allocation:{kind:'bytes',value:literal(320,'byte')}});expect(allocation(allocateDistributedStorage(s.storageId,[s],{kind:'replicated',groupId:'tp'},topology(),context)).perDevice.map(p=>value(p.totalBytes))).toEqual([320,320]);expect(allocateDistributedStorage(s.storageId,[s],sharded(),topology(),context).status).toBe('unavailable');
    s.allocation={kind:'alias',targetStorageId:s.storageId};expect(allocateDistributedStorage(s.storageId,[s],{kind:'replicated',groupId:'tp'},topology(),context).status).toBe('unavailable');expect(allocateDistributedStorage(StorageId.parse('missing'),[],sharded(),topology(),context).status).toBe('unavailable');
  });
});

describe('explicit communication cost',()=>{
  it('applies the ring coefficient once: per-member 1500 bytes, group payload 4000, collective span 4.5 ms',()=>{
    const c=comm(),r=communication(evaluateCommunication(c,scope(),[tensor()],topology(4),context)),cost=r.cost.communications[0];expect(value(cost?.sendBytesPerMember)).toBe(1000);expect(value(cost?.algorithmTrafficBytesPerMember)).toBe(1500);expect(value(cost?.groupSendBytes)).toBe(4000);expect(value(cost?.groupReceiveBytes)).toBe(4000);expect(value(r.cost.seconds)).toBeCloseTo(0.0045,12);expect(r.perDevice.map(p=>value(p.algorithmTrafficBytes))).toEqual([1500,1500,1500,1500]);expect(r.cost.hbmBytes.status).toBe('unavailable');expect(r.definition).toEqual(c);
  });
  it('send_recv counts the sender and receiver once, even if their enclosing group has idle devices',()=>{
    const c=comm('send_recv');c.source.distribution={kind:'replicated',groupId:'tp'};c.sourceDeviceId=topology(4).devices[0]?.deviceId;c.destinationDeviceId=topology(4).devices[3]?.deviceId;const s=scope();s.deviceIds=s.deviceIds.filter(id=>id==='gpu0'||id==='gpu3');const r=communication(evaluateCommunication(c,s,[tensor()],topology(4),context));expect(r.perDevice.map(p=>[p.deviceId,value(p.sendBytes),value(p.receiveBytes)])).toEqual([['gpu0',1000,0],['gpu3',0,1000]]);expect(value(r.cost.communications[0]?.groupSendBytes)).toBe(1000);
  });
  it('rejects a point-to-point copy that would silently reduce partial values',()=>{
    const c=comm('send_recv'),s=scope();c.sourceDeviceId=DeviceTopology.shape.devices.element.shape.deviceId.parse('gpu0');c.destinationDeviceId=DeviceTopology.shape.devices.element.shape.deviceId.parse('gpu3');s.deviceIds=s.deviceIds.filter(id=>id==='gpu0'||id==='gpu3');expect(evaluateCommunication(c,s,[tensor()],topology(4),context).status).toBe('unavailable');
  });
  it('requires actual collective layout transitions and supports AllGather, ReduceScatter and AllToAll',()=>{
    const t=tensor(8),top=topology(4);
    const gather=comm('all_gather');gather.source.distribution=sharded();expect(evaluateCommunication(gather,scope(),[t],top,context).status).toBe('available');
    const scatter=comm('reduce_scatter');scatter.destination.distribution=sharded();expect(evaluateCommunication(scatter,scope(),[t],top,context).status).toBe('available');
    const all=comm('all_to_all');all.source.distribution=sharded();all.destination.distribution=sharded();expect(evaluateCommunication(all,scope(),[t],top,context).status).toBe('available');
    const bad=comm();bad.source.distribution={kind:'replicated',groupId:'tp'};expect(evaluateCommunication(bad,scope(),[t],top,context).status).toBe('unavailable');
  });
  it('accepts equivalent physical group reuse and rejects different members, scope mismatch and invalid logical shape',()=>{
    const top=topology(4),g=top.groups[0];if(!g)throw Error();top.groups.push({...g,groupId:'reuse'});const c=comm();c.source.distribution.groupId='reuse';expect(evaluateCommunication(c,scope(),[tensor()],top,context).status).toBe('available');
    const s=scope();s.deviceIds.pop();expect(evaluateCommunication(c,s,[tensor()],top,context).status).toBe('unavailable');
    const dest=tensor(9);dest.tensorId=TensorSpec.shape.tensorId.parse('other');c.destination.tensorId=dest.tensorId;expect(evaluateCommunication(c,scope(),[tensor(),dest],top,context).status).toBe('unavailable');
  });
  it('preserves explicitly declared fixed/custom timing and does not infer speed from payload precision',()=>{
    const c=comm();c.payloadDtype={category:'int',bits:4,format:'i4'};c.timing={kind:'fixed',seconds:0.02,description:'Explicit fixed network timing'};expect(value(communication(evaluateCommunication(c,scope(),[tensor()],topology(4),context)).cost.seconds)).toBe(0.02);
    c.timing={kind:'custom_formula',seconds:{kind:'literal',quantity:{value:0.003,unit:'second'}},description:'Explicit formula'};expect(value(communication(evaluateCommunication(c,scope(),[tensor()],topology(4),context)).cost.seconds)).toBe(0.003);
  });
  it('keeps zero work valid but refuses a nonzero transfer time that underflows to zero',()=>{
    const c=comm();c.sendBytesPerMember={kind:'literal',quantity:{value:0,unit:'byte'}};c.algorithm.startupRounds=0;expect(value(communication(evaluateCommunication(c,scope(),[tensor()],topology(4),context)).cost.seconds)).toBe(0);
    c.sendBytesPerMember={kind:'literal',quantity:{value:1e-300,unit:'byte'}};c.timing={kind:'bandwidth_latency',bytePerSecond:1e308,latencySeconds:0};const r=communication(evaluateCommunication(c,scope(),[tensor()],topology(4),context));expect(r.cost.seconds.status).toBe('unavailable');expect(r.diagnostics.map(d=>d.code)).toContain('numeric_overflow');
    c.algorithm.trafficFactor=1e-300;const lost=communication(evaluateCommunication(c,scope(),[tensor()],topology(4),context));expect(lost.cost.communications[0]?.algorithmTrafficBytesPerMember.status).toBe('unavailable');expect(lost.cost.seconds.status).toBe('unavailable');
  });
  it('exports strict result schemas for tensor placement, quantized allocation and communication',()=>{
    const ajv=new Ajv2020({strict:false,validateFormats:false}),t=tensor(),s=StorageSpec.parse({storageId:'S',name:'storage',category:'activation',sharingDomain:'request',allocation:{kind:'tensor',shape:t.shape,dtype:t.dtype}});
    for(const [schema,r] of [[TensorPartitionResult,split(partitionTensor(t,sharded(),topology(),context))],[StoragePartitionResult,allocation(allocateDistributedStorage(s.storageId,[s],sharded(),topology(),context))],[CommunicationEvaluation,communication(evaluateCommunication(comm(),scope(),[t],topology(4),context))]] as const){const validate=ajv.compile(z.toJSONSchema(schema));expect(validate(r)).toBe(true);expect(validate({...r,extra:1})).toBe(false);}
  });
});
