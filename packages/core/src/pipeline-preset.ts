import { DeviceId, NodeId, type ParallelPresetRequest, type ParallelPresetTemplate, type Quantity,
  type ResolvedGraph, type Scenario, type Shape, type StorageId, type TensorDistribution, type TensorId } from '@model-analyser/contracts';
import { materializeDeclaredPreset } from './declared-parallel-preset.js';
import { parallelObjectUses } from './parallel-object-uses.js';
import { numericValue } from './storage.js';
import { payloadPerReplica, soleBatchAxis } from './request-replica.js';
import { ringPresetReduction } from './preset-reduction.js';
import { canonical } from '../../contracts/src/validation.js';

const requestAxis = 'request';
const tensorAxis = 'tp';
export const pipelineTensorMeshAxis = '$pipeline-tp';

/** Balance consecutive chain occurrences and materialize the declared local layout of each stage. */
export function materializePipelinePreset(request: ParallelPresetRequest, preset: ParallelPresetTemplate, resolved: ResolvedGraph,
  attention?: Pick<ParallelPresetTemplate,'tensorShards'|'reductions'>) {
  const declaration = preset.pipeline;
  const network = request.network;
  const replicas = request.requestDp ?? 1;
  const lanes = request.pipelineTp ?? 1;
  const poolSize = request.scenario.deviceTopology.groups.find(group => group.groupId === request.groupId)?.members.length ?? 0;
  const stageCount = poolSize / (replicas*lanes);
  if (!declaration || !Number.isInteger(stageCount) || stageCount < 2) throw Error('流水线布局需要每个请求组至少两个实际设备');
  if (!network) throw Error('请为阶段间传输指定通信带宽和延迟');
  if (resolved.graph.nodes.some(node => node.body.kind === 'collective')) throw Error('流水线层链需要单独声明已有图内通信的阶段放置');
  const chain = resolved.containers.filter(container => {
    const id = container.nodeId;
    return id.startsWith(declaration.chainNodeId) && /^\[\d+\]$/.test(id.slice(declaration.chainNodeId.length));
  });
  if (chain.length < stageCount) throw Error('流水线阶段数不能超过展开的层链块数 '+chain.length);
  const stageByNode = new Map<NodeId, number>(), chainNodes = new Set(chain.flatMap(row => row.leafNodeIds));
  const nodes = resolved.graph.nodes;
  const first = nodes.findIndex(node => chainNodes.has(node.nodeId)), last = nodes.findLastIndex(node => chainNodes.has(node.nodeId));
  const width = Math.floor(chain.length / stageCount), remainder = chain.length % stageCount;
  const layerCounts = Array.from({ length: stageCount }, (_, i) => width + Number(i < remainder));
  let cursor = 0;
  for (const [stage, layers] of layerCounts.entries()) {
    for (const row of chain.slice(cursor, cursor + layers)) for (const nodeId of row.leafNodeIds) stageByNode.set(nodeId, stage);
    cursor += layers;
  }
  for (const [index, node] of nodes.entries()) {
    if (index < first) stageByNode.set(node.nodeId, 0);
    else if (index > last) stageByNode.set(node.nodeId, stageCount - 1);
    else if (!stageByNode.has(node.nodeId)) throw Error('层链内部存在未归属的计算节点 '+node.nodeId);
  }

  const deviceSlots = Array.from({ length: replicas }, (_, replica) => layerCounts.flatMap((_, stage) =>
    Array.from({ length: lanes }, (_, lane) => DeviceId.parse((request.requestDp ? 'replica-'+replica+'-' : '')+
      'stage-device-'+stage+(request.pipelineTp?'-tp-'+lane:''))),
  )).flat();
  function stageDevice(replica: number, stage: number, lane=0) {
    const device = deviceSlots[(replica*stageCount+stage)*lanes+lane];
    if (!device) throw Error('流水线缺少请求组的阶段设备');
    return device;
  }
  const groups: NonNullable<ParallelPresetTemplate['declaredPlan']>['groups'] = [];
  const groupFor = (stages: Iterable<number>) => {
    const indices = [...new Set(stages)].sort((a, b) => a - b);
    if (!indices.length || indices.some(index => index < 0 || index >= stageCount)) throw Error('流水线设备组没有完整的阶段归属');
    const groupId = 'stages:' + indices.map(index => index + 1).join('-');
    if (groups.some(group => group.groupId === groupId)) return groupId;
    const members = Array.from({ length: replicas }, (_, replica) =>
      indices.flatMap(stage => Array.from({ length: lanes }, (_, lane) => stageDevice(replica, stage, lane)))).flat();
    groups.push({ groupId, members, ...(request.requestDp||request.pipelineTp ? { mesh: {
      axes: [...(request.requestDp?[{ axisId: requestAxis, size: replicas }]:[]),
        ...(indices.length > 1 ? [{ axisId: 'stage', size: indices.length }] : []),
        ...(request.pipelineTp?[{axisId:tensorAxis,size:lanes}]:[])],
      coordinates: members.map((deviceId, index) => ({ deviceId, coordinates: [
        ...(request.requestDp?[Math.floor(index/(indices.length*lanes))]:[]),
        ...(indices.length > 1 ? [Math.floor(index/lanes)%indices.length] : []),
        ...(request.pipelineTp?[index%lanes]:[]),
      ] })),
    } } : {}) });
    return groupId;
  };
  function distribution(groupId: string, shape: Shape, shard?:string): TensorDistribution {
    const batch = request.requestDp ? soleBatchAxis(shape) : undefined;
    if (batch&&(batch.size.kind!=='literal'||batch.size.quantity.value%replicas!==0)) throw Error('流水线请求轴无法均分');
    if (shard === batch?.axisId && shard) throw Error('流水线请求轴与 Attention TP 分片轴重复');
    const axes=[...(batch?[{tensorAxisId:batch.axisId,meshAxisId:requestAxis}]:[]),
      ...(shard?[{tensorAxisId:shard,meshAxisId:tensorAxis}]:[])];
    return axes.length?{kind:'sharded',groupId,axes,policy:{kind:'even'}}:{kind:'replicated',groupId};
  }
  const stageTensors = layerCounts.map(() => new Map<TensorId, Shape>());
  const storageStages = new Map<StorageId, Set<number>>();
  const storages = new Map(resolved.graph.storages.map(storage => [storage.storageId, storage]));
  const tensors = new Map(resolved.graph.tensors.map(tensor => [tensor.tensorId, tensor]));
  const frames = new Map(resolved.objectBindings.map(frame => [frame.nodeId, frame]));
  function backing(id: StorageId, visited = new Set<StorageId>()): ResolvedGraph['graph']['storages'][number] {
    const storage = storages.get(id);
    if (!storage || visited.has(id)) throw Error('流水线缺少唯一存储 '+id);
    if (storage.allocation.kind === 'alias') {
      visited.add(id);
      return backing(storage.allocation.targetStorageId,visited);
    }
    return storage;
  }
  const tensorShards=new Map<TensorId,string>(),storageShards=new Map<StorageId,string>();
  for(const rule of attention?.tensorShards??[]){
    const tensor=tensors.get(rule.tensorId),axis=tensor?.shape.find(row=>row.axisId===rule.axisId);
    if(!tensor||rule.policy||tensorShards.has(rule.tensorId)||axis?.size.kind!=='literal'||axis.size.quantity.value%lanes!==0){
      throw Error('阶段内 Attention TP 分片要求 '+rule.tensorId+'.'+rule.axisId+' 可均分到 '+lanes+' 张卡');
    }
    const storage=backing(tensor.storageId),existing=storageShards.get(storage.storageId);
    if(storage.allocation.kind!=='tensor'||canonical(storage.allocation.shape)!==canonical(tensor.shape)||existing&&existing!==rule.axisId){
      throw Error('流水线 Attention TP 张量与底层分片轴不一致 '+rule.tensorId);
    }
    tensorShards.set(rule.tensorId,rule.axisId);storageShards.set(storage.storageId,rule.axisId);
  }
  const reductions=new Map<TensorId,ParallelPresetTemplate['reductions'][number]>();
  for(const rule of attention?.reductions??[]){
    const source=nodes.find(row=>row.nodeId===rule.producerNodeId);
    const stage=stageByNode.get(rule.producerNodeId);
    if(reductions.has(rule.tensorId)||tensorShards.has(rule.tensorId)||source?.body.kind!=='opaque'||
       !source.body.outputs.some(port=>port.tensorId===rule.tensorId)||stage===undefined||
       rule.consumerNodeIds.some(id=>stageByNode.get(id)!==stage)){
      throw Error('Attention 归约须在同一流水线阶段完成 '+rule.tensorId);
    }
    reductions.set(rule.tensorId,rule);
  }
  const reductionReaders=new Map<TensorId,NodeId[]>();
  function recordStorage(id: StorageId, stage: number) {
    const storage=backing(id);id=storage.storageId;
    const owners = storageStages.get(id) ?? new Set<number>();
    owners.add(stage);
    if (owners.size > 1 && storage.category === 'state') throw Error('跨阶段共享的持久状态需要独立归属声明：'+id);
    storageStages.set(id, owners);
  }
  for (const node of nodes) {
    const stage = stageByNode.get(node.nodeId), uses = parallelObjectUses(node, frames.get(node.nodeId));
    const usedTensors = stage === undefined ? undefined : stageTensors[stage];
    if (stage === undefined || !usedTensors) throw Error('计算节点缺少流水线阶段 '+node.nodeId);
    for (const tensorId of uses.tensors) {
      const tensor = tensors.get(tensorId);
      if (!tensor) throw Error('流水线张量缺失 '+tensorId);
      usedTensors.set(tensorId, tensor.shape);
      recordStorage(tensor.storageId, stage);
      const reduction=reductions.get(tensorId);
      if(reduction&&reduction.producerNodeId!==node.nodeId){
        if(stageByNode.get(reduction.producerNodeId)!==stage)throw Error('归约结果应在本阶段合并 '+tensorId);
        const readers=reductionReaders.get(tensorId);
        if(readers)readers.push(node.nodeId);else reductionReaders.set(tensorId,[node.nodeId]);
      }
    }
    for (const storageId of uses.storages) recordStorage(storageId, stage);
  }
  const stageNodes = layerCounts.map((_,stage)=>nodes.filter(node=>stageByNode.get(node.nodeId)===stage).map(node=>node.nodeId));
  const assignments: Scenario['parallelPlan']['assignments'] = stageTensors.map((used, stage) => ({
    selector: { kind: 'nodes', nodeIds: stageNodes[stage]??[] },
    phases: preset.phases, tensorDistributions: [...used].filter(([tensorId])=>!reductions.has(tensorId)).map(([tensorId, shape]) => ({
      tensorId, distribution: distribution(groupFor([stage]), shape, tensorShards.get(tensorId)),
    })), storageDistributions: [],
  }));
  assignments.push({ selector: { kind: 'subtree', rootNodeId: NodeId.parse('$model') }, phases: preset.phases,
    tensorDistributions: [], storageDistributions: [...storageStages].map(([storageId, stages]) => {
      const allocation = storages.get(storageId)?.allocation;
      return { storageId, distribution: distribution(groupFor(stages), allocation?.kind === 'tensor' ? allocation.shape : [],storageShards.get(storageId)) };
    }) });

  const transfers = new Map<string, { tensorId: TensorId; from: number; to: number; producer: NodeId; consumers: Set<NodeId> }>();
  for (const { from, to, tensorId } of resolved.graph.edges) {
    if (from.kind !== 'node' || to.kind !== 'node') continue;
    const sender = stageByNode.get(from.nodeId), receiver = stageByNode.get(to.nodeId);
    if (sender === undefined || receiver === undefined || sender > receiver) throw Error('流水线层链出现无法按阶段执行的数据边界 '+tensorId);
    if (sender === receiver) continue;
    const key = JSON.stringify([tensorId, sender, receiver]);
    const transfer = transfers.get(key) ?? { tensorId, from: sender, to: receiver, producer: from.nodeId, consumers: new Set<NodeId>() };
    if (transfer.producer !== from.nodeId) throw Error('跨阶段张量存在多处写入 '+tensorId);
    transfer.consumers.add(to.nodeId);
    transfers.set(key, transfer);
  }
  if (!transfers.size) throw Error('层链没有跨阶段数据边界');
  const symbols: Record<string, Quantity> = {};
  for (const [key, value] of Object.entries(request.scenario.workload)) if (typeof value === 'number') symbols[key] = { value, unit: 'count' };
  for (const parameter of resolved.parameters) if (parameter.nodeId === '$model' &&
    (parameter.value.kind === 'number' || parameter.value.kind === 'integer')) symbols[parameter.parameterKey] = { value: parameter.value.value, unit: parameter.unit };
  const context = { symbols, assets: request.assets };
  const payload = numericValue(declaration.payloadBytes, 'byte', context, true);
  const communications: Scenario['parallelPlan']['communications'] = [...transfers.values()].map(({ tensorId, from, to, producer, consumers }) => {
    const tensor = tensors.get(tensorId);
    if (!tensor || tensor.dtype.format !== declaration.payloadDtype.format ||
        tensor.dtype.bits !== declaration.payloadDtype.bits || tensor.dtype.category !== declaration.payloadDtype.category ||
        Math.ceil(tensor.shape.reduce((elements, axis) => elements * numericValue(axis.size, 'count', context, true), 1) * tensor.dtype.bits / 8) !== payload) {
      throw Error('跨阶段张量与声明的完整激活消息不符 '+tensorId);
    }
    if (request.requestDp && !soleBatchAxis(tensor.shape)) throw Error('流水线激活缺少可保留的请求轴 '+tensorId);
    if (tensorShards.has(tensorId)||reductions.has(tensorId)) throw Error('阶段传输需要已汇合的完整隐藏激活 '+tensorId);
    const payloadBytes = request.requestDp ? payloadPerReplica(declaration.payloadBytes, replicas) : declaration.payloadBytes;
    const paired=request.requestDp||request.pipelineTp;
    const peers = paired ? { peerPairs: Array.from({ length: replicas }, (_, replica) => Array.from({length:lanes},(_,lane)=>({
      sourceDeviceId: stageDevice(replica, from,lane), destinationDeviceId: stageDevice(replica, to,lane),
    }))).flat() } : { sourceDeviceId: stageDevice(0, from), destinationDeviceId: stageDevice(0, to) };
    return { operation: 'send_recv', groupId: groupFor([from, to]), ...peers,
      source: { tensorId, distribution: distribution(groupFor([from]), tensor.shape) },
      destination: { tensorId, distribution: distribution(groupFor([to]), tensor.shape) },
      payloadDtype: declaration.payloadDtype, sendBytesPerMember: payloadBytes, receiveBytesPerMember: payloadBytes,
      algorithm: { name: request.pipelineTp?'Concurrent replicated activation transfers between matching TP ranks':
        request.requestDp ? 'Concurrent request-group activation transfers' : 'One full activation transfer', trafficFactor: 1, startupRounds: 1 },
      timing: { kind: 'bandwidth_latency', bytePerSecond: network.bytesPerSecond, latencySeconds: network.latencySeconds },
      placement: { nodeId: NodeId.parse('$pipeline-transfer:' + JSON.stringify([from, to, tensorId])), phases: preset.phases,
        afterNodeIds: [producer], beforeNodeIds: [...consumers] }, temporaryStorageIds: [] };
  });
  for(const rule of reductions.values()){
    const stage=stageByNode.get(rule.producerNodeId),tensor=tensors.get(rule.tensorId);
    const readers=reductionReaders.get(rule.tensorId);
    if(stage===undefined||!tensor||!readers?.length)throw Error('阶段内归约缺少布局 '+rule.tensorId);
    const target=distribution(groupFor([stage]),tensor.shape);
    const communication=ringPresetReduction(rule,target,preset.phases,lanes,network,request.requestDp?{degree:replicas,axisId:requestAxis}:undefined);
    communications.push(communication);
    assignments.push(
      {selector:{kind:'nodes',nodeIds:[rule.producerNodeId]},phases:preset.phases,
        tensorDistributions:[{tensorId:rule.tensorId,distribution:communication.source.distribution}],storageDistributions:[]},
      {selector:{kind:'nodes',nodeIds:readers},phases:preset.phases,
        tensorDistributions:[{tensorId:rule.tensorId,distribution:target}],storageDistributions:[]},
    );
  }
  const { pipeline, requestBatchSharding, ...declared } = preset;
  return materializeDeclaredPreset(request, { ...declared, strategy: 'declared_plan',
    declaredPlan: { deviceSlots, groups, plan: { assignments, communications, assumptions: [
      'Consecutive chain blocks by stage: '+layerCounts.join(', ')+'. Explicit tensor backing includes physical copies on the stages that use it.',
      ...(request.requestDp ? [`${replicas} independent request groups each use their own devices. Paired stage transfers preserve each batch slice and run concurrently at that boundary.`] : []),
      ...(request.pipelineTp ? [`Each stage uses ${lanes} Attention TP ranks. Stage-local collectives merge partial attention outputs. Replicated hidden activations travel on matching TP lanes between stages.`] : []),
    ] } } });
}
