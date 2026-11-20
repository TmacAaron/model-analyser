import { MemoryPeak,StorageSpec,type ResolvedGraph,type Scenario,type AssetDocument,type ParallelResolution,type Diagnostic } from '@model-analyser/contracts';
import type { AllocationLifetime } from './liveness.js';
import { collectMemoryUses } from './memory-uses.js';
import { fusionSymbols } from './fusion.js';
import { numericValue } from './storage.js';
import { FormulaError } from './formula.js';
import { MetricFactory } from './metrics.js';
import { collectRefs } from '../../contracts/src/validation.js';

type Input=Pick<ParallelResolution,'execution'|'localCosts'|'fusions'|'tensorLayouts'|'communications'>&{singleDeviceBaseline?:boolean};
const persistent=(category:string)=>['weight','state','graph','runtime','reserve'].includes(category);
/** Replace only private physical allocations. Budgets remain reserved throughout each actual call span. */
export function applyModulePeakOverrides(raw:MemoryPeak,resolved:ResolvedGraph,scenario:Scenario,assets:AssetDocument[],input:Input,
  allocations:AllocationLifetime[],axis:'order'|'second',diagnostics:Diagnostic[]):MemoryPeak{
  const contexts=modulePeakContexts(resolved,scenario,assets),rules=contexts.map(c=>c.rule);if(!rules.length)return raw;
  const graph=resolved.graph,execution=input.execution.status==='available'?input.execution.result:undefined;
  if(raw.deviceScope.kind!=='per_device')throw new FormulaError('invalid_scope','模块峰值必须逐物理设备计算');const deviceId=raw.deviceScope.deviceId;
  const canonical=(initial:string)=>{let id=initial;const seen=new Set<string>();while(true){const s=graph.storages.find(s=>s.storageId===id);if(!s)throw new FormulaError('missing_reference','模块覆盖缺少规范存储');if(s.allocation.kind!=='alias')return s.storageId;if(seen.has(id))throw new FormulaError('dependency_cycle','模块覆盖 alias 环');seen.add(id);id=s.allocation.targetStorageId;}};
  const tensorStorage=(id:string)=>{const t=graph.tensors.find(t=>t.tensorId===id);if(!t)throw new FormulaError('missing_reference','模块覆盖缺少边界张量');return canonical(t.storageId);};
  const allUses=scenario.deviceTopology.devices.flatMap(d=>collectMemoryUses(resolved,input,d.deviceId));
  const uses=collectMemoryUses(resolved,input,deviceId),applications:NonNullable<MemoryPeak['moduleOverrides']>['applications']=[];
  // Validate every active rule even on devices without local participation.
  for(const {rule,container,binding,interfaceGraph,evaluatedBytes} of contexts){
    const members=new Set(container.leafNodeIds),internalFusions=input.fusions.filter(f=>f.application.memberNodeIds.every(id=>members.has(id))),extraNodeIds=internalFusions.map(f=>f.application.extraNodeId),owned=new Set([...members,...extraNodeIds]);
    const boundary=new Set([...graph.inputs,...graph.outputs].map(p=>tensorStorage(p.tensorId)));
    for(const p of [...interfaceGraph.inputs,...interfaceGraph.outputs]){const t=binding.tensors.find(t=>t.localTensorId===p.tensorId);if(!t)throw new FormulaError('missing_reference','模块边界绑定缺失');boundary.add(tensorStorage(t.tensorId));}
    const localUses=uses.filter(u=>{if(!owned.has(u.nodeId)||!execution?.steps.some(s=>s.nodeId===u.executionNodeId&&s.deviceIds.includes(deviceId)))return false;const p=input.localCosts.nodes.find(n=>n.nodeId===u.nodeId)?.placement;if(extraNodeIds.includes(u.nodeId))return internalFusions.some(f=>f.application.extraNodeId===u.nodeId&&f.perDevice.some(d=>d.deviceId===deviceId));return p?.kind==='placed'?p.perDevice.some(d=>d.deviceId===deviceId):graph.nodes.some(n=>n.nodeId===u.nodeId&&n.body.kind==='collective');}),executionNodeIds=[...new Set(localUses.map(u=>u.executionNodeId))];
    if(!executionNodeIds.length)continue;
    const relevant=allocations.filter(a=>uses.some(u=>owned.has(u.nodeId)&&[...u.reads,...u.writes,...u.temporary].includes(a.storageId))),privateStorageIds=relevant.filter(a=>!persistent(a.category)&&!boundary.has(a.storageId)&&allUses.filter(u=>[...u.reads,...u.writes,...u.temporary].includes(a.storageId)).every(u=>owned.has(u.nodeId))).map(a=>a.storageId);
    const start=axis==='order'?Math.min(...localUses.map(u=>uses.indexOf(u))):Math.min(...executionNodeIds.map(id=>execution?.steps.find(s=>s.nodeId===id)?.startSeconds??NaN));
    const end=axis==='order'?Math.max(...localUses.map(u=>uses.indexOf(u))):Math.max(...executionNodeIds.map(id=>execution?.steps.find(s=>s.nodeId===id)?.endSeconds??NaN));
    if(!Number.isFinite(start)||!Number.isFinite(end))continue; // Raw temporal result remains unavailable below.
    applications.push({rule,evaluatedBytes,memberNodeIds:container.leafNodeIds,extraNodeIds,executionNodeIds,privateStorageIds,retainedStorageIds:relevant.filter(a=>!privateStorageIds.includes(a.storageId)).map(a=>a.storageId),boundaryStorageIds:[...boundary].filter(id=>allocations.some(a=>a.storageId===id)),start,end});
  }
  if(raw.peakBytes.status!=='available'||!execution||execution.blockedNodeIds.length||execution.unplacedCommunicationIndices.length||!applications.length)return raw;
  const removed=new Set(applications.flatMap(a=>a.privateStorageIds)),retained=allocations.filter(a=>!removed.has(a.storageId)),coordinates=[...new Set([0,...retained.flatMap(a=>a.intervals.flatMap(i=>axis==='order'?[i.start,i.end+1]:[i.start,i.end])),...applications.flatMap(a=>axis==='order'?[a.start,a.end+1]:[a.start,a.end])])].sort((a,b)=>a-b);
  const metrics=new MetricFactory(diagnostics,{assetRefs:resolved.assetRefs,formulaRefs:rules.flatMap(r=>collectRefs(r.peakBytes)),parameterSources:resolved.parameters.map(p=>({parameterKey:p.nodeId+':'+p.parameterKey,source:p.source.kind})),assumptions:['Private module budgets are reserved for the complete actual call span. Persistent, boundary and cross-module canonical allocations remain unchanged. The opaque private budget is classified as reserve; it is not a measured category breakdown.',...rules.map(r=>r.description)]},scenario.scenarioId,'module-peak-'+deviceId);
  let peak=-1,point=0,categories=new Map<string,number>();
  for(const at of coordinates){if(axis==='order'&&at>=Math.max(1,uses.length))continue;const current=new Map<string,number>();for(const a of retained)if(a.intervals.some(i=>at>=i.start&&(axis==='order'?at<=i.end:at<i.end||i.start===i.end&&at===i.start||persistent(a.category)&&at===i.end))){if(a.bytes.status!=='available')return raw;current.set(a.category,(current.get(a.category)??0)+a.bytes.quantity.value);}for(const a of applications)if(at>=a.start&&(axis==='order'?at<=a.end:at<a.end||a.start===a.end&&at===a.start))current.set('reserve',(current.get('reserve')??0)+a.evaluatedBytes);const total=[...current.values()].reduce((n,v)=>n+v,0);if(!Number.isSafeInteger(total))throw new FormulaError('module_peak_overflow','模块预算叠加超出安全整数');if(total>peak){peak=total;point=at;categories=current;}}
  if(peak>raw.capacityBytes)metrics.unavailable('module_peak_capacity_exceeded','含模块私有预算的峰值超过物理设备容量');
  return MemoryPeak.parse({...raw,categoryBreakdown:StorageSpec.shape.category.options.map(category=>({category,bytes:metrics.available(categories.get(category)??0,'byte','estimated')})),peakBytes:metrics.available(Math.max(0,peak),'byte','estimated'),peakPoint:axis==='order'?{kind:'order',index:point}:{kind:'time',seconds:point},capacityStatus:{kind:'point_only',description:'Conservative private-module budget reservation over actual call spans; capacity search reevaluates every candidate.'},moduleOverrides:{policy:'private_budget_reserved_for_call_span',axis,theoretical:raw,applications,allocations,uses:uses.map(({startSeconds,...u})=>{void startSeconds;return u;}),initialStorageIds:[...new Set(graph.inputs.map(p=>tensorStorage(p.tensorId)))],outputStorageIds:[...new Set(graph.outputs.map(p=>tensorStorage(p.tensorId)))],carriedStorageIds:[...new Set([...graph.edges.map(e=>tensorStorage(e.tensorId)),...input.communications.flatMap(c=>[tensorStorage(c.evaluation.source.tensorId),tensorStorage(c.evaluation.destination.tensorId)])])],peakCoordinate:point}});
}

/** Validate scopes and expressions even when physical layout/time is unavailable or a total rule supersedes them. */
export function modulePeakContexts(resolved:ResolvedGraph,scenario:Scenario,assets:AssetDocument[]){
  const rules=(scenario.modulePeakOverrides??[]).filter(r=>r.phases.includes(resolved.phase)),graph=resolved.graph,claimed=new Set<string>();
  return rules.map(rule=>{
    const container=resolved.containers.find(c=>c.nodeId===rule.nodeId),binding=resolved.objectBindings.find(b=>b.nodeId===rule.nodeId),asset=container?assets.find(a=>a.assetId===container.asset.assetId&&a.revision===container.asset.revision):undefined;
    if(!container||!binding||asset?.definition.kind!=='module'&&asset?.definition.kind!=='model'||graph.nodes.some(n=>n.nodeId===rule.nodeId)||!container.leafNodeIds.length)throw new FormulaError('invalid_module_peak_scope','模块覆盖必须指向当前阶段的实际模块调用（重复容器请选具体实例）');
    const members=new Set(container.leafNodeIds);for(const id of members){if(claimed.has(id))throw new FormulaError('conflicting_module_peak_override','模块峰值覆盖的调用范围不能相同或嵌套重叠');claimed.add(id);}
    for(const f of resolved.fusionApplications)if(f.memberNodeIds.some(id=>members.has(id))&&!f.memberNodeIds.every(id=>members.has(id)))throw new FormulaError('module_peak_fusion_boundary','融合横跨峰值覆盖模块边界，需移除该覆盖或调整融合范围');
    const evaluatedBytes=numericValue(rule.peakBytes,'byte',{symbols:fusionSymbols(resolved,scenario,rule.nodeId),assets},true);
    return {rule,container,binding,interfaceGraph:asset.definition.graph,evaluatedBytes};
  });
}
