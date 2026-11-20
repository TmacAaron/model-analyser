import { ParallelPresetRequest,ParallelPresetAttempt,Scenario,NodeId,type TensorDistribution,type ParallelPresetPreview,type MetricValue,type AssetDocument,type ParallelPresetTemplate,type ResolvedGraph } from '@model-analyser/contracts';
import { instantiateModel } from './instantiate.js';
import { calculationInput,computeInputHash } from './input-hash.js';
import { resolveParallelPlan } from './parallel-plan.js';
import { materializeDeclaredPreset } from './declared-parallel-preset.js';
import { FormulaError } from './formula.js';

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
    if(preset.strategy==='declared_plan'){const {topology,plan}=materializeDeclaredPreset(request,preset);return await finishPreset(request,model,preset,topology,plan);}
    const topology={...scenario.deviceTopology,groups:scenario.deviceTopology.groups.map(g=>g.groupId===group.groupId&&!g.mesh?{...g,mesh:{axes:[{axisId:request.meshAxisId,size:degree}],coordinates:g.members.map((deviceId,i)=>({deviceId,coordinates:[i]}))}}:g)},selected=topology.groups.find(g=>g.groupId===group.groupId);
    if(!selected?.mesh||!selected.mesh.axes.some(a=>a.axisId===request.meshAxisId&&a.size===degree))throw new FormulaError('invalid_preset_mesh','此预设使用全组的一维轴；多维混合布局请显式配置，不能把组名或并行度相乘当作独立设备。');
    const expanded=instantiateModel(scenario,assets);if(expanded.status==='unavailable')throw Error(expanded.diagnostics.map(d=>d.code+' '+d.message).join('；'));const graph=expanded.resolved.graph;
    if(preset.strategy!=='tensor_sharded'&&(preset.tensorShards.length||preset.reductions.length||preset.moduleRules))throw Error('复制/DP 预设不能夹带隐式 TP 分片或归约');
    const {tensorShards:shardRules,reductions:reductionRules}=expandPresetRules(preset,expanded.resolved);
    const shardIds=new Map<string,(typeof shardRules)[number]>(),tensorsById=new Map(graph.tensors.map(tensor=>[tensor.tensorId,tensor]));
    for(const rule of shardRules){
      if(shardIds.has(rule.tensorId))throw Error('预设重复声明张量分片 '+rule.tensorId);
      if(!tensorsById.get(rule.tensorId)?.shape.some(axis=>axis.axisId===rule.axisId))throw Error('预设张量/轴不在当前展开图中：'+rule.tensorId+'.'+rule.axisId);
      shardIds.set(rule.tensorId,rule);
    }
    const replicated:TensorDistribution={kind:'replicated',groupId:group.groupId},shard=(axisId:string,kind:'even'|'balanced'='even'):TensorDistribution=>({kind:'sharded',groupId:group.groupId,axes:[{tensorAxisId:axisId,meshAxisId:request.meshAxisId}],policy:{kind}});
    const strategy=preset.strategy;
    function distribution(id:string,shape:typeof graph.tensors[number]['shape']):TensorDistribution {
      const rule=shardIds.get(id);if(rule)return shard(rule.axisId,rule.policy);
      if(strategy==='batch_sharded'){const axes=shape.filter(a=>a.semantic==='batch');if(axes.length>1)throw Error('DP 快捷预设不猜测多 batch 轴含义');const axis=axes[0];if(axis)return shard(axis.axisId);}
      return replicated;
    }
    const tensorStorages=new Set(graph.tensors.map(tensor=>tensor.storageId));
    const groupAssumptions=shardRules.some(rule=>rule.policy==='balanced')
      ? 'Balanced axes spread the remainder over the first ranks and reserve ceil(extent / degree) slots per rank. Even axes require exact division.'
      : 'Even partitioning; incompatible extents are rejected.';
    const plan:Scenario['parallelPlan']={assignments:[{selector:{kind:'subtree',rootNodeId:NodeId.parse('$model')},phases:preset.phases,tensorDistributions:graph.tensors.map(t=>({tensorId:t.tensorId,distribution:distribution(t.tensorId,t.shape)})),storageDistributions:graph.storages.filter(s=>!tensorStorages.has(s.storageId)).map(s=>({storageId:s.storageId,distribution:distribution(s.storageId,s.allocation.kind==='tensor'?s.allocation.shape:[])}))}],communications:[],assumptions:[`Generated from fixed model ${model.assetId}@${model.revision}, preset ${preset.presetId}. This records generation history; later manual edits remain explicit.`,preset.description,...preset.assumptions,`Group ${group.groupId}: ${degree} unique physical members. ${groupAssumptions}`,`Only declared localCost equations are evaluated; physical replicas may execute duplicate work. No implicit packing conversion, communication HBM/reduction arithmetic or staging allocation.`]};
    const reductions=new Set<string>();for(const r of reductionRules){
      if(reductions.has(r.tensorId))throw Error('预设重复归约 '+r.tensorId);reductions.add(r.tensorId);
      if(!graph.tensors.some(t=>t.tensorId===r.tensorId)||!graph.nodes.some(n=>n.nodeId===r.producerNodeId)||r.consumerNodeIds.some(id=>!graph.nodes.some(n=>n.nodeId===id)))throw Error('归约的张量/生产者/消费者未出现在当前阶段');
      const producer=graph.nodes.find(n=>n.nodeId===r.producerNodeId);if(producer?.body.kind!=='opaque'||!producer.body.outputs.some(p=>p.tensorId===r.tensorId))throw Error('归约来源不是声明节点的输出');
      plan.assignments.push({selector:{kind:'nodes',nodeIds:[r.producerNodeId]},phases:preset.phases,tensorDistributions:[{tensorId:r.tensorId,distribution:degree===1?replicated:{kind:'partial',groupId:group.groupId,reduceOperation:'sum'}}],storageDistributions:[]});
      if(degree===1)continue;if(!request.network)throw Error('请显式填写此组的通信带宽和单轮延迟');
      plan.communications.push({operation:'all_reduce',groupId:group.groupId,source:{tensorId:r.tensorId,distribution:{kind:'partial',groupId:group.groupId,reduceOperation:'sum'}},destination:{tensorId:r.tensorId,distribution:replicated},payloadDtype:r.payloadDtype,sendBytesPerMember:r.payloadBytes,receiveBytesPerMember:r.payloadBytes,
        algorithm:{name:'Declared ring AllReduce: full-message payload × 2(P-1)/P',trafficFactor:2*(degree-1)/degree,startupRounds:2*(degree-1)},timing:{kind:'bandwidth_latency',bytePerSecond:request.network.bytesPerSecond,latencySeconds:request.network.latencySeconds},placement:{nodeId:NodeId.parse('$reduce:'+r.producerNodeId+':'+r.tensorId),phases:preset.phases,afterNodeIds:[r.producerNodeId],beforeNodeIds:r.consumerNodeIds},temporaryStorageIds:[]});
    }
    plan.generatedFrom={version:'parallel-preset.1',presetId:preset.presetId,modelId:model.assetId,modelRevision:model.revision,groupId:group.groupId,meshAxisId:request.meshAxisId};
    return await finishPreset(request,model,preset,topology,plan);
  }catch(e){return ParallelPresetAttempt.parse({status:'unavailable',message:e instanceof Error?e.message:'并行预设无法生成'});}
}

async function finishPreset(request:ParallelPresetRequest,model:AssetDocument,preset:ParallelPresetTemplate,topology:Scenario['deviceTopology'],plan:Scenario['parallelPlan']):Promise<ParallelPresetAttempt>{
    const {scenario,assets}=request;plan.generatedFrom={version:'parallel-preset.1',presetId:preset.presetId,modelId:model.assetId,modelRevision:model.revision,groupId:request.groupId,meshAxisId:request.meshAxisId};
    const next=Scenario.parse({...scenario,deviceTopology:topology,parallelPlan:plan});
    const firstDecode=next.workload.kind==='decode'&&next.workload.steps>1?{...next,workload:{...next.workload,steps:1}}:undefined;
    const resolved=await resolveParallelPlan(firstDecode??next,assets);if(resolved.status==='unavailable')throw Error(resolved.diagnostics.map(d=>d.code+' '+d.message).join('；'));const result=resolved.result;
    if(result.execution.status!=='available')throw Error('生成的布局尚不能形成有效执行顺序：'+result.diagnostics.map(d=>d.message).join('；'));
    if(result.execution.result.blockedNodeIds.length||result.execution.result.unplacedCommunicationIndices.length)throw Error('生成的边界仍有未解决数据或通信；请手工补齐');
    if(result.unassignedStorageIds.length||result.unassignedTensorUses.length||result.localCosts.nodes.some(n=>n.placement.kind==='unplaced'||n.placement.kind==='placed'&&n.placement.perDevice.some(d=>d.outcome.status==='unavailable')))throw Error('所选模型仍缺少局部方程或物理分配，不能按设备数猜测成本');
    const value=(m:MetricValue)=>{if(m.status!=='available'||!Number.isSafeInteger(m.quantity.value))throw Error('预设的物理分配尚不完整或字节数溢出');return m.quantity.value;};
    const allocations=result.deviceAllocations.map(d=>({deviceId:d.deviceId,totalBytes:value(d.knownBytes),weightBytes:d.categoryBreakdown.find(c=>c.category==='weight')?.bytes,stateBytes:d.categoryBreakdown.find(c=>c.category==='state')?.bytes})).map(d=>({...d,weightBytes:d.weightBytes?value(d.weightBytes):0,stateBytes:d.stateBytes?value(d.stateBytes):0}));
    const warnings=[...new Set(result.diagnostics.filter(d=>d.severity!=='info').map(d=>d.code+' · '+d.message))];
    if(firstDecode)warnings.unshift('预览为第一个 Decode 步骤的布局和分配。正式分析按保存的步数逐步计算。');
    const preview:ParallelPresetPreview={version:'parallel-preset.1',presetId:preset.presetId,presetName:preset.name,sourceModel:scenario.model,sourceInputHash:await computeInputHash(scenario,assets),scenario:next,assets:calculationInput(next,assets).assets,deviceIds:request.scenario.deviceTopology.groups.find(g=>g.groupId===request.groupId)?.members??[],assignmentCount:plan.assignments.length,communicationCount:result.communications.length,communications:result.communications.map(c=>c.evaluation.definition),allocations,warnings};
    return ParallelPresetAttempt.parse({status:'available',preview});
}
