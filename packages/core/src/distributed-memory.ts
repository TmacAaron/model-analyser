import { collectMemoryUses } from './memory-uses.js';
import { captureMemoryEvidence } from './memory-evidence.js';
import { applyModulePeakOverrides } from './module-peak-overrides.js';
import { MemoryPeak,type ResolvedGraph,type Scenario,type AssetDocument,type ParallelResolution,type Diagnostic,type StorageId,type MemoryEvidence } from '@model-analyser/contracts';
import { lifetimePeak,type AllocationLifetime,type LifetimeAllocation } from './liveness.js';
import { MetricFactory } from './metrics.js';
import { FormulaError } from './formula.js';
type Input=Pick<ParallelResolution,'storageAllocations'|'tensorLayouts'|'localCosts'|'communications'|'execution'|'unassignedStorageIds'|'fusions'>&{singleDeviceBaseline?:boolean};
export function distributedSerialMemory(resolved:ResolvedGraph,scenario:Scenario,assets:AssetDocument[],input:Input,diagnostics:Diagnostic[],onEvidence?:(evidence:MemoryEvidence)=>void):MemoryPeak[]{
  const allocationDetails=new Map(input.storageAllocations.map(s=>[s.storageId,s.allocation]));
  const graph=resolved.graph,storages=new Map(graph.storages.map(s=>[String(s.storageId),s])),tensors=new Map(graph.tensors.map(t=>[String(t.tensorId),t])),nodes=new Map(graph.nodes.map(n=>[n.nodeId,n]));
  const canonical=(id:StorageId):StorageId=>{const seen=new Set<StorageId>();while(true){const s=storages.get(id);if(!s)throw new FormulaError('missing_reference','显存引用缺少存储 '+id);if(s.allocation.kind!=='alias')return s.storageId;if(seen.has(id))throw new FormulaError('dependency_cycle','显存 alias 环');seen.add(id);id=s.allocation.targetStorageId;}};
  const tensorStorage=(id:string)=>{const t=tensors.get(id);if(!t)throw new FormulaError('missing_reference','显存引用缺少张量 '+id);return canonical(t.storageId);},execution=input.execution.status==='available'?input.execution.result:undefined;
  return scenario.deviceTopology.devices.map(device=>{
    const provenance={assetRefs:resolved.assetRefs,formulaRefs:[],parameterSources:[],assumptions:['Per-device canonical liveness under serial-barrier order. Persistent categories stay resident; scratch is released after use unless it carries data. Unknown time uses order indices. No implicit staging allocation.',...scenario.parallelPlan.assumptions]},metrics=new MetricFactory(diagnostics,provenance,scenario.scenarioId,'distributed-memory-'+device.deviceId),hardware=assets.find(a=>a.assetId===device.hardware.assetId&&a.revision===device.hardware.revision),capacityBytes=hardware?.definition.kind==='hardware'?hardware.definition.hardware.capacityBytes:0;
    const missing=(code:string,message:string)=>{const m=metrics.unavailable(code,message);return MemoryPeak.parse({deviceScope:{kind:'per_device',deviceId:device.deviceId},categoryBreakdown:[],peakBytes:m,peakPoint:{kind:'order',index:0},capacityBytes,capacityStatus:{kind:'unavailable',diagnosticIds:m.diagnosticIds}});};
    try{
      if(hardware?.definition.kind!=='hardware')return missing('missing_reference','显存容量缺少硬件快照');if(!execution)return missing('invalid_lifetime_order','执行顺序不可用，不能计算多设备生命周期峰值');
      if(execution.unplacedCommunicationIndices.length||execution.blockedNodeIds.length)return missing('incomplete_lifetime_plan','存在未定位通信或未解决的数据布局，无法证明完整生命周期峰值');
      if(input.unassignedStorageIds.length)return missing('unassigned_physical_storage','还有未配置物理分配，不能当作零显存：'+input.unassignedStorageIds.join(', '));
      if(input.localCosts.nodes.some(n=>n.placement.kind==='unplaced'))return missing('unknown_lifetime_participation','逻辑节点参与设备未确定，不能推断生命周期');
      
      const allocations:LifetimeAllocation[]=input.storageAllocations.flatMap(s=>{const local=s.allocation.perDevice.find(d=>d.deviceId===device.deviceId);return local?[{storageId:s.storageId,category:s.category,bytes:local.totalBytes}]:[];});
      const steps=collectMemoryUses(resolved,input,device.deviceId);
      const linked=[...graph.edges.filter(e=>e.from.kind==='node'&&e.to.kind==='node').map(e=>tensorStorage(e.tensorId)),...input.communications.flatMap(c=>[tensorStorage(c.evaluation.source.tensorId),tensorStorage(c.evaluation.destination.tensorId)])];
      let lifetimes:AllocationLifetime[]|undefined;
      const raw=lifetimePeak(allocations,steps,graph.inputs.map(p=>tensorStorage(p.tensorId)),graph.outputs.map(p=>tensorStorage(p.tensorId)),linked,device.deviceId,capacityBytes,metrics,rows=>{lifetimes=rows;});
      onEvidence?.(captureMemoryEvidence(resolved,device.deviceId,'order',(lifetimes??allocations).map(a=>{const local=allocationDetails.get(a.storageId)?.perDevice.find(d=>d.deviceId===device.deviceId);return {...a,...(local?{perCopyAllocation:{copies:local.copies,payloadBytes:local.allocation.payloadBytes,totalBytes:local.allocation.totalBytes,auxiliaryBytes:local.allocation.auxiliaryBytes}}:{})};}),steps,graph.inputs.map(p=>tensorStorage(p.tensorId)),graph.outputs.map(p=>tensorStorage(p.tensorId)),linked,undefined,assets));
      return applyModulePeakOverrides(raw,resolved,scenario,assets,input,lifetimes??[],'order',diagnostics);
    }catch(e){if(scenario.modulePeakOverrides?.some(r=>r.phases.includes(resolved.phase)))throw e;return missing(e instanceof FormulaError?e.code:'invalid_lifetime_plan',e instanceof Error?e.message:'设备生命周期不可用');}
  });
}



