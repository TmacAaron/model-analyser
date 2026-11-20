import { type ResolvedGraph,type AnalysisResult,type DeviceId,type NodeId,type StorageId,type MemoryEvidence,type AssetDocument,type MetricValue } from '@model-analyser/contracts';
import { captureMemoryEvidence,type EvidenceAllocation } from './memory-evidence.js';
import { allocateStorage } from './storage.js';
import { MetricFactory } from './metrics.js';
import { FormulaError } from './formula.js';
import { lifetimePeak,type LifetimeAllocation,type LifetimeStep,type AllocationLifetime } from './liveness.js';
export function serialMemory(resolved:ResolvedGraph,order:NodeId[],schedule:AnalysisResult['schedule'],deviceId:DeviceId,capacityBytes:number,metrics:MetricFactory,onEvidence?:(evidence:MemoryEvidence)=>void,assets:AssetDocument[]=[]){
  const shared=(m:MetricValue):MetricValue=>m.status==='available'?{...m,provenance:metrics.provenance}:m;
  const details=new Map<StorageId,NonNullable<EvidenceAllocation['perCopyAllocation']>>();
  const graph=resolved.graph,canonicalIds=new Map<string,StorageId>(),allocations=new Map<StorageId,LifetimeAllocation>();
  for(const s of graph.storages){const a=allocateStorage(s.storageId,graph.storages,{symbols:{},assets:[],provenance:metrics.provenance});metrics.diagnostics.push(...a.diagnostics);canonicalIds.set(s.storageId,a.canonicalStorageId);const source=graph.storages.find(s=>s.storageId===a.canonicalStorageId);if(!source&&a.totalBytes.status==='available')throw new FormulaError('missing_reference','规范存储不存在');if(onEvidence)details.set(a.canonicalStorageId,{copies:1,payloadBytes:shared(a.payloadBytes),totalBytes:shared(a.totalBytes),auxiliaryBytes:a.auxiliaryBytes.map(v=>({name:v.name,bytes:shared(v.bytes)}))});allocations.set(a.canonicalStorageId,{storageId:a.canonicalStorageId,category:source?.category??s.category,bytes:a.totalBytes});}
  const canonical=(id:StorageId)=>{const mapped=canonicalIds.get(id);if(!mapped)throw new FormulaError('missing_reference','生命周期引用缺少存储 '+id);return mapped;};
  const tensorStorage=(id:string)=>{const t=graph.tensors.find(t=>t.tensorId===id);if(!t)throw new FormulaError('missing_reference','生命周期张量不存在');return canonical(t.storageId);};
  const steps:LifetimeStep[]=order.map(nodeId=>{const n=graph.nodes.find(n=>n.nodeId===nodeId);if(n?.body.kind!=='opaque')throw new FormulaError('unsupported_graph_node','生命周期只接受已解析叶节点');const time=schedule.find(s=>s.nodeId===nodeId);return {nodeId,reads:[...n.body.cost.memoryAccess.filter(a=>a.mode==='read').map(a=>canonical(a.storageId)),...n.body.inputs.map(p=>tensorStorage(p.tensorId))],writes:[...n.body.cost.memoryAccess.filter(a=>a.mode==='write').map(a=>canonical(a.storageId)),...n.body.outputs.map(p=>tensorStorage(p.tensorId))],temporary:n.body.cost.temporaryStorageIds.map(canonical),...(time?{startSeconds:time.startSeconds}:{})};});
  const linked=graph.edges.filter(e=>e.from.kind==='node'&&e.to.kind==='node').map(e=>tensorStorage(e.tensorId));
  const inputs=graph.inputs.map(p=>tensorStorage(p.tensorId)),outputs=graph.outputs.map(p=>tensorStorage(p.tensorId));let lifetimes:AllocationLifetime[]|undefined;
  const peak=lifetimePeak([...allocations.values()],steps,inputs,outputs,linked,deviceId,capacityBytes,metrics,rows=>{lifetimes=rows;});
  onEvidence?.(captureMemoryEvidence(resolved,deviceId,'order',(lifetimes??[...allocations.values()]).map(a=>{const perCopyAllocation=details.get(a.storageId);return {...a,...(perCopyAllocation?{perCopyAllocation}:{})};}),steps.map(s=>({...s,executionNodeId:s.nodeId})),inputs,outputs,linked,metrics.provenance,assets));return peak;
}
