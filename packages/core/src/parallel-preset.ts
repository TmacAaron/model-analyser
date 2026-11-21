import { ParallelPresetRequest,ParallelPresetAttempt,Scenario,NodeId,AssetDocument,type TensorDistribution,type ParallelPresetPreview,type MetricValue,type ParallelPresetTemplate,type ResolvedGraph,type ValueExpr } from '@model-analyser/contracts';
import { instantiateModel } from './instantiate.js';
import { calculationInput,computeInputHash } from './input-hash.js';
import { resolveParallelPlan } from './parallel-plan.js';
import { materializeDeclaredPreset } from './declared-parallel-preset.js';
import { FormulaError } from './formula.js';
import { expertMeshPresets } from './expert-mesh-preset.js';
import { canonical } from '../../contracts/src/validation.js';
import replicaPayload from '../../../assets/builtin/formula/parallel-replica-payload.json' with {type:'json'};

type ExpertMesh = NonNullable<Scenario['parallelPlan']['generatedFrom']>['expertMesh'];
const replicaPayloadFormula=AssetDocument.parse(replicaPayload);
export const requestReplicaMeshAxis='$request';
const requestAxis=requestReplicaMeshAxis;

function payloadPerReplica(payload:ValueExpr,replicas:number):ValueExpr{
  return {kind:'formula',call:{formula:{assetId:replicaPayloadFormula.assetId,revision:replicaPayloadFormula.revision,kind:'formula'},
    bindings:{bytes:payload,replicas:{kind:'literal',quantity:{value:replicas,unit:'count'}}}}};
}

/** Map authored local ports through the same occurrence bindings used by the expanded graph. */
function expandPresetRules(preset:ParallelPresetTemplate,resolved:ResolvedGraph){
  const tensorShards=[...preset.tensorShards],reductions=[...preset.reductions];
  const objects=new Map(resolved.objectBindings.map(binding=>[binding.nodeId,binding]));
  for(const rule of preset.moduleRules??[]){
    if(rule.module.kind!=='module')throw Error('模块分片规则必须引用固定模块修订');
    const occurrences=resolved.containers.filter(container=>container.asset.kind==='module'&&
      container.asset.assetId===rule.module.assetId&&container.asset.revision===rule.module.revision&&objects.has(container.nodeId));
    if(!occurrences.length)throw Error('当前阶段没有模块分片目标 '+rule.module.assetId+'@'+rule.module.revision);
    for(const occurrence of occurrences){
      const binding=objects.get(occurrence.nodeId);
      if(!binding)continue;
      const tensor=(localId:string)=>{
        const entry=binding.tensors.find(value=>value.localTensorId===localId);
        if(!entry)throw Error('模块调用缺少分片张量 '+occurrence.nodeId+'/'+localId);
        return entry;
      };
      const node=(localId:string)=>NodeId.parse(occurrence.nodeId+'/'+encodeURIComponent(localId));
      for(const shard of rule.tensorShards){
        const entry=tensor(shard.tensorId),axis=entry.axes.find(axis=>axis.localAxisId===shard.axisId);
        if(!axis)throw Error('模块调用缺少分片轴 '+occurrence.nodeId+'/'+shard.tensorId+'.'+shard.axisId);
        tensorShards.push({...shard,tensorId:entry.tensorId,axisId:axis.axisId});
      }
      for(const reduction of rule.reductions)reductions.push({
        ...reduction,tensorId:tensor(reduction.tensorId).tensorId,
        producerNodeId:node(reduction.producerNodeId),consumerNodeIds:reduction.consumerNodeIds.map(node),
      });
    }
  }
  return {tensorShards,reductions};
}

/** Materialize an explicitly authored model recipe. Never infer local work by dividing global cost. */
export async function previewParallelPreset(input:ParallelPresetRequest):Promise<ParallelPresetAttempt>{
  try{
    const request=ParallelPresetRequest.parse(input),{scenario,assets}=request,model=assets.find(a=>a.assetId===scenario.model.assetId&&a.revision===scenario.model.revision),preset=model?.parallelPresets?.find(p=>p.presetId===request.presetId);
    if(model?.definition.kind!=='model'||!preset)throw new FormulaError('missing_parallel_preset','当前固定模型未声明此并行预设；需作者提供局部方程和布局语义。');
    if(!preset.phases.includes(scenario.workload.kind))throw new FormulaError('unsupported_phase','此预设不适用于当前阶段');
    const group=scenario.deviceTopology.groups.find(g=>g.groupId===request.groupId);if(!group)throw new FormulaError('missing_reference','请选择实际物理设备组');
    const degree=group.members.length;if(degree<1||degree>64)throw new FormulaError('preset_limit','快捷预设支持 1–64 个明确物理设备');
    const requestDp=request.requestDp??1,replicaWidth=degree/requestDp;
    if(request.requestDp){
      if(preset.strategy!=='tensor_sharded'||!model.parallelPresets?.some(p=>p.strategy==='batch_sharded'&&p.phases.includes(scenario.workload.kind)))throw Error('当前模型未声明可与张量分片组合的请求 DP');
      if(!Number.isInteger(replicaWidth)||replicaWidth<2)throw Error('物理卡数须容纳完整的请求副本，每个副本至少两张并行卡');
      if(request.meshAxisId===requestAxis)throw Error('设备分片轴与请求轴重名');
      if(scenario.workload.batchSize%requestDp!==0)throw Error('Batch 必须能被请求 DP '+requestDp+' 整除');
    }
    const oldExpertGroup=scenario.parallelPlan.generatedFrom?.expertMesh?.groupId;
    const cleanTopology={...scenario.deviceTopology,groups:scenario.deviceTopology.groups.filter(g=>g.groupId!==oldExpertGroup||g.groupId===group.groupId)};
    if(preset.strategy==='declared_plan'){
      if(request.expertMesh)throw Error('此声明式预设已固定设备网格');
      const {topology,plan}=materializeDeclaredPreset({...request,scenario:{...scenario,deviceTopology:cleanTopology}},preset);
      return await finishPreset(request,model,preset,topology,plan);
    }
    const origin=scenario.parallelPlan.generatedFrom;
    const previousRequestMesh=origin?.requestDp&&origin.groupId===group.groupId&&origin.meshAxisId===request.meshAxisId;
    if(group.mesh&&!previousRequestMesh&&!group.mesh.axes.some(a=>a.axisId===request.meshAxisId&&a.size===degree))throw new FormulaError('invalid_preset_mesh','此预设需要有序设备池及其完整设备轴');
    const requestAxes=request.requestDp?[{axisId:requestAxis,size:requestDp}]:[];
    const requestCoordinate=(i:number)=>request.requestDp?[Math.floor(i/replicaWidth)]:[];
    const mesh=group.mesh&&!request.requestDp&&!previousRequestMesh?group.mesh:{axes:[...requestAxes,{axisId:request.meshAxisId,size:replicaWidth}],
      coordinates:group.members.map((deviceId,i)=>({deviceId,coordinates:[...requestCoordinate(i),i%replicaWidth]}))};
    const topology={...cleanTopology,groups:cleanTopology.groups.map(g=>g.groupId===group.groupId?{...g,mesh}:g)};
    const expanded=instantiateModel(scenario,assets);if(expanded.status==='unavailable')throw Error(expanded.diagnostics.map(d=>d.code+' '+d.message).join('；'));const graph=expanded.resolved.graph;
    if(preset.strategy!=='tensor_sharded'&&(preset.tensorShards.length||preset.reductions.length||preset.moduleRules))throw Error('复制/DP 预设不能夹带隐式 TP 分片或归约');
    let parts=[{preset,groupId:group.groupId,meshAxisId:request.meshAxisId,size:replicaWidth}];
    let expertMesh:ExpertMesh;
    if(request.expertMesh){
      const {ep,tp}=request.expertMesh,recipes=expertMeshPresets(model.parallelPresets??[],scenario.workload.kind);
      if(!recipes||preset!==recipes.ep&&preset!==recipes.shared)throw Error('当前模型未声明可合并的专家归约');
      if(ep*tp!==replicaWidth)throw Error('每个请求副本的专家网格需要 '+ep+' × '+tp+' 个不同的实际设备');
      const groupId='$expert-mesh:'+JSON.stringify([group.groupId,request.meshAxisId]);
      if(topology.groups.some(g=>g.groupId===groupId))throw Error('专家网格与已有设备组 ID 冲突');
      topology.groups.push({groupId,members:group.members,mesh:{axes:[...requestAxes,{axisId:'expert',size:ep},{axisId:'feature',size:tp}],
        coordinates:group.members.map((deviceId,i)=>({deviceId,coordinates:[...requestCoordinate(i),Math.floor((i%replicaWidth)/tp),i%tp]}))}});
      expertMesh={ep,tp,groupId};
      parts=[{preset:recipes.ep,groupId,meshAxisId:'expert',size:ep},{preset:recipes.tp,groupId,meshAxisId:'feature',size:tp}];
      if(preset===recipes.shared&&recipes.attention)parts.push({preset:recipes.attention,groupId:group.groupId,meshAxisId:request.meshAxisId,size:replicaWidth});
    }
    type Shard=Extract<TensorDistribution,{kind:'sharded'}>;
    const shardIds=new Map<string,Shard>(),reductionRules=new Map<string,ParallelPresetTemplate['reductions'][number]>();
    const tensorsById=new Map(graph.tensors.map(tensor=>[tensor.tensorId,tensor]));
    for(const part of parts){
      const {tensorShards,reductions}=expandPresetRules(part.preset,expanded.resolved);
      for(const rule of tensorShards){
        const axis=tensorsById.get(rule.tensorId)?.shape.find(value=>value.axisId===rule.axisId);
        if(!axis)throw Error('预设张量/轴不在当前展开图中：'+rule.tensorId+'.'+rule.axisId);
        if((expertMesh||request.requestDp)&&!rule.policy&&(axis.size.kind!=='literal'||axis.size.quantity.value%part.size!==0)){
          throw Error('均匀分片要求 '+rule.tensorId+'.'+rule.axisId+' 可整除 '+part.size);
        }
        const layout=shardIds.get(rule.tensorId)??{kind:'sharded' as const,groupId:part.groupId,axes:[],policy:{kind:'even' as const}};
        if(layout.groupId!==part.groupId||layout.axes.some(a=>a.tensorAxisId===rule.axisId||a.meshAxisId===part.meshAxisId))throw Error('预设重复声明张量分片 '+rule.tensorId);
        layout.axes.push({tensorAxisId:rule.axisId,meshAxisId:part.meshAxisId});
        if(rule.policy)layout.policy={kind:rule.policy};
        shardIds.set(rule.tensorId,layout);
      }
      for(const row of reductions){
        const previous=reductionRules.get(row.tensorId);
        if(previous&&(!expertMesh||canonical(previous)!==canonical(row)))throw Error('预设重复归约 '+row.tensorId);
        reductionRules.set(row.tensorId,row);
      }
    }
    const replicated:TensorDistribution={kind:'replicated',groupId:group.groupId};
    const strategy=preset.strategy;
    function batchAxis(shape:typeof graph.tensors[number]['shape']){
      const axes=shape.filter(a=>a.semantic==='batch');
      if(axes.length>1)throw Error('DP 快捷预设不猜测多 batch 轴含义');
      return axes[0];
    }
    function distribution(id:string,shape:typeof graph.tensors[number]['shape']):TensorDistribution {
      const layout=shardIds.get(id);
      const batch=request.requestDp||strategy==='batch_sharded'?batchAxis(shape):undefined;
      if(!batch)return layout??replicated;
      if(layout?.axes.some(axis=>axis.tensorAxisId===batch.axisId))throw Error('请求分片与现有张量分片使用同一轴：'+id);
      if(request.requestDp&&(batch.size.kind!=='literal'||batch.size.quantity.value%requestDp!==0))throw Error('请求轴无法均分：'+id);
      return {kind:'sharded',groupId:layout?.groupId??request.groupId,axes:[{tensorAxisId:batch.axisId,meshAxisId:request.requestDp?requestAxis:request.meshAxisId},
        ...layout?.axes??[]],policy:layout?.policy??{kind:'even'}};
    }
    const tensorStorages=new Set(graph.tensors.map(tensor=>tensor.storageId));
    const groupAssumptions=[...shardIds.values()].some(layout=>layout.policy.kind==='balanced')
      ? 'Balanced axes spread the remainder over the first ranks and reserve ceil(extent / degree) slots per rank. Even axes require exact division.'
      : 'Even partitioning; incompatible extents are rejected.';
    const plan:Scenario['parallelPlan']={assignments:[{selector:{kind:'subtree',rootNodeId:NodeId.parse('$model')},phases:preset.phases,tensorDistributions:graph.tensors.map(t=>({tensorId:t.tensorId,distribution:distribution(t.tensorId,t.shape)})),storageDistributions:graph.storages.filter(s=>!tensorStorages.has(s.storageId)).map(s=>({storageId:s.storageId,distribution:distribution(s.storageId,s.allocation.kind==='tensor'?s.allocation.shape:[])}))}],communications:[],assumptions:[`Generated from fixed model ${model.assetId}@${model.revision}, preset ${preset.presetId}. This records generation history; later manual edits remain explicit.`,preset.description,...preset.assumptions,`Group ${group.groupId}: ${degree} unique physical members. ${groupAssumptions}`,`Only declared localCost equations are evaluated; physical replicas may execute duplicate work. No implicit packing conversion, communication HBM/reduction arithmetic or staging allocation.`]};
    if(request.requestDp)plan.assumptions.push(`${requestDp} independent request replicas with ${replicaWidth} devices each. Reductions run concurrently within each replica and preserve its batch slice.`);
    if(expertMesh)plan.assumptions.push(...parts.filter(part=>part.preset!==preset).flatMap(part=>part.preset.assumptions),
      `MoE experts use ${expertMesh.ep} owner partitions and ${expertMesh.tp} intermediate-feature partitions per owner. Each request replica sums the partial tiles before the original merge boundary.`);
    for(const r of reductionRules.values()){
      const tensor=tensorsById.get(r.tensorId);
      if(!tensor||r.consumerNodeIds.some(id=>!graph.nodes.some(n=>n.nodeId===id)))throw Error('归约的张量或消费者未出现在当前阶段');
      const producer=graph.nodes.find(n=>n.nodeId===r.producerNodeId);if(producer?.body.kind!=='opaque'||!producer.body.outputs.some(p=>p.tensorId===r.tensorId))throw Error('归约来源不是声明节点的输出');
      const target=distribution(r.tensorId,tensor.shape);
      const partition=request.requestDp&&target.kind==='sharded'&&target.axes.length===1&&target.axes[0]?.meshAxisId===requestAxis?target.axes[0]:undefined;
      if(request.requestDp&&!partition)throw Error('归约输出须保留同一请求切片：'+r.tensorId);
      const partial:TensorDistribution={kind:'partial',groupId:group.groupId,reduceOperation:'sum',...(partition?{partition}:{})};
      plan.assignments.push({selector:{kind:'nodes',nodeIds:[r.producerNodeId]},phases:preset.phases,tensorDistributions:[{tensorId:r.tensorId,distribution:degree===1?replicated:partial}],storageDistributions:[]});
      if(degree===1)continue;if(!request.network)throw Error('请显式填写此组的通信带宽和单轮延迟');
      const payload=request.requestDp?payloadPerReplica(r.payloadBytes,requestDp):r.payloadBytes;
      plan.communications.push({operation:'all_reduce',groupId:group.groupId,source:{tensorId:r.tensorId,distribution:partial},destination:{tensorId:r.tensorId,distribution:partition?target:replicated},payloadDtype:r.payloadDtype,sendBytesPerMember:payload,receiveBytesPerMember:payload,
        algorithm:{name:partition?'Concurrent replica ring AllReduce: per-replica payload × 2(P-1)/P':'Declared ring AllReduce: full-message payload × 2(P-1)/P',trafficFactor:2*(replicaWidth-1)/replicaWidth,startupRounds:2*(replicaWidth-1)},timing:{kind:'bandwidth_latency',bytePerSecond:request.network.bytesPerSecond,latencySeconds:request.network.latencySeconds},placement:{nodeId:NodeId.parse('$reduce:'+r.producerNodeId+':'+r.tensorId),phases:preset.phases,afterNodeIds:[r.producerNodeId],beforeNodeIds:r.consumerNodeIds},temporaryStorageIds:[]});
    }
    return await finishPreset(request,model,preset,topology,plan,expertMesh);
  }catch(e){return ParallelPresetAttempt.parse({status:'unavailable',message:e instanceof Error?e.message:'并行预设无法生成'});}
}

async function finishPreset(request:ParallelPresetRequest,model:AssetDocument,preset:ParallelPresetTemplate,topology:Scenario['deviceTopology'],plan:Scenario['parallelPlan'],expertMesh?:ExpertMesh):Promise<ParallelPresetAttempt>{
    const {scenario,assets}=request;plan.generatedFrom={version:'parallel-preset.1',presetId:preset.presetId,modelId:model.assetId,modelRevision:model.revision,groupId:request.groupId,meshAxisId:request.meshAxisId,...(expertMesh?{expertMesh}:{}),...(request.requestDp?{requestDp:request.requestDp}:{})};
    const existing=assets.find(asset=>asset.assetId===replicaPayloadFormula.assetId&&asset.revision===replicaPayloadFormula.revision);
    if(request.requestDp&&existing&&canonical(existing)!==canonical(replicaPayloadFormula))throw Error('请求归约公式与固定内置修订冲突');
    const layoutAssets=request.requestDp&&!existing?[...assets,replicaPayloadFormula]:assets;
    const next=Scenario.parse({...scenario,deviceTopology:topology,parallelPlan:plan});
    const firstDecode=next.workload.kind==='decode'&&next.workload.steps>1?{...next,workload:{...next.workload,steps:1}}:undefined;
    const resolved=await resolveParallelPlan(firstDecode??next,layoutAssets);if(resolved.status==='unavailable')throw Error(resolved.diagnostics.map(d=>d.code+' '+d.message).join('；'));const result=resolved.result;
    if(result.execution.status!=='available')throw Error('生成的布局尚不能形成有效执行顺序：'+result.diagnostics.map(d=>d.message).join('；'));
    if(result.execution.result.blockedNodeIds.length||result.execution.result.unplacedCommunicationIndices.length)throw Error('生成的边界仍有未解决数据或通信；请手工补齐');
    if(result.unassignedStorageIds.length||result.unassignedTensorUses.length||result.localCosts.nodes.some(n=>n.placement.kind==='unplaced'||n.placement.kind==='placed'&&n.placement.perDevice.some(d=>d.outcome.status==='unavailable')))throw Error('所选模型仍缺少局部方程或物理分配，不能按设备数猜测成本');
    const value=(m:MetricValue)=>{if(m.status!=='available'||!Number.isSafeInteger(m.quantity.value))throw Error('预设的物理分配尚不完整或字节数溢出');return m.quantity.value;};
    const allocations=result.deviceAllocations.map(d=>({deviceId:d.deviceId,totalBytes:value(d.knownBytes),weightBytes:d.categoryBreakdown.find(c=>c.category==='weight')?.bytes,stateBytes:d.categoryBreakdown.find(c=>c.category==='state')?.bytes})).map(d=>({...d,weightBytes:d.weightBytes?value(d.weightBytes):0,stateBytes:d.stateBytes?value(d.stateBytes):0}));
    const warnings=[...new Set(result.diagnostics.filter(d=>d.severity!=='info').map(d=>d.code+' · '+d.message))];
    if(firstDecode)warnings.unshift('预览为第一个 Decode 步骤的布局和分配。正式分析按保存的步数逐步计算。');
    const widthName=expertMesh ? (preset.sharedPoolDegrees?.includes('attentionTp')?'Attention TP ＋ ':'')+'MoE EP × TP' : preset.name;
    const presetName=request.requestDp?'请求 DP × '+widthName:widthName;
    const preview:ParallelPresetPreview={version:'parallel-preset.1',presetId:preset.presetId,presetName,sourceModel:scenario.model,sourceInputHash:await computeInputHash(scenario,assets),scenario:next,assets:calculationInput(next,layoutAssets).assets,deviceIds:request.scenario.deviceTopology.groups.find(g=>g.groupId===request.groupId)?.members??[],assignmentCount:plan.assignments.length,communicationCount:result.communications.length,communications:result.communications.map(c=>c.evaluation.definition),allocations,warnings};
    return ParallelPresetAttempt.parse({status:'available',preview});
}
