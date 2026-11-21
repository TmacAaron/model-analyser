import { DeviceId, NodeId, type ParallelPresetRequest, type ParallelPresetTemplate, type Quantity,
  type ResolvedGraph, type Scenario, type StorageId, type TensorDistribution, type TensorId } from '@model-analyser/contracts';
import { materializeDeclaredPreset } from './declared-parallel-preset.js';
import { parallelObjectUses } from './parallel-object-uses.js';
import { numericValue } from './storage.js';

/** Balance consecutive expanded chain occurrences, with one physical device per stage. */
export function materializePipelinePreset(request: ParallelPresetRequest, preset: ParallelPresetTemplate, resolved: ResolvedGraph) {
  const declaration = preset.pipeline;
  const network = request.network;
  const stageCount = request.scenario.deviceTopology.groups.find(group => group.groupId === request.groupId)?.members.length ?? 0;
  if (!declaration || stageCount < 2) throw Error('流水线布局至少需要两个实际设备');
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

  const deviceSlots = layerCounts.map((_, stage) => DeviceId.parse('stage-device-' + stage));
  const groups: NonNullable<ParallelPresetTemplate['declaredPlan']>['groups'] = [];
  const groupFor = (stages: Iterable<number>) => {
    const indices = [...new Set(stages)].sort((a, b) => a - b);
    const members = indices.map(index => deviceSlots[index]);
    if (!members.length || members.some(deviceId => deviceId === undefined)) throw Error('流水线设备组没有完整的阶段归属');
    const groupId = 'stages:' + indices.map(index => index + 1).join('-');
    if (!groups.some(group => group.groupId === groupId)) groups.push({ groupId, members: members.filter(deviceId => deviceId !== undefined) });
    return groupId;
  };
  const replicated = (groupId: string): TensorDistribution => ({ kind: 'replicated', groupId });
  const stageTensors = layerCounts.map(() => new Set<TensorId>());
  const storageStages = new Map<StorageId, Set<number>>();
  const storages = new Map(resolved.graph.storages.map(storage => [storage.storageId, storage]));
  const tensors = new Map(resolved.graph.tensors.map(tensor => [tensor.tensorId, tensor]));
  const frames = new Map(resolved.objectBindings.map(frame => [frame.nodeId, frame]));
  function recordStorage(id: StorageId, stage: number, visited = new Set<StorageId>()) {
    const storage = storages.get(id);
    if (!storage || visited.has(id)) throw Error('流水线缺少唯一存储 '+id);
    if (storage.allocation.kind === 'alias') {
      visited.add(id);
      recordStorage(storage.allocation.targetStorageId, stage, visited);
      return;
    }
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
      usedTensors.add(tensorId);
      recordStorage(tensor.storageId, stage);
    }
    for (const storageId of uses.storages) recordStorage(storageId, stage);
  }
  const assignments: Scenario['parallelPlan']['assignments'] = stageTensors.map((used, stage) => ({
    selector: { kind: 'nodes', nodeIds: nodes.filter(node => stageByNode.get(node.nodeId) === stage).map(node => node.nodeId) },
    phases: preset.phases, tensorDistributions: [...used].map(tensorId => ({ tensorId, distribution: replicated(groupFor([stage])) })), storageDistributions: [],
  }));
  assignments.push({ selector: { kind: 'subtree', rootNodeId: NodeId.parse('$model') }, phases: preset.phases,
    tensorDistributions: [], storageDistributions: [...storageStages].map(([storageId, stages]) => ({ storageId, distribution: replicated(groupFor(stages)) })) });

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
    const tensor = tensors.get(tensorId), sourceDeviceId = deviceSlots[from], destinationDeviceId = deviceSlots[to];
    if (!tensor || !sourceDeviceId || !destinationDeviceId || tensor.dtype.format !== declaration.payloadDtype.format ||
        tensor.dtype.bits !== declaration.payloadDtype.bits || tensor.dtype.category !== declaration.payloadDtype.category ||
        Math.ceil(tensor.shape.reduce((elements, axis) => elements * numericValue(axis.size, 'count', context, true), 1) * tensor.dtype.bits / 8) !== payload) {
      throw Error('跨阶段张量与声明的完整激活消息不符 '+tensorId);
    }
    return { operation: 'send_recv', groupId: groupFor([from, to]), sourceDeviceId, destinationDeviceId,
      source: { tensorId, distribution: replicated(groupFor([from])) }, destination: { tensorId, distribution: replicated(groupFor([to])) },
      payloadDtype: declaration.payloadDtype, sendBytesPerMember: declaration.payloadBytes, receiveBytesPerMember: declaration.payloadBytes,
      algorithm: { name: 'One full activation transfer', trafficFactor: 1, startupRounds: 1 },
      timing: { kind: 'bandwidth_latency', bytePerSecond: network.bytesPerSecond, latencySeconds: network.latencySeconds },
      placement: { nodeId: NodeId.parse('$pipeline-transfer:' + JSON.stringify([from, to, tensorId])), phases: preset.phases,
        afterNodeIds: [producer], beforeNodeIds: [...consumers] }, temporaryStorageIds: [] };
  });
  const { pipeline, ...declared } = preset;
  return materializeDeclaredPreset(request, { ...declared, strategy: 'declared_plan',
    declaredPlan: { deviceSlots, groups, plan: { assignments, communications, assumptions: [
      'Consecutive chain blocks by stage: '+layerCounts.join(', ')+'. Explicit tensor backing includes physical copies on the stages that use it.',
    ] } } });
}
