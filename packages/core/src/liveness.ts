import { MemoryPeak,StorageSpec,type StorageId,type NodeId,type DeviceId,type MetricValue } from '@model-analyser/contracts';
import { MetricFactory } from './metrics.js';
import { FormulaError } from './formula.js';
export type LifetimeAllocation={storageId:StorageId;category:StorageSpec['category'];bytes:MetricValue};
export type LifetimeStep={nodeId:NodeId;reads:StorageId[];writes:StorageId[];temporary:StorageId[];startSeconds?:number};
export type AllocationLifetime=LifetimeAllocation&{intervals:{start:number;end:number}[]};
/** Sweep canonical physical allocations; math costs do not determine lifetimes. */
export function lifetimePeak(allocations:LifetimeAllocation[],steps:LifetimeStep[],inputs:StorageId[],outputs:StorageId[],linked:StorageId[],deviceId:DeviceId,capacityBytes:number,metrics:MetricFactory,onLifetimes?:(rows:AllocationLifetime[])=>void):MemoryPeak{
  for(const a of allocations)if(a.bytes.status==='unavailable')return MemoryPeak.parse({deviceScope:{kind:'per_device',deviceId},categoryBreakdown:[],peakBytes:a.bytes,peakPoint:{kind:'order',index:0},capacityBytes,capacityStatus:{kind:'unavailable',diagnosticIds:a.bytes.diagnosticIds}});
  const byId=new Map(allocations.map(a=>[a.storageId,a])),usage=new Map<StorageId,Set<number>>(),birth=new Map<StorageId,number>(),death=new Map<StorageId,number>();
  if(byId.size!==allocations.length)throw new FormulaError('duplicate_id','生命周期物理分配 ID 重复');
  function use(id:StorageId,i:number){if(!byId.has(id))throw new FormulaError('missing_reference','生命周期访问未配置物理存储 '+id);usage.set(id,new Set([...(usage.get(id)??[]),i]));}
  for(const [i,s] of steps.entries()){for(const id of s.reads){use(id,i);death.set(id,Math.max(death.get(id)??i,i));}for(const id of s.writes){use(id,i);birth.set(id,Math.min(birth.get(id)??i,i));}for(const id of s.temporary)use(id,i);}
  for(const id of inputs)if(byId.has(id)){birth.set(id,0);use(id,0);}for(const id of outputs)if(byId.has(id)){const end=Math.max(0,steps.length-1);death.set(id,end);use(id,end);}
  const permanent=new Set<StorageSpec['category']>(['weight','state','graph','runtime','reserve']),carried=new Set([...linked,...inputs,...outputs]),starts=new Map<number,StorageId[]>(),ends=new Map<number,StorageId[]>();
  const intervals=new Map<StorageId,{start:number;end:number}[]>();
  function add(start:number,end:number,id:StorageId){starts.set(start,[...(starts.get(start)??[]),id]);ends.set(end+1,[...(ends.get(end+1)??[]),id]);intervals.set(id,[...(intervals.get(id)??[]),{start,end}]);}
  for(const a of allocations){const uses=[...(usage.get(a.storageId)??[])].sort((a,b)=>a-b),first=uses[0],last=uses.at(-1),scratch=a.category==='workspace'||a.category==='communication';if(permanent.has(a.category)||(scratch&&!uses.length))add(0,Math.max(0,steps.length-1),a.storageId);else if(first!==undefined&&last!==undefined){if(scratch&&!carried.has(a.storageId)){for(const i of uses)add(i,i,a.storageId);}else add(Math.min(birth.get(a.storageId)??first,first),Math.max(death.get(a.storageId)??last,last),a.storageId);}}
  onLifetimes?.(allocations.map(a=>({...a,intervals:intervals.get(a.storageId)??[]})));
  let peak=-1,peakIndex=0;const active=new Set<StorageId>(),current=new Map<StorageSpec['category'],number>(),peakCategories=new Map<StorageSpec['category'],number>();
  for(let i=0;i<Math.max(1,steps.length);i++){
    for(const id of ends.get(i)??[]){const a=byId.get(id);if(a?.bytes.status==='available'&&active.delete(id))current.set(a.category,(current.get(a.category)??0)-a.bytes.quantity.value);}
    for(const id of starts.get(i)??[]){const a=byId.get(id);if(a?.bytes.status==='available'&&!active.has(id)){if(a.bytes.quantity.unit!=='byte'||!Number.isSafeInteger(a.bytes.quantity.value))throw new FormulaError('invalid_unit','生命周期分配必须是精确 byte');active.add(id);current.set(a.category,(current.get(a.category)??0)+a.bytes.quantity.value);}}
    const total=[...current.values()].reduce((n,b)=>n+b,0);if(!Number.isSafeInteger(total)){const step=steps[i],missing=metrics.unavailable('numeric_overflow','显存精确汇总超过安全整数');return MemoryPeak.parse({deviceScope:{kind:'per_device',deviceId},categoryBreakdown:[],peakBytes:missing,peakPoint:{kind:'order',index:i,...(step?{nodeId:step.nodeId}:{})},capacityBytes,capacityStatus:{kind:'unavailable',diagnosticIds:missing.diagnosticIds}});}if(total>peak){peak=total;peakIndex=i;peakCategories.clear();for(const [category,bytes] of current)peakCategories.set(category,bytes);}
  }
  const step=steps[peakIndex],peakPoint=step?.startSeconds!==undefined?{kind:'time' as const,seconds:step.startSeconds,nodeId:step.nodeId}:{kind:'order' as const,index:peakIndex,...(step?{nodeId:step.nodeId}:{})};
  if(peak>capacityBytes)metrics.unavailable('capacity_exceeded',`当前点显存 ${peak} byte 超过设备容量 ${capacityBytes} byte`);
  return MemoryPeak.parse({deviceScope:{kind:'per_device',deviceId},categoryBreakdown:StorageSpec.shape.category.options.map(category=>({category,bytes:metrics.available(peakCategories.get(category)??0,'byte')})),peakBytes:metrics.available(Math.max(0,peak),'byte'),peakPoint,capacityBytes,capacityStatus:{kind:'point_only',description:'Canonical allocation lifetimes under the selected serial order; no capacity search has run.'}});
}
