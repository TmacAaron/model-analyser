import type { AssetDocument,DecodeStepContext,DecodeStateTransition,MemoryPeak,ResolvedGraph,Scenario,StorageId,StorageSpec } from '@model-analyser/contracts';
import { analyzeScenario,usesDistributedAnalysis } from './analyze.js';
import { visitDecodeSteps,type DecodeStepMemory } from './decode.js';
import { calculationInput,hashCanonicalInput,stableStringify } from './input-hash.js';
import { instantiateModel } from './instantiate.js';
import { resolveParallelPlan } from './parallel-plan.js';
import { applyStorageAllocationOverrides } from './storage-allocation-overrides.js';
import { slotRows,solveKvSlots,type DeviceBudget,type SlotRows,type SlotStorage } from './kv-capacity-slots.js';
import { validateScenario } from '../../contracts/src/scenario-validation.js';

type DeviceLimit={deviceId:string;capacityBytes:number};
type DeviceRow=DeviceLimit&{
  kvBytes?:number|undefined;
  otherStateBytes?:number|undefined;
  nonKvBytes?:number|undefined;
};
type Frame={result:DecodeStepMemory;memory:MemoryPeak[];stateTransitions:DecodeStateTransition[]};
type StepBoundary={index:number;contextAfter:number};
type StateSpec=ResolvedGraph['graph']['states'][number];
type Budget=ReturnType<typeof solveKvSlots>|{status:'unavailable';reason:string};
export type KvCapacityReport={
  inputHash:string;
  scenarioId:string;
  phase:Scenario['workload']['kind'];
  batchSize:number;
  stateCount:number;
  storageCount:number;
  referenceTokensPerRequest?:number|undefined;
  decodeStep?:number|undefined;
  currentKvBytes?:number|undefined;
  averageBytesPerToken?:number|undefined;
  replicatedBytesPerToken?:number;
  shardedBytesPerToken?:number;
  requestPartitionedBytesPerToken?:number;
  fixedSlotsPerRequest?:number;
  rowProfile?:{groupSizes:number[];fixedWindows:number[];includesIndexer:boolean};
  devices:DeviceRow[];
  budget:Budget;
};
export type KvCapacityAttempt={status:'available';report:KvCapacityReport}|{status:'unavailable';message:string};

function add(a:number,b:number){
  const value=a+b;
  if(!Number.isSafeInteger(value)||value<0)throw Error('缓存字节数超出精确整数范围。');
  return value;
}
function knownSum(values:(number|undefined)[]){
  return values.some(value=>value===undefined)?undefined:values.reduce<number>((sum,value)=>add(sum,value??0),0);
}
const present=(value:{status:string;quantity?:{value:number}}|undefined)=>value?.status==='available'?value.quantity?.value:undefined;
const extent=(axis:Extract<StorageSpec['allocation'],{kind:'tensor'}>['shape'][number])=>axis.size.kind==='literal'?axis.size.quantity.value:undefined;

function backing(id:StorageId,storages:ReadonlyMap<StorageId,StorageSpec>){
  const seen=new Set<StorageId>();
  let spec=storages.get(id);
  while(spec?.allocation.kind==='alias'){
    if(seen.has(spec.storageId))throw Error('KV 存储别名存在循环。');
    seen.add(spec.storageId);
    spec=storages.get(spec.allocation.targetStorageId);
  }
  if(!spec)throw Error('缓存声明缺少规范存储。');
  return spec.storageId;
}

function frameDevices(frame:Frame,devices:DeviceLimit[],ids:ReadonlySet<StorageId>):DeviceRow[]{
  const transitions=new Map<string,Map<StorageId,DecodeStateTransition['storages'][number]>>();
  for(const state of frame.stateTransitions)for(const row of state.storages){
    const onDevice=transitions.get(row.deviceId)??new Map();
    onDevice.set(row.storageId,row);transitions.set(row.deviceId,onDevice);
  }
  const layout=frame.result.distributed?.layout,missing=new Set(layout?.unassignedStorageIds??[]);
  const layouts=new Map(layout?.storageAllocations.filter(row=>ids.has(row.storageId)).map(row=>
    [row.storageId,new Map(row.allocation.perDevice.map(device=>[String(device.deviceId),device.totalBytes]))]));
  const memories=new Map<string,MemoryPeak>();
  for(const peak of frame.memory){
    const scope=peak.deviceScope;
    for(const id of scope.kind==='per_device'?[scope.deviceId]:scope.deviceIds)memories.set(id,peak);
  }
  const allocationsByDevice=layout?.memoryEvidence??frame.result.memoryEvidence;
  const evidence=new Map(allocationsByDevice?.map(row=>[String(row.deviceId),row]));
  return devices.map(device=>{
    const {deviceId,capacityBytes}=device;
    const memory=memories.get(deviceId),allocations=evidence.get(deviceId)?.allocations;
    const modelRows=new Map(allocations?.filter(allocation=>ids.has(allocation.storageId)).map(allocation=>[allocation.storageId,allocation]));
    const reserved=transitions.get(deviceId);
    const kvBytes=knownSum([...ids].map(id=>{
      if(missing.has(id))return undefined;
      const transition=reserved?.get(id),allocation=modelRows.get(id),physical=layouts.get(id);
      return transition?present(transition.reservedBytes):
        allocation?present(allocation.bytes):physical?(physical.has(deviceId)?present(physical.get(deviceId)):0):undefined;
    }));
    const otherStateBytes=allocations?knownSum(allocations.filter(row=>row.category==='state'&&!ids.has(row.storageId))
      .map(row=>present(reserved?.get(row.storageId)?.reservedBytes??row.bytes))):undefined;
    const peak=present(memory?.peakBytes),stateBytes=present(memory?.categoryBreakdown.find(row=>row.category==='state')?.bytes);
    const accounted=allocations&&[...ids].every(id=>{
      const allocation=modelRows.get(id);
      return allocation?allocation.category==='state'&&allocation.resident:layouts.has(id)&&!layouts.get(id)?.has(deviceId);
    });
    return {...device,kvBytes,otherStateBytes,
      nonKvBytes:accounted&&memory?.capacityBytes===capacityBytes&&!memory.totalOverride&&
        kvBytes!==undefined&&peak!==undefined&&(stateBytes??0)>=kvBytes&&peak>=kvBytes?peak-kvBytes:undefined};
  });
}

function tokensAtState(state:StateSpec,scenario:Scenario,step:StepBoundary|undefined){
  const workload=scenario.workload;
  const past=workload.kind==='decode'?workload.contextTokensPerRequest:workload.pastTokensPerRequest;
  const raw=state.allocationBasis==='step_end'?add(past,workload.queryTokensPerRequest):
    step&&workload.kind==='decode'&&workload.approximation!=='fixed_context'?step.contextAfter:past;
  if(state.updatePolicy.kind==='append')return raw;
  if(state.updatePolicy.kind==='windowed'&&state.updatePolicy.window.kind==='literal')return state.updatePolicy.reserveFullWindow?raw:Math.min(raw,state.updatePolicy.window.quantity.value);
  return undefined;
}

function isKv(state:StateSpec){
  return state.stateKind==='kv'||state.stateKind==='latent'||
    state.stateKind==='window'&&state.updatePolicy.kind==='windowed'&&state.updatePolicy.reserveFullWindow||
    state.stateKind==='indexer'&&state.updatePolicy.kind==='append'&&state.updatePolicy.tokensPerRow!==undefined;
}

async function measureStep(scenario:Scenario,assets:AssetDocument[],context?:DecodeStepContext){
  if(usesDistributedAnalysis(scenario)){
    const attempt=await resolveParallelPlan(scenario,assets,context);
    if(attempt.status==='unavailable')return attempt;
    const {storageAllocations,unassignedStorageIds,execution,memoryEvidence,singleDeviceBaseline,memory,diagnostics,localCosts,communications}=attempt.result;
    const result:DecodeStepMemory={memory,diagnostics,distributed:{layout:{storageAllocations,unassignedStorageIds,execution,
      ...(memoryEvidence?{memoryEvidence}:{}),...(singleDeviceBaseline?{singleDeviceBaseline}:{})}}};
    return {status:'available' as const,result,leafCount:localCosts.nodes.length+communications.length};
  }
  const attempt=await analyzeScenario(scenario,assets,context);
  if(attempt.status==='unavailable')return attempt;
  const {memory,memoryEvidence,distributed,diagnostics,nodes}=attempt.result;
  const result:DecodeStepMemory={memory,diagnostics,...(memoryEvidence?{memoryEvidence}:{}),...(distributed?{distributed}:{})};
  return {status:'available' as const,result,leafCount:nodes.length};
}

function rowsForState(state:StateSpec):SlotRows|undefined{
  const policy=state.updatePolicy;
  if(policy.kind==='append'){
    if(policy.fixedCapacity?.kind==='literal')return {kind:'fixed',rows:policy.fixedCapacity.quantity.value};
    return policy.tokensPerRow!==undefined&&policy.tokensPerRow>1?{kind:'grouped',tokensPerRow:policy.tokensPerRow}:undefined;
  }
  if(policy.kind==='windowed'&&policy.reserveFullWindow&&policy.window.kind==='literal'){
    return {kind:'fixed',rows:policy.window.quantity.value};
  }
  throw Error('窗口或覆盖式缓存需要独立的容量规则。');
}

/** Report resident cache allocations and a KV-only slot budget on the current physical layout. */
export async function estimateKvCapacity(scenario:Scenario,assets:AssetDocument[]):Promise<KvCapacityAttempt>{
  try{
    const pack=calculationInput(scenario,assets);
    const failure=(diagnostics:DecodeStepMemory['diagnostics']):KvCapacityAttempt=>({status:'unavailable',
      message:(diagnostics.find(row=>row.severity==='error')??diagnostics[0])?.message??'无法计算当前配置。'});
    const invalid=validateScenario(pack.scenario,pack.assets).filter(row=>row.severity==='error');
    if(invalid.length)return failure(invalid);
    const devices=pack.scenario.deviceTopology.devices.map(device=>{
      const asset=pack.assets.find(asset=>asset.assetId===device.hardware.assetId&&asset.revision===device.hardware.revision);
      if(asset?.definition.kind!=='hardware')throw Error('设备 '+device.deviceId+' 缺少固定硬件快照。');
      return {deviceId:device.deviceId,capacityBytes:asset.definition.hardware.capacityBytes};
    });
    function snapshot(frame:Frame,resolved:ResolvedGraph,active:Scenario,step?:StepBoundary){
      const {graph,parameters}=resolved;
      const declared=active.numericOverrides.some(row=>row.target.kind==='storage'&&row.field==='memory_bytes')?
        graph.storages.map(row=>({...row})):graph.storages;
      applyStorageAllocationOverrides(declared,active.numericOverrides);
      const storages=new Map(declared.map(row=>[row.storageId,row]));
      const states=graph.states.filter(isKv),ids=new Set(states.flatMap(state=>state.storageIds.map(id=>backing(id,storages))));
      const layout=frame.result.distributed?.layout;
      const allocations=new Map(layout?.storageAllocations.filter(row=>ids.has(row.storageId)).map(row=>[row.storageId,row.allocation.distribution]));
      const afterSpecs=new Map(frame.stateTransitions.flatMap(state=>state.storages.filter(row=>ids.has(row.storageId))
        .map(row=>[row.storageId,row.afterStorage] as const)));
      const rows=frameDevices(frame,devices,ids);
      return {active,step,parameters,allStates:graph.states,storages,states,ids,allocations,afterSpecs,rows,
        hasLayout:!!layout,singleDeviceBaseline:layout?.singleDeviceBaseline};
    }
    const observed:{latest?:ReturnType<typeof snapshot>}={};
    function record(frame:Frame,resolved:ResolvedGraph,active:Scenario,step?:StepBoundary){
      const next=snapshot(frame,resolved,active,step),previous=observed.latest;
      if(previous){
        if(previous.ids.size!==next.ids.size||[...previous.ids].some(id=>!next.ids.has(id)))throw Error('逐步分析中的 KV 存储身份不同，无法形成统一预算。');
        for(const [index,device] of next.rows.entries()){
          const priorReserve=previous.rows[index]?.nonKvBytes;
          device.nonKvBytes=priorReserve===undefined||device.nonKvBytes===undefined?undefined:Math.max(priorReserve,device.nonKvBytes);
        }
      }
      observed.latest=next;
    }
    let inputHash:string;
    if(pack.scenario.workload.kind==='decode'&&pack.scenario.workload.steps>1){
      const sequence=await visitDecodeSteps(pack.scenario,pack.assets,measureStep,(step,resolved)=>{
        record(step,resolved,step.scenario,{index:step.index,contextAfter:step.contextAfter});
      });
      if(sequence.status==='unavailable')return failure(sequence.diagnostics);
      inputHash=sequence.inputHash;
    }else{
      const attempt=await measureStep(pack.scenario,pack.assets);
      if(attempt.status==='unavailable')return failure(attempt.diagnostics);
      const expanded=instantiateModel(pack.scenario,pack.assets);
      if(expanded.status==='unavailable')return failure(expanded.diagnostics);
      record({result:attempt.result,memory:attempt.result.memory,stateTransitions:[]},expanded.resolved,pack.scenario);
      inputHash=await hashCanonicalInput(pack.canonicalInput);
    }
    const measured=observed.latest;
    if(!measured)throw Error('当前配置没有已分析的执行步骤。');
    const {active,step,parameters,allStates,storages,states,ids,allocations,afterSpecs,rows,hasLayout,singleDeviceBaseline}=measured;
    const model=pack.assets.find(asset=>asset.assetId===active.model.assetId&&asset.revision===active.model.revision);
    // These published research revisions describe their allocations in the model
    // rather than in the state policy used by newer presets. Keep their snapshots intact.
    const compression=model?.extensions?.['compression'];
    const groupedRatio=active.model.revision===1&&active.model.assetId.startsWith('builtin:compression:')&&
      typeof compression==='object'&&compression!==null&&!Array.isArray(compression)&&
      compression['version']==='compression-research.1'&&compression['allocation']==='dynamic'&&
      (compression['ratio']===2||compression['ratio']===4)?compression['ratio']:undefined;
    const fixedParam=active.model.revision===1&&['builtin:model:parallel-dcp2','example:dcp:2:model','example:dcp:1:model'].includes(active.model.assetId)?
      parameters.find(parameter=>parameter.nodeId==='$model'&&parameter.parameterKey==='M')?.value:undefined;
    const fixedPolicy=states[0]?.updatePolicy;
    const declaredSlots=fixedPolicy?.kind==='append'&&fixedPolicy.fixedCapacity?.kind==='literal'?fixedPolicy.fixedCapacity.quantity.value:undefined;
    const fixedSlots=fixedParam?.kind==='integer'?fixedParam.value:declaredSlots!==undefined&&states.every(state=>
      state.updatePolicy.kind==='append'&&state.updatePolicy.fixedCapacity?.kind==='literal'&&
      state.updatePolicy.fixedCapacity.quantity.value===declaredSlots)?declaredSlots:undefined;
    const slots=new Set(states.map(state=>tokensAtState(state,active,step)));
    const reference=slots.size===1?[...slots][0]:undefined;
    const currentKvBytes=states.length?knownSum(rows.map(device=>device.kvBytes)):undefined;
    const batchSize=active.workload.batchSize;
    const specs=[...ids].map(id=>{
      const spec=afterSpecs.get(id)??storages.get(id);
      if(!spec)throw Error('缺少缓存存储 '+id+'。');
      return spec;
    });
    const matchesBatch=specs.every(spec=>{
      if(spec.allocation.kind!=='tensor')return false;
      const axes=spec.allocation.shape.filter(axis=>axis.semantic==='batch');
      const first=axes[0];
      return first?axes.length===1&&extent(first)===batchSize:batchSize===1;
    });
    const batchTokens=(fixedSlots??reference??0)*batchSize;
    const averageBytesPerToken=currentKvBytes!==undefined&&matchesBatch&&Number.isSafeInteger(batchTokens)&&batchTokens>0?currentKvBytes/batchTokens:undefined;
    let budget:Budget,rowProfile:KvCapacityReport['rowProfile'],perDeviceRate:Pick<KvCapacityReport,'replicatedBytesPerToken'|'shardedBytesPerToken'|'requestPartitionedBytesPerToken'>={};
    try{
      if(!states.length)throw Error('此模型在当前阶段没有声明 KV 或 MLA latent 缓存。');
      const rules=new Map<StorageId,SlotRows|undefined>();
      for(const state of states){
        const rule:SlotRows|undefined=state.stateKind==='kv'&&fixedSlots!==undefined?{kind:'fixed',rows:fixedSlots}:
          state.stateKind==='latent'&&state.stateId==='compress::main'&&groupedRatio!==undefined?{kind:'grouped',tokensPerRow:groupedRatio}:rowsForState(state);
        for(const storageId of state.storageIds){
          const id=backing(storageId,storages);
          if(rules.has(id)&&stableStringify(rules.get(id)??null)!==stableStringify(rule??null)){
            throw Error('共享缓存声明了不同的分组或窗口规则。');
          }
          rules.set(id,rule);
        }
      }
      const groupSizes=new Set<number>(),fixedWindows=new Set<number>();
      for(const rule of rules.values()){
        if(rule?.kind==='grouped')groupSizes.add(rule.tokensPerRow);
        if(rule?.kind==='fixed'&&fixedSlots===undefined)fixedWindows.add(rule.rows);
      }
      const includesIndexer=states.some(state=>state.stateKind==='indexer');
      if(groupSizes.size||fixedWindows.size||includesIndexer)rowProfile={groupSizes:[...groupSizes].sort((a,b)=>a-b),
        fixedWindows:[...fixedWindows].sort((a,b)=>a-b),includesIndexer};
      if(allStates.filter(state=>!isKv(state)).some(state=>state.storageIds.some(id=>ids.has(backing(id,storages)))))throw Error('KV 与其他持久状态共享存储，无法独立调整缓存长度。');
      if(!matchesBatch||reference===undefined)throw Error('缓存没有统一的每请求 token 轴和批大小。');
      const limits:DeviceBudget[]=rows.map(device=>{
        if(device.kvBytes===undefined||device.nonKvBytes===undefined)throw Error('部分设备缺少可分离的 KV 与非 KV 峰值，包括无法分解的总峰值覆盖。');
        return {...device,currentKvBytes:device.kvBytes,nonKvBytes:device.nonKvBytes};
      });
      const firstBytes=rows[0]?.kvBytes;
      if(hasLayout&&devices.length>1&&averageBytesPerToken!==undefined&&firstBytes!==undefined&&rows.every(row=>row.kvBytes===firstBytes)){
        const groups=new Map(active.deviceTopology.groups.map(group=>[group.groupId,group]));
        const placement=specs.map(spec=>{
          const distribution=allocations.get(spec.storageId);
          if(!distribution||groups.get(distribution.groupId)?.members.length!==devices.length)return;
          if(distribution.kind==='replicated')return 'replicated';
          if(distribution.kind!=='sharded'||spec.allocation.kind!=='tensor')return;
          const axes=new Set(spec.allocation.shape.filter(axis=>axis.semantic==='batch'||axis.semantic==='token').map(axis=>axis.axisId));
          if(distribution.axes.every(axis=>!axes.has(axis.tensorAxisId)))return 'sharded';
        });
        if(placement.every(kind=>kind==='replicated'))perDeviceRate={replicatedBytesPerToken:firstBytes/batchTokens};
        if(placement.every(kind=>kind==='sharded'))perDeviceRate={shardedBytesPerToken:firstBytes/batchTokens};
        const requestWidths=specs.map(spec=>{
          const distribution=allocations.get(spec.storageId);
          if(distribution?.kind!=='sharded'||distribution.policy.kind!=='even'||spec.allocation.kind!=='tensor')return;
          const batch=spec.allocation.shape.find(axis=>axis.semantic==='batch');
          const axis=distribution.axes.find(axis=>axis.tensorAxisId===batch?.axisId);
          return groups.get(distribution.groupId)?.mesh?.axes.find(mesh=>mesh.axisId===axis?.meshAxisId)?.size;
        });
        const width=requestWidths[0];
        if(width&&width>1&&requestWidths.every(value=>value===width)){
          perDeviceRate.requestPartitionedBytesPerToken=firstBytes/(batchTokens/width);
        }
      }
      const profile:SlotStorage[]=specs.map(spec=>{
        const allocation=spec.allocation;
        if(allocation.kind!=='tensor')throw Error('缓存使用固定或自定义字节公式，缺少可伸缩张量分配。');
        const axes=allocation.shape.filter(axis=>axis.semantic==='token'),token=axes[0],rule=rules.get(spec.storageId);
        if(!token||axes.length!==1||extent(token)!==slotRows(reference,rule))throw Error('缓存 '+spec.storageId+' 的物理长度与声明的 token 分配规则不符。');
        if(allocation.shape.some(axis=>axis!==token&&(!extent(axis)||!Number.isSafeInteger(extent(axis)))))throw Error('缓存含有未知或空的非 token 维度。');
        const distribution=allocations.get(spec.storageId);
        if(hasLayout&&!distribution)throw Error('缓存缺少已解析的分片规则。');
        // The execution planner replicates the complete object onto a synthetic one-card group.
        // The slot solver can size the exact same object on that card without the synthetic group.
        return {spec:{...spec,allocation},tokenAxis:token.axisId,...(rule?{rows:rule}:{}),...(distribution&&!singleDeviceBaseline?{distribution}:{})};
      });
      budget=solveKvSlots(profile,active.deviceTopology,limits,reference);
    }catch(error){
      budget={status:'unavailable',reason:error instanceof Error?error.message:'无法计算 KV 预算。'};
    }
    return {status:'available',report:{inputHash,scenarioId:active.scenarioId,phase:active.workload.kind,batchSize,
      stateCount:states.length,storageCount:ids.size,referenceTokensPerRequest:reference,decodeStep:step?.index,
      currentKvBytes,averageBytesPerToken,devices:rows,budget,...perDeviceRate,
      ...(budget.status==='fixed'&&fixedSlots!==undefined?{fixedSlotsPerRequest:fixedSlots}:{}),...(rowProfile?{rowProfile}:{})}};
  }catch(error){
    return {status:'unavailable',message:error instanceof Error?error.message:'无法计算当前配置的 KV 容量。'};
  }
}
