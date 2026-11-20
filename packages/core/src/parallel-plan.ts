import { applyTotalPeakOverrides } from './memory-peak-overrides.js';
import { modulePeakContexts } from './module-peak-overrides.js';
import { ParallelResolutionAttempt,StoragePartitionResult,NodeId,TensorId,StorageId,metricFor,type Scenario,type AssetDocument,type ParallelResolution,type TensorDistribution,type TensorPartitionResult,type Diagnostic,type Quantity,type MetricValue,type DecodeStepContext,type MemoryEvidence } from '@model-analyser/contracts';
import { calculationInput,computeInputHash } from './input-hash.js';
import { instantiateModel } from './instantiate.js';
import { partitionTensor } from './partition.js';
import { allocateDistributedStorage } from './distributed-storage.js';
import { evaluateCommunication } from './communication.js';
import { ENGINE_VERSION } from './version.js';
import { MetricFactory } from './metrics.js';
import { FormulaError } from './formula.js';
import { canonical } from '../../contracts/src/validation.js';
import { validateScenario } from '../../contracts/src/scenario-validation.js';
import { validateParallelResolution } from '../../contracts/src/parallel-validation.js';
import { evaluateDistributedCosts } from './distributed-cost.js';
import { tensorLayoutSignature as tensorSignature,canReadTensorLocally } from './layout-compatibility.js';
import { buildSerialExecution } from './serial-execution.js';
import { distributedSerialMemory } from './distributed-memory.js';
import { evaluateFusions } from './fusion-cost.js';
import { fusionRuntime,fusionMemoryOrder } from './fusion-runtime.js';
import { buildStreamsExecution } from './streams.js';
import { temporalMemory } from './temporal-memory.js';
import {communicationSymbols,type BoundCollectiveObservation,type CommunicationPlanObserver,type CommunicationTimingArithmetic,type CommunicationTimingOverride} from './communication-observation.js';
import type {LocalPlanObserver} from './local-cost-observation.js';
import type {FusionPlanObserver} from './fusion-observation.js';
import type {LayoutPlanObserver,LayoutRuleEvidence,StorageLayoutOrigin} from './layout-observation.js';
import type {StorageOverrideObservation} from './quantization-observation.js';

const MAX_PARALLEL_USES=20000;
type Assignment=Scenario['parallelPlan']['assignments'][number];
type Candidate<T>={nodeId:NodeId;id:string;index:number;priority:number;value:T;signature:string;originalId:string;source?:Omit<LayoutRuleEvidence,'status'>};
const inside=(id:string,root:string)=>root==='$model'||id===root||id.startsWith(root+'/')||id.startsWith(root+'[');
const storageSignature=(p:StoragePartitionResult)=>canonical([...p.perDevice].sort((a,b)=>a.deviceId<b.deviceId?-1:1).map(d=>({deviceId:d.deviceId,copies:d.copies,payload:d.allocation.payloadBytes,auxiliaries:d.allocation.auxiliaryBytes,total:d.totalBytes})).map(d=>({...d,payload:d.payload.status==='available'?d.payload.quantity:d.payload,auxiliaries:d.auxiliaries.map(a=>({name:a.name,bytes:a.bytes.status==='available'?a.bytes.quantity:a.bytes})),total:d.total.status==='available'?d.total.quantity:d.total})));

/** Resolve layouts and declared allocation totals; this is not a distributed schedule/peak. */
export async function resolveParallelPlan(input:Scenario,library:AssetDocument[],stepContext?:DecodeStepContext,observer?:CommunicationPlanObserver|LocalPlanObserver|FusionPlanObserver|LayoutPlanObserver):Promise<ParallelResolutionAttempt>{
  const diagnostics:Diagnostic[]=[];
  let location:Diagnostic['location']={kind:'file',name:'parallel-plan'};
  try{
    const pack=calculationInput(input,library),assets=pack.assets;let scenario=pack.scenario;
    location={kind:'scenario',scenarioId:scenario.scenarioId};
    const invalid=validateScenario(scenario,assets).filter(d=>d.severity==='error'&&d.code!=='unresolved_partial');if(invalid.length)return ParallelResolutionAttempt.parse({status:'unavailable',diagnostics:invalid});
    const captures:BoundCollectiveObservation[]=[];
    const local=observer&&'localCost'in observer?observer:undefined,communication=observer&&'index'in observer?observer:undefined;
    const nativeNodeId=communication?.nativeNodeId,fusion=observer&&'fusion'in observer?observer.fusion:undefined;
    const layoutObserver=observer&&'layout'in observer?observer.layout:undefined,layoutTarget=layoutObserver?.target;
    const fusionGroup=fusion?.bindings?scenario.fusionGroups.find(group=>'$fusion:'+encodeURIComponent(group.groupId)===fusion.nodeId):undefined;
    const instantiated=local?.declaration?{nodeId:local.localCost.nodeId,declaration:local.declaration,...(local.bindings?{bindings:true}:{})}
      :communication&&(nativeNodeId||communication.bindings)?{
        nodeId:nativeNodeId??'$model',
        ...(nativeNodeId?{collective:(record:BoundCollectiveObservation)=>captures.push(record)}:{}),
        ...(communication.bindings?{bindings:true,bindingTraceReady:communication.bindings}:{}),
      }
      :fusion?.declaration?{nodeId:fusion.nodeId,fusion:{nodeId:fusion.nodeId,record:fusion.declaration,...(fusion.bindings?{bindings:true as const}:{})},
        ...(fusion.bindings?{bindings:true,bindingNodes:[fusionGroup?.origin?.scopeNodeId,fusionGroup?.extraLocalCost?.contextNodeId].filter((id):id is NodeId=>id!==undefined),bindingTraceReady:fusion.bindings}:{})}
      :layoutObserver?{nodeId:layoutObserver.target.kind==='tensor'?layoutObserver.target.nodeId:'$model',
        ...(layoutObserver.declaration||layoutObserver.derived?{layoutObject:{target:layoutObserver.target,
          ...(layoutObserver.declaration?{record:layoutObserver.declaration}:{}),...(layoutObserver.derived?{derived:layoutObserver.derived}:{})}}:{}),
        ...(layoutObserver.quantization?{quantization:layoutObserver.quantization}:{})}:undefined;
    const expanded=instantiateModel(scenario,assets,undefined,stepContext,instantiated);if(expanded.status==='unavailable')return ParallelResolutionAttempt.parse(expanded);
    const resolved=expanded.resolved,graph=resolved.graph;diagnostics.push(...expanded.diagnostics);
    modulePeakContexts(resolved,scenario,assets);
    const nativeCommunications=graph.nodes.flatMap(n=>n.body.kind==='collective'?[{nodeId:n.nodeId,definition:n.body.communication}]:[]),planCommunicationCount=scenario.parallelPlan.communications.length;
    scenario={...scenario,parallelPlan:{...scenario.parallelPlan,communications:[...scenario.parallelPlan.communications,...nativeCommunications.map(n=>n.definition)]}};
    const nativeInvalid=validateScenario(scenario,assets).filter(d=>d.severity==='error'&&d.code!=='unresolved_partial');if(nativeInvalid.length)return ParallelResolutionAttempt.parse({status:'unavailable',diagnostics:nativeInvalid});
    const singleDeviceBaseline=(scenario.modulePeakOverrides?.some(r=>r.phases.includes(resolved.phase))||scenario.executionPlan.kind==='streams'||resolved.fusionApplications.length>0||nativeCommunications.length>0)&&scenario.deviceTopology.devices.length===1&&!scenario.parallelPlan.assignments.length&&planCommunicationCount===0;
    if(singleDeviceBaseline){let groupId='$single-fusion';while(scenario.deviceTopology.groups.some(g=>g.groupId===groupId))groupId+=':';const distribution={kind:'replicated' as const,groupId};scenario={...scenario,deviceTopology:{...scenario.deviceTopology,groups:[...scenario.deviceTopology.groups,{groupId,members:scenario.deviceTopology.devices.map(d=>d.deviceId)}]},parallelPlan:{...scenario.parallelPlan,assignments:[{selector:{kind:'subtree',rootNodeId:NodeId.parse('$model')},phases:[resolved.phase],tensorDistributions:graph.tensors.map(t=>({tensorId:t.tensorId,distribution})),storageDistributions:graph.storages.map(s=>({storageId:s.storageId,distribution}))}],assumptions:[...scenario.parallelPlan.assumptions,'Single-device graph execution uses complete replicated objects and the original global leaf equations; no device-count division.']}};}
    const elided=new Set(resolved.fusionApplications.flatMap(g=>g.eliminatedStorageIds));
    const leaves=new Set(graph.nodes.map(n=>n.nodeId)),scopes=new Set([...leaves,...resolved.containers.map(c=>c.nodeId),...resolved.objectBindings.map(b=>b.nodeId)]);
    const scheduledIds=new Set(scenario.parallelPlan.communications.flatMap(c=>c.placement?.phases.includes(resolved.phase)?[c.placement.nodeId]:[]));
    for(const [index,c] of scenario.parallelPlan.communications.entries())if(c.placement?.phases.includes(resolved.phase)&&scopes.has(c.placement.nodeId)&&!(index>=planCommunicationCount&&graph.nodes.find(n=>n.nodeId===c.placement?.nodeId)?.body.kind==='collective'))throw new FormulaError('duplicate_id','通信节点 ID 与模型展开范围冲突 '+c.placement.nodeId);
    for(const [index,o] of scenario.numericOverrides.entries())if(o.target.kind==='node'&&o.field!=='parameter'){location={kind:'scenario',scenarioId:scenario.scenarioId,fieldPath:'numericOverrides.'+index};if(!leaves.has(o.target.nodeId)&&!scheduledIds.has(o.target.nodeId))throw new FormulaError('missing_reference','成本覆盖必须指向展开叶节点或已命名通信节点 '+o.target.nodeId);if(leaves.has(o.target.nodeId)&&!nativeCommunications.map(c=>c.nodeId).includes(o.target.nodeId)&&(o.field==='communication_bandwidth'||o.field==='communication_latency'))throw new FormulaError('invalid_override','通信带宽/延迟覆盖不能应用于计算叶节点');}
    const ruleTensors=(n:typeof graph.nodes[number])=>n.body.kind==='opaque'&&n.body.localCost?[...('tensorId' in n.body.localCost.participation?[n.body.localCost.participation.tensorId]:[]),...n.body.localCost.bindings.flatMap(b=>'tensorId' in b.source?[b.source.tensorId]:[])]:[];
    const ruleStorages=(n:typeof graph.nodes[number])=>n.body.kind==='opaque'&&n.body.localCost?[...('storageId' in n.body.localCost.participation?[n.body.localCost.participation.storageId]:[]),...n.body.localCost.bindings.flatMap(b=>'storageId' in b.source?[b.source.storageId]:[]),...n.body.localCost.cost.memoryAccess.map(a=>a.storageId),...n.body.localCost.cost.temporaryStorageIds]:[];
    const canonicalStorage=(inputId:string):StorageId=>{let id=inputId;const seen=new Set<string>();while(true){const storage=graph.storages.find(s=>s.storageId===id);if(!storage)throw new FormulaError('missing_reference',`布局缺少存储 ${id}`);if(storage.allocation.kind!=='alias')return storage.storageId;if(seen.has(id))throw new FormulaError('dependency_cycle','布局存储 alias 环');seen.add(id);id=storage.allocation.targetStorageId;}};
    const overriddenStorages=new Set<string>();
    let storageOverride:StorageOverrideObservation|undefined;
    for(const [overrideIndex,o] of scenario.numericOverrides.entries())if(o.target.kind==='storage'&&o.field==='memory_bytes'){
      const id=canonicalStorage(o.target.storageId),s=graph.storages.find(s=>s.storageId===id);
      if(!s)throw new FormulaError('missing_reference','存储覆盖目标不存在');
      if(overriddenStorages.has(id))throw new FormulaError('invalid_override','同一规范存储的字节覆盖冲突');
      overriddenStorages.add(id);const before=s.allocation;
      s.allocation={kind:'bytes',value:{kind:'literal',quantity:o.value}};
      if(layoutTarget?.kind==='storage'&&layoutTarget.storageId===id)storageOverride={storageId:id,overrideIndex,override:o,before,after:s.allocation};
    }
    const symbols:Record<string,Quantity>={};for(const [key,value] of Object.entries(scenario.workload))if(typeof value==='number')symbols[key]={value,unit:'count'};
    const planParameterKeys:string[]|undefined=communication?.bindings&&!nativeNodeId?[]:undefined;
    for(const p of resolved.parameters)if(p.nodeId==='$model'&&(p.value.kind==='integer'||p.value.kind==='number')){
      symbols[p.parameterKey]={value:p.value.value,unit:p.unit};
      planParameterKeys?.push(p.parameterKey);
    }
    const context={symbols,assets},tensorCandidates:Candidate<TensorPartitionResult>[]=[],storageCandidates:Candidate<StoragePartitionResult>[]=[],tensorCache=new Map<string,TensorPartitionResult>(),storageCache=new Map<string,StoragePartitionResult>();
    let uses=0;const spend=()=>{if(++uses>MAX_PARALLEL_USES)throw new FormulaError('parallel_resolution_limit',`布局作用域解析最多 ${MAX_PARALLEL_USES} 项`);};
    function select(a:Assignment){const roots=a.selector.kind==='nodes'?a.selector.nodeIds:[a.selector.rootNodeId];for(const id of roots)if(!scopes.has(id))throw new FormulaError('empty_selector',`布局选择器未匹配当前阶段的节点 ${id}`);
      const frames=resolved.objectBindings.filter(b=>roots.some(root=>inside(b.nodeId,root))),selected=graph.nodes.filter(n=>roots.some(root=>inside(n.nodeId,root))).map(n=>n.nodeId),inherited=new Set<NodeId>();
      for(const id of selected)if(!resolved.objectBindings.some(b=>b.nodeId===id)){const owner=resolved.objectBindings.filter(b=>inside(id,b.nodeId)).sort((a,b)=>b.nodeId.length-a.nodeId.length)[0];if(owner&&!frames.includes(owner)){frames.push(owner);inherited.add(owner.nodeId);}}
      return {roots,frames,selected,inherited};
    }
    function references(nodeId:NodeId,kind:'tensor'|'storage',id:string){const n=graph.nodes.find(n=>n.nodeId===nodeId),own=resolved.objectBindings.find(b=>b.nodeId===nodeId);if(!n)return false;
      if(kind==='tensor')return n.portBindings.some(p=>p.tensorId===id)||own?.tensors.some(t=>t.tensorId===id)===true||ruleTensors(n).includes(TensorId.parse(id));
      return n.portBindings.some(p=>{const t=graph.tensors.find(t=>t.tensorId===p.tensorId);return t&&canonicalStorage(t.storageId)===id;})||(n.body.kind==='opaque'&&(n.body.cost.memoryAccess.some(a=>canonicalStorage(a.storageId)===id)||n.body.cost.temporaryStorageIds.some(s=>canonicalStorage(s)===id)))||(n.body.kind==='collective'&&n.body.communication.temporaryStorageIds?.some(s=>canonicalStorage(s)===id))||ruleStorages(n).some(s=>canonicalStorage(s)===id)||own?.storages.some(s=>canonicalStorage(s.storageId)===id)===true;
    }
    type Target={id:string;owner:NodeId;axes:Map<string,string>};
    function targets(kind:'tensor'|'storage',request:string,selection:ReturnType<typeof select>):Target[]{
      const global=kind==='tensor'?graph.tensors.find(t=>t.tensorId===request):graph.storages.find(s=>s.storageId===request),globalId=global?(kind==='storage'?canonicalStorage(request):request):undefined;
      const local:Target[]=[];
      const visible=(owner:NodeId,id:string)=>!selection.inherited.has(owner)||selection.selected.some(node=>references(node,kind,id));
      for(const frame of selection.frames){if(kind==='tensor'){for(const t of frame.tensors)if((t.localTensorId===request||t.tensorId===request)&&visible(frame.nodeId,t.tensorId))local.push({id:t.tensorId,owner:frame.nodeId,axes:new Map(t.axes.map(a=>[a.localAxisId,a.axisId]))});}
        else for(const s of frame.storages)if((s.localStorageId===request||s.storageId===request)&&visible(frame.nodeId,canonicalStorage(s.storageId)))local.push({id:canonicalStorage(s.storageId),owner:frame.nodeId,axes:new Map()});}
      if(globalId&&(local.some(t=>t.id===globalId)||selection.selected.some(id=>references(id,kind,globalId))))return [{id:globalId,owner:selection.roots[0]??NodeId.parse('$model'),axes:new Map()}];
      const matches=new Map<string,Target>();for(const t of local){const prior=matches.get(t.id);if(prior&&canonical(Object.fromEntries(prior.axes))!==canonical(Object.fromEntries(t.axes)))throw new FormulaError('ambiguous_axis_mapping','同一对象在所选范围有不同局部轴名称，请使用展开后的全局对象 ID 和轴');matches.set(t.id,t);}
      if(!matches.size)throw new FormulaError('missing_reference',`所选范围内没有 ${kind} 对象 ${request}；可使用结构视图中的全局 ID`);return [...matches.values()];
    }
    function mappedLayout(d:TensorDistribution,axes:Map<string,string>):TensorDistribution{if(!axes.size)return d;const axis=(id:string)=>axes.get(id)??id;
      if(d.kind==='sharded')return {...d,axes:d.axes.map(a=>({...a,tensorAxisId:axis(a.tensorAxisId)})),policy:d.policy.kind==='explicit'?{...d.policy,slices:d.policy.slices.map(s=>({...s,axisId:axis(s.axisId)}))}:d.policy};
      if(d.kind==='manual')return {...d,members:d.members.map(m=>({...m,localShape:m.localShape.map(a=>({...a,axisId:axis(a.axisId)}))}))};return d;
    }
    function tensorPartition(id:string,d:TensorDistribution){const key=canonical([id,d]),cached=tensorCache.get(key);if(cached)return cached;const t=graph.tensors.find(t=>t.tensorId===id);if(!t)throw new FormulaError('missing_reference','分布张量不存在');const r=partitionTensor(t,d,scenario.deviceTopology,context);if(r.status==='unavailable')throw new FormulaError(r.diagnostics[0]?.code??'invalid_distribution',r.diagnostics.map(d=>d.message).join('; '));tensorCache.set(key,r.result);return r.result;}
    function rebase(value:unknown,prefix:string):unknown{if(value===null||typeof value!=='object')return value;if(Array.isArray(value))return value.map(v=>rebase(v,prefix));return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,key==='diagnosticId'&&typeof v==='string'?prefix+v:key==='diagnosticIds'&&Array.isArray(v)?v.map(id=>prefix+String(id)):rebase(v,prefix)]));}
    const storageNamespaces=new WeakMap<StoragePartitionResult,string>();
    function storagePartition(id:string,d:TensorDistribution){const key=canonical([id,d]),cached=storageCache.get(key);if(cached)return cached;const r=allocateDistributedStorage(StorageId.parse(id),graph.storages,d,scenario.deviceTopology,context);if(r.status==='unavailable')throw new FormulaError(r.diagnostics[0]?.code??'invalid_distribution',r.diagnostics.map(d=>d.message).join('; '));const namespace='layout-'+storageCache.size+'-',result=StoragePartitionResult.parse(rebase(r.result,namespace));if(layoutTarget?.kind==='storage'&&layoutTarget.storageId===id)storageNamespaces.set(result,namespace);if(elided.has(StorageId.parse(id))){const zero={status:'available' as const,quantity:{value:0,unit:'byte' as const},basis:'theoretical' as const,provenance:{assetRefs:resolved.assetRefs,formulaRefs:[],parameterSources:[],assumptions:['Validated fusion elides this canonical physical allocation. Partition shape remains logical; no allocation or auxiliary storage is materialized.']},diagnosticIds:[]};result.materialization='elided';for(const p of result.perDevice){p.allocation.payloadBytes=zero;p.allocation.auxiliaryBytes=[];p.allocation.totalBytes=zero;p.totalBytes=zero;p.allocation.diagnostics=[];}result.diagnostics=[];}diagnostics.push(...result.diagnostics);storageCache.set(key,result);return result;}
    const storageLayoutSignatures=new Map<string,string>();
    function storageLayoutSignature(p:StoragePartitionResult){const key=canonical([p.canonicalStorageId,p.distribution]),prior=storageLayoutSignatures.get(key);if(prior)return prior;const s=graph.storages.find(s=>s.storageId===p.canonicalStorageId);if(!s||s.allocation.kind==='alias')throw new FormulaError('missing_reference','规范存储缺少分配');const a=s.allocation;
      const split=partitionTensor({tensorId:TensorId.parse('$storage:'+s.storageId),storageId:s.storageId,name:s.name,shape:a.kind==='tensor'?a.shape:[],dtype:a.kind==='tensor'?a.dtype:{category:'uint',bits:8,format:'u8'}},p.distribution,scenario.deviceTopology,context);if(split.status==='unavailable')throw new FormulaError('invalid_distribution','存储逻辑布局无法解析');const signature=tensorSignature(split.result);storageLayoutSignatures.set(key,signature);return signature;
    }
    const backingTensors=layoutTarget?.kind==='storage'?new Set(graph.tensors.filter(t=>canonicalStorage(t.storageId)===layoutTarget.storageId).map(t=>String(t.tensorId))):undefined;
    function candidateSource(kind:'tensor'|'storage',nodeId:NodeId,target:Target,a:Assignment,index:number,entryIndex:number,priority:number,originalId:string,declared:TensorDistribution,effective:TensorDistribution){
      const selected=kind==='tensor'&&(backingTensors?.has(target.id)||layoutTarget?.kind==='tensor'&&layoutTarget.nodeId===nodeId&&layoutTarget.tensorId===target.id)||
        kind==='storage'&&layoutTarget?.kind==='storage'&&layoutTarget.storageId===target.id;
      return selected?{source:{kind,nodeId,objectId:target.id,ownerNodeId:target.owner,index,entryIndex,priority,originalId,
        selector:a.selector,declared,effective,axisMap:Object.fromEntries(target.axes)}}:{};
    }
    for(const [index,a] of scenario.parallelPlan.assignments.entries()){
      if(!a.phases.includes(resolved.phase))continue;
      location={kind:'scenario',scenarioId:scenario.scenarioId,fieldPath:'parallelPlan.assignments.'+index};
      const selected=select(a);
      for(const [entryIndex,entry] of a.tensorDistributions.entries())for(const target of targets('tensor',entry.tensorId,selected)){
        const d=mappedLayout(entry.distribution,target.axes),nodes=selected.selected.filter(id=>references(id,'tensor',target.id));if(!nodes.length)nodes.push(target.owner);
        for(const nodeId of nodes){
          spend();const priority=a.selector.kind==='nodes'&&a.selector.nodeIds.includes(nodeId)&&leaves.has(nodeId)?2:1;
          tensorCandidates.push({nodeId,id:target.id,index,priority,get value(){return tensorPartition(target.id,d);},get signature(){return tensorSignature(this.value);},originalId:entry.tensorId,
            ...candidateSource('tensor',nodeId,target,a,index,entryIndex,priority,entry.tensorId,entry.distribution,d)});
        }
      }
      for(const [entryIndex,entry] of a.storageDistributions.entries())for(const target of targets('storage',entry.storageId,selected)){
        const nodes=selected.selected.filter(id=>references(id,'storage',target.id));if(!nodes.length)nodes.push(target.owner);
        for(const nodeId of nodes){
          spend();const priority=a.selector.kind==='nodes'&&a.selector.nodeIds.includes(nodeId)&&leaves.has(nodeId)?2:1;
          storageCandidates.push({nodeId,id:target.id,index,priority,get value(){return storagePartition(target.id,entry.distribution);},get signature(){return storageLayoutSignature(this.value);},originalId:entry.storageId,
            ...candidateSource('storage',nodeId,target,a,index,entryIndex,priority,entry.storageId,entry.distribution,entry.distribution)});
        }
      }
    }
    const layoutRules:LayoutRuleEvidence[]=[];
    function winners<T>(candidates:Candidate<T>[]){const grouped=new Map<string,Candidate<T>[]>();for(const c of candidates){const key=canonical([c.nodeId,c.id]);grouped.set(key,[...(grouped.get(key)??[]),c]);}
      return [...grouped.values()].map(list=>{
        const priority=Math.max(...list.map(c=>c.priority)),top=list.filter(c=>c.priority===priority),first=top[0];
        if(!first)throw new FormulaError('invalid_distribution','布局候选为空');
        if(top.some(c=>c.signature!==first.signature))throw new FormulaError('ambiguous_distribution',`对象 ${first.id} 在节点 ${first.nodeId} 的同级范围有冲突布局；需显式叶节点覆盖或消除重叠`);
        if(first.source)for(const c of list)if(c.source)layoutRules.push({...c.source,status:c===first?'selected':c.priority===priority?'equivalent':'overridden'});
        return {first,indices:[...new Set(top.map(c=>c.index))].sort((a,b)=>a-b),overridden:[...new Set(list.filter(c=>c.priority<priority).map(c=>c.index))].sort((a,b)=>a-b)};
      });
    }
    const tensorWinners=winners(tensorCandidates),storageWinners=winners(storageCandidates),tensorLayouts:ParallelResolution['tensorLayouts']=tensorWinners.map(w=>({nodeId:w.first.nodeId,tensorId:TensorId.parse(w.first.id),partition:w.first.value,assignmentIndices:w.indices,overriddenIndices:w.overridden}));
    const storageLayouts:ParallelResolution['storageLayouts']=storageWinners.map(w=>({nodeId:w.first.nodeId,storageId:StorageId.parse(w.first.id),distribution:w.first.value.distribution,assignmentIndices:w.indices,overriddenIndices:w.overridden}));
    // An explicit backing allocation may be larger than a tensor view; do not silently
    // change a physical allocation just because another reader has a different layout.
    const storageGroups=new Map<string,{allocation:StoragePartitionResult;signature:string;nodeIds:Set<NodeId>;indices:Set<number>;aliases:Set<StorageId>}>();
    function addStorage(id:string,p:StoragePartitionResult,nodeId:NodeId,indices:number[],originalId:string){const key=canonicalStorage(id),signature=storageSignature(p),prior=storageGroups.get(key);if(prior&&prior.signature!==signature)throw new FormulaError('shared_storage_distribution_conflict',`共享规范存储 ${key} 被要求采用不同物理分配；请显式声明统一 backing 存储或使用独立 storage/通信`);
      const group=prior??{allocation:p,signature,nodeIds:new Set<NodeId>(),indices:new Set<number>(),aliases:new Set<StorageId>()};group.nodeIds.add(nodeId);indices.forEach(i=>group.indices.add(i));group.aliases.add(StorageId.parse(originalId));storageGroups.set(key,group);
    }
    const explicitStorageIds=new Set(storageWinners.map(w=>w.first.id));
    const storageOrigins:StorageLayoutOrigin[]=[];
    const observedStorage=layoutTarget?.kind==='storage'?layoutTarget:undefined;
    for(const w of storageWinners){
      addStorage(w.first.id,w.first.value,w.first.nodeId,w.indices,w.first.originalId);
      if(observedStorage?.storageId===w.first.id)storageOrigins.push({kind:'explicit_storage',nodeId:w.first.nodeId,objectId:w.first.id,distribution:w.first.value.distribution,indices:w.indices});
    }
    for(const w of tensorWinners){const tensor=graph.tensors.find(t=>t.tensorId===w.first.id);if(!tensor)throw new FormulaError('missing_reference','张量分布对象缺失');const id=canonicalStorage(tensor.storageId),explicit=explicitStorageIds.has(id)?storageGroups.get(id):undefined;
      const storage=graph.storages.find(s=>s.storageId===id);if(!storage)throw new FormulaError('missing_reference','张量分布的底层存储缺失');
      const distribution=w.first.value.distribution;
      if((distribution.kind==='sharded'||distribution.kind==='manual')&&(storage.allocation.kind!=='tensor'||canonical(storage.allocation.shape)!==canonical(tensor.shape)))throw new FormulaError('ambiguous_storage_shape','张量视图与底层存储 shape 不同，不能自动从张量分片推断底层分配；请使用独立的明确张量存储');
      const inferred=storagePartition(id,distribution);
      let capacity:StorageLayoutOrigin['capacity'];
      if(explicit){
        for(const local of inferred.perDevice){
          const backing=explicit.allocation.perDevice.find(d=>d.deviceId===local.deviceId);
          if(!backing||backing.totalBytes.status!=='available'||local.totalBytes.status!=='available'||backing.totalBytes.quantity.value<local.totalBytes.quantity.value)throw new FormulaError('insufficient_local_storage',`张量 ${tensor.tensorId} 的设备局部需求超出显式 backing 存储 ${id}`);
          if(observedStorage?.storageId===id&&observedStorage.deviceId===local.deviceId)capacity={requiredBytes:local.totalBytes.quantity.value,backingBytes:backing.totalBytes.quantity.value};
        }
        explicit.nodeIds.add(w.first.nodeId);w.indices.forEach(i=>explicit.indices.add(i));
      }
      else addStorage(id,inferred,w.first.nodeId,w.indices,tensor.storageId);
      if(observedStorage?.storageId===id)storageOrigins.push({kind:explicit?'verified_backing':'inferred_from_tensor',nodeId:w.first.nodeId,objectId:tensor.tensorId,distribution,indices:w.indices,...(capacity?{capacity}:{})});
    }
    const communications:ParallelResolution['communications']=[];
    const allSelection={roots:[NodeId.parse('$model')],frames:resolved.objectBindings,selected:graph.nodes.map(n=>n.nodeId),inherited:new Set<NodeId>()};
    for(const [index,c] of scenario.parallelPlan.communications.entries()){
      if(c.placement&&!c.placement.phases.includes(resolved.phase))continue;
      location={kind:'scenario',scenarioId:scenario.scenarioId,fieldPath:'parallelPlan.communications.'+index};
      const from=targets('tensor',c.source.tensorId,allSelection),to=targets('tensor',c.destination.tensorId,allSelection);if(from.length!==1||to.length!==1||!from[0]||!to[0])throw new FormulaError('ambiguous_communication_target','通信端点需唯一的展开张量 ID');
      const temporaryStorageIds=c.temporaryStorageIds?.map(id=>{const matches=targets('storage',id,allSelection);if(matches.length!==1||!matches[0])throw new FormulaError('ambiguous_communication_buffer','通信临时存储需要唯一展开 ID');return StorageId.parse(matches[0].id);});
      const definition={...c,source:{tensorId:TensorId.parse(from[0].id),distribution:mappedLayout(c.source.distribution,from[0].axes)},destination:{tensorId:TensorId.parse(to[0].id),distribution:mappedLayout(c.destination.distribution,to[0].axes)},...(temporaryStorageIds?{temporaryStorageIds}:{})},group=scenario.deviceTopology.groups.find(g=>g.groupId===c.groupId);if(!group)throw new FormulaError('missing_reference','通信组缺失');
      const overrides=[...scenario.numericOverrides.entries()].filter(([,o])=>o.target.kind==='node'&&o.target.nodeId===c.placement?.nodeId),fields=new Set<string>();for(const [,o] of overrides){if(fields.has(o.field))throw new FormulaError('invalid_override','通信字段重复覆盖');fields.add(o.field);}if(fields.has('fixed_seconds')&&(fields.has('communication_bandwidth')||fields.has('communication_latency')))throw new FormulaError('invalid_override','固定通信时间不能同时覆盖带宽/延迟');
      const capture=communication?.index===index,overrideTrace:CommunicationTimingOverride[]=[];
      for(const [overrideIndex,o] of overrides){
        const before=capture?structuredClone(definition.timing):undefined;
        if(o.field==='fixed_seconds')definition.timing={kind:'fixed',seconds:o.value.value,description:o.description??'Explicit communication timing override'};
        else if(o.field==='communication_bandwidth'||o.field==='communication_latency'){
          if(definition.timing.kind!=='bandwidth_latency')throw new FormulaError('invalid_override','带宽/延迟覆盖需要 bandwidth_latency 策略');
          if(o.field==='communication_bandwidth')definition.timing.bytePerSecond=o.value.value;else definition.timing.latencySeconds=o.value.value;
        }else throw new FormulaError('unsupported_override','通信节点不支持覆盖 '+o.field);
        if(before)overrideTrace.push({index:overrideIndex,override:o,before,after:structuredClone(definition.timing)});
        diagnostics.push({diagnosticId:'communication-override-'+diagnostics.length,severity:'info',code:'communication_override_applied',message:`通信 ${c.placement?.nodeId} 显式覆盖 ${o.field}=${o.value.value} ${o.value.unit}`,location});
      }
      const deviceIds=c.operation==='send_recv'?group.members.filter(id=>id===c.sourceDeviceId||id===c.destinationDeviceId):group.members;
      const nativeSource=nativeCommunications[index-planCommunicationCount],communicationContext=nativeSource?{...context,provenance:{assetRefs:resolved.assetRefs,formulaRefs:resolved.assetRefs.filter(r=>r.kind==='formula'),parameterSources:resolved.parameters.filter(p=>inside(nativeSource.nodeId,p.nodeId)).map(p=>({parameterKey:p.nodeId+':'+p.parameterKey,source:p.source.kind})),assumptions:['Graph-native communication binds its owning frame parameters and actual tensor/storage/axis IDs before evaluation.','Explicit per-member payload and trafficFactor are applied once. Time is the group span, not the sum of device durations.','Network-only cost: local HBM, reduction arithmetic and conversion work require separate declarations. Temporary storage is explicitly allocated and live during communication.',...scenario.parallelPlan.assumptions]}}:context;
      let timing:CommunicationTimingArithmetic|undefined;
      const evaluation=evaluateCommunication(definition,{phase:resolved.phase,target:{kind:'node',nodeId:c.placement?.nodeId??NodeId.parse('$parallel-communication:'+index)},deviceIds,aggregation:'group_total'},graph.tensors,scenario.deviceTopology,communicationContext,capture?record=>{timing=record;}:undefined,capture?communication?.endpoints:undefined);
      if(evaluation.status==='unavailable')throw new FormulaError(evaluation.diagnostics[0]?.code??'invalid_communication',evaluation.diagnostics.map(d=>d.message).join('; '));diagnostics.push(...evaluation.result.diagnostics);const native=nativeCommunications[index-planCommunicationCount];communications.push({index,...(native?{origin:{kind:'graph',nodeId:native.nodeId}}:{}),evaluation:evaluation.result});
      if(capture&&communication){
        const collective=captures.find(record=>record.nodeId===native?.nodeId);
        communication.record(structuredClone({index,...(c.placement?.nodeId?{nodeId:c.placement.nodeId}:{}),...(collective?{collective}:{}),
          symbols:communicationSymbols(context.symbols),...(planParameterKeys?{planParameterKeys}:{}),overrides:overrideTrace,...(timing?{timing}:{})}));
      }
    }
    const warn=(code:string,message:string,nodeId:NodeId,severity:'warning'|'info'='warning')=>diagnostics.push({diagnosticId:'parallel-'+diagnostics.length,severity,code,message,location:{kind:'node',nodeId}});
    for(const t of tensorLayouts)if(t.partition.distribution.kind==='partial'&&!communications.some(c=>c.evaluation.source.tensorId===t.tensorId&&tensorSignature(c.evaluation.source)===tensorSignature(t.partition)&&(c.evaluation.definition.operation==='all_reduce'||c.evaluation.definition.operation==='reduce_scatter')))throw new FormulaError('unresolved_partial',`节点 ${t.nodeId} 的 partial 对象 ${t.tensorId} 未声明匹配归约`);
    for(const [id,entry] of storageGroups)if(entry.allocation.distribution.kind==='partial'&&!communications.some(c=>{const t=graph.tensors.find(t=>t.tensorId===c.evaluation.source.tensorId),d=c.evaluation.source.distribution,stored=entry.allocation.distribution;return t&&canonicalStorage(t.storageId)===id&&d.kind==='partial'&&stored.kind==='partial'&&d.reduceOperation===stored.reduceOperation&&canonical(c.evaluation.source.placements.map(p=>p.deviceId).sort())===canonical(entry.allocation.perDevice.map(p=>p.deviceId).sort())&&(c.evaluation.definition.operation==='all_reduce'||c.evaluation.definition.operation==='reduce_scatter');}))throw new FormulaError('unresolved_partial',`规范存储 ${id} 的 partial 布局未声明匹配归约`);
    for(const edge of graph.edges){if(edge.from.kind!=='node'||edge.to.kind!=='node')continue;const fromId=edge.from.nodeId,toId=edge.to.nodeId,a=tensorLayouts.find(t=>t.nodeId===fromId&&t.tensorId===edge.tensorId),b=tensorLayouts.find(t=>t.nodeId===toId&&t.tensorId===edge.tensorId);if(!a||!b){if(a||b)warn('incomplete_layout_boundary',`边 ${edge.edgeId} 的一端未配置 ${edge.tensorId} 布局，无法确认边界兼容性`,toId);continue;}if(tensorSignature(a.partition)===tensorSignature(b.partition))continue;
      if(canReadTensorLocally(a.partition,b.partition)){warn('local_layout_view',`边 ${edge.edgeId} 的目标有效切片已在同一设备，布局可用本地 view；物化/补齐计算尚未估算`,toId,'info');continue;}
      const communication=communications.find(c=>c.evaluation.source.tensorId===edge.tensorId&&c.evaluation.destination.tensorId===edge.tensorId&&tensorSignature(c.evaluation.source)===tensorSignature(a.partition)&&tensorSignature(c.evaluation.destination)===tensorSignature(b.partition)),placed=communication?.evaluation.definition.placement;
      warn(placed?'communication_placement_declared':communication?'communication_order_pending':'missing_layout_communication',placed?`边 ${edge.edgeId} 已声明通信 ${placed.nodeId}，执行依赖由时间线检查`:communication?`边 ${edge.edgeId} 已有布局变换声明，通信尚未插入执行顺序`:`边 ${edge.edgeId} 的两端布局不同，需明确通信或本地 view 规则`,toId,placed?'info':'warning');
    }
    const provenance={assetRefs:assets.map(a=>({assetId:a.assetId,revision:a.revision,kind:a.definition.kind})),formulaRefs:resolved.assetRefs.filter(r=>r.kind==='formula'),parameterSources:resolved.parameters.map(p=>({parameterKey:p.nodeId+':'+p.parameterKey,source:p.source.kind})),assumptions:['Declared unique physical storage allocations only: the sum is not a lifetime peak, full model footprint or device capacity bound. Unassigned objects remain explicit. Compute work, execution order and communication insertion are not inferred from layout.']};
    const metrics=new MetricFactory(diagnostics,provenance,scenario.scenarioId,'parallel-allocation'),deviceAllocations:ParallelResolution['deviceAllocations']=[];
    function sumBytes(values:MetricValue[]){const known=values.filter(v=>v.status==='available');if(known.length===values.length&&!Number.isSafeInteger(known.reduce((n,v)=>n+v.quantity.value,0)))return metrics.unavailable('numeric_overflow','已声明物理分配总量超出安全整数，不能报告精确 bytes');return metricFor('byte').parse(metrics.sum(values,'byte'));}
    for(const device of scenario.deviceTopology.devices){const assigned=[...storageGroups].flatMap(([id,g])=>{const local=g.allocation.perDevice.find(p=>p.deviceId===device.deviceId),s=graph.storages.find(s=>s.storageId===id);return local&&s?[{category:s.category,bytes:local.totalBytes}]:[];});if(!assigned.length)continue;
      const categories=[...new Set(assigned.map(s=>s.category))],categoryBreakdown=categories.map(category=>({category,bytes:sumBytes(assigned.filter(s=>s.category===category).map(s=>s.bytes))}));deviceAllocations.push({deviceId:device.deviceId,categoryBreakdown,knownBytes:sumBytes(assigned.map(s=>s.bytes))});
    }
    const storageAllocations:ParallelResolution['storageAllocations']=[...storageGroups].map(([storageId,g])=>{const s=graph.storages.find(s=>s.storageId===storageId);if(!s)throw new FormulaError('missing_reference','规范分配存储缺失');return {storageId:StorageId.parse(storageId),category:s.category,aliasIds:graph.storages.filter(s=>canonicalStorage(s.storageId)===storageId).map(s=>s.storageId).sort(),nodeIds:[...g.nodeIds].sort(),assignmentIndices:[...g.indices].sort((a,b)=>a-b),allocation:g.allocation};});
    if(layoutObserver){
      const {target}=layoutObserver,base={topology:scenario.deviceTopology,symbols:communicationSymbols(symbols),rules:layoutRules,syntheticBaseline:!!singleDeviceBaseline,
        ...(layoutObserver.derived?{rootParameterKeys:resolved.parameters.filter(p=>p.nodeId==='$model'&&(p.value.kind==='integer'||p.value.kind==='number')).map(p=>p.parameterKey)}:{})};
      if(target.kind==='tensor'){
        const tensor=graph.tensors.find(t=>t.tensorId===target.tensorId),row=tensorLayouts.find(t=>t.nodeId===target.nodeId&&t.tensorId===target.tensorId);
        if(tensor&&row)layoutObserver.record(structuredClone({...base,kind:'tensor',tensor,row}));
      }else{
        const storage=graph.storages.find(s=>s.storageId===target.storageId),row=storageAllocations.find(s=>s.storageId===target.storageId);
        const elidedBy=resolved.fusionApplications.find(f=>f.eliminatedStorageIds.includes(target.storageId))?.nodeId;
        const quantization=resolved.quantizationApplications.find(q=>q.storageId===target.storageId);
        const namespace=row?storageNamespaces.get(row.allocation):undefined;
        if(storage&&row&&namespace)layoutObserver.record(structuredClone({...base,kind:'storage',storage,row,namespace,origins:storageOrigins,
          ...(storageOverride?{override:storageOverride}:{}),...(elidedBy?{elidedBy}:{}),...(quantization?{quantization}:{})}));
      }
    }
    const unassignedTensorUses=graph.nodes.filter(n=>n.body.kind!=='collective').flatMap(n=>[...new Set([...n.portBindings.map(p=>p.tensorId),...ruleTensors(n),...(resolved.objectBindings.find(b=>b.nodeId===n.nodeId)?.tensors.map(t=>t.tensorId)??[])])].filter(id=>!tensorLayouts.some(t=>t.nodeId===n.nodeId&&t.tensorId===id)).map(tensorId=>({nodeId:n.nodeId,tensorId})));
    const localCosts=evaluateDistributedCosts(resolved,scenario,assets,{tensorLayouts,storageLayouts,storageAllocations},diagnostics,singleDeviceBaseline,local?.localCost),fusions=evaluateFusions(resolved,scenario,assets,{tensorLayouts,storageLayouts,storageAllocations},localCosts,diagnostics,singleDeviceBaseline,fusion);
    const unassignedStorageIds=[...new Set(graph.storages.map(s=>canonicalStorage(s.storageId)))].filter(id=>!storageGroups.has(id));let execution:ParallelResolution['execution'],baseline:ParallelResolution['execution']|undefined;try{const runtime=fusionRuntime(resolved,scenario,tensorLayouts,localCosts,fusions,singleDeviceBaseline);const runtimeCommunications=communications.map(c=>({...c,evaluation:{...c.evaluation,definition:{...c.evaluation.definition,...(runtime.scenario.parallelPlan.communications[c.index]?.placement?{placement:runtime.scenario.parallelPlan.communications[c.index]?.placement}:{})}}}));if(scenario.executionPlan.kind==='streams'){const scheduled=buildStreamsExecution(runtime.resolved,runtime.scenario,{tensorLayouts:runtime.tensorLayouts,communications:runtimeCommunications,localCosts:runtime.localCosts},{resolved,tensorLayouts,localCosts,fusions,singleDeviceBaseline},assets,diagnostics);execution=scheduled.execution;baseline=scheduled.baseline;}else execution=buildSerialExecution(runtime.resolved,runtime.scenario,{tensorLayouts:runtime.tensorLayouts,communications:runtimeCommunications,localCosts:runtime.localCosts},diagnostics);fusionMemoryOrder(execution,fusions);}catch(e){const diagnosticId='fusion-execution-'+diagnostics.length;diagnostics.push({diagnosticId,severity:'error',code:e instanceof FormulaError?e.code:'invalid_fusion_execution',message:e instanceof Error?e.message:'融合执行边界不可用',location});execution={status:'unavailable',diagnosticIds:[diagnosticId]};}
    const capturedMemory:MemoryEvidence[]=[];
    const memoryInput={storageAllocations,tensorLayouts,localCosts,communications,execution,unassignedStorageIds,fusions,singleDeviceBaseline},timed=scenario.executionPlan.kind==='streams'?temporalMemory(resolved,scenario,assets,memoryInput,diagnostics):undefined,memory=applyTotalPeakOverrides(timed?.memory??distributedSerialMemory(resolved,scenario,assets,memoryInput,diagnostics,evidence=>capturedMemory.push(evidence)),resolved,scenario,assets,diagnostics),serialBaseline=baseline?{execution:baseline,memory:applyTotalPeakOverrides(distributedSerialMemory(resolved,scenario,assets,{...memoryInput,execution:baseline},diagnostics),resolved,scenario,assets,diagnostics)}:undefined;
    const attempt=ParallelResolutionAttempt.parse({status:'available',result:{memoryEvidence:timed?.memoryEvidence??capturedMemory,...(serialBaseline?{serialBaseline}:{}),...(timed?{temporalMemory:timed.evidence}:{}),fusions,...(singleDeviceBaseline?{singleDeviceBaseline:true}:{}),quantizationApplications:resolved.quantizationApplications,engineVersion:ENGINE_VERSION,inputHash:await computeInputHash(pack.scenario,assets,stepContext),scenarioId:scenario.scenarioId,phase:resolved.phase,tensorLayouts,storageLayouts,storageAllocations,communications,deviceAllocations,localCosts,execution,memory,unassignedTensorUses,unassignedTensorIds:graph.tensors.filter(t=>!tensorLayouts.some(l=>l.tensorId===t.tensorId)).map(t=>t.tensorId),unassignedStorageIds,diagnostics}});
    if(attempt.status==='available'){const issues=validateParallelResolution(attempt.result);if(issues.length)return ParallelResolutionAttempt.parse({status:'unavailable',diagnostics:issues});}return attempt;
  }catch(e){diagnostics.push({diagnosticId:'parallel-resolution-failure',severity:'error',code:e instanceof FormulaError?e.code:'invalid_parallel_plan',message:e instanceof Error?e.message:'并行作用域解析失败',location});return ParallelResolutionAttempt.parse({status:'unavailable',diagnostics});}
}







