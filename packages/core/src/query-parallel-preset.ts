import { AssetDocument, NodeId, type ParallelPresetRequest, type ParallelPresetTemplate,
  type ResolvedGraph, type Scenario, type TensorDistribution, type TensorId } from '@model-analyser/contracts';
import queryTile from '../../../assets/builtin/formula/parallel-query-gather-tile.json' with {type:'json'};

export const queryGatherTileFormula = AssetDocument.parse(queryTile);

/** Shard the current query axis; assemble new K/V just before the replicated append. */
export function materializeQueryParallelPreset(request: ParallelPresetRequest, preset: ParallelPresetTemplate,
  resolved: ResolvedGraph, degree: number): Scenario['parallelPlan'] {
  const { network, groupId, meshAxisId } = request, spec = preset.queryParallel;
  if (!spec || !network || degree < 2) throw Error('PCP 需要至少两张卡和阶段内通信参数');
  const graph = resolved.graph;
  if (graph.nodes.some(node => node.body.kind === 'collective')) throw Error('PCP 需要单独声明图内通信与查询分片的对应关系');
  if (request.scenario.workload.queryTokensPerRequest % degree !== 0) throw Error('Prefill 查询 token 数须能被 PCP 整除');
  const replicated: TensorDistribution = { kind: 'replicated', groupId };
  const sharded: TensorDistribution = { kind: 'sharded', groupId, axes: [{ tensorAxisId: spec.axisId, meshAxisId }], policy: { kind: 'even' } };
  const usesQuery = (shape: typeof graph.tensors[number]['shape']) => shape.some(axis => axis.axisId === spec.axisId && axis.semantic === 'token');
  const storages = new Map(graph.storages.map(storage => [storage.storageId, storage]));
  const tensors = new Map(graph.tensors.map(tensor => [tensor.tensorId, tensor]));
  const nodes = new Map(graph.nodes.map(node => [node.nodeId, node]));
  const frames = new Map(resolved.objectBindings.map(frame => [frame.nodeId, frame]));
  const cached = new Set(graph.states.flatMap(state => state.storageIds));
  const gathered = new Set<TensorId>();
  const tensorStorages = new Set(graph.tensors.map(tensor => tensor.storageId));
  const plan: Scenario['parallelPlan'] = { assignments: [], communications: [], assumptions: [
    preset.description, ...preset.assumptions,
    'Each rank uses its original contiguous query interval. Gathered current K/V uses a full backing buffer per rank. Ring traffic is calculated from the local tile; local communication HBM is outside the declared network cost.',
  ] };
  for (const rule of spec.moduleGathers) {
    const occurrences = resolved.containers.filter(row => row.asset.assetId === rule.module.assetId && row.asset.revision === rule.module.revision &&
      frames.has(row.nodeId));
    if (!occurrences.length) throw Error('未找到 PCP 层调用 '+rule.module.assetId);
    for (const occurrence of occurrences) for (const gather of rule.gathers) {
      const local = frames.get(occurrence.nodeId);
      const tensorId = local?.tensors.find(binding => binding.localTensorId === gather.tensorId)?.tensorId;
      const tensor = tensorId === undefined ? undefined : tensors.get(tensorId);
      const leaf = (id: NodeId) => NodeId.parse(occurrence.nodeId + '/' + encodeURIComponent(id));
      const producer = leaf(gather.producerNodeId), consumers = gather.consumerNodeIds.map(leaf);
      const writer = nodes.get(producer)?.body;
      if (!tensorId || !tensor || !usesQuery(tensor.shape) || gathered.has(tensorId) || writer?.kind !== 'opaque' ||
          !writer.outputs.some(port => port.tensorId === tensorId) || consumers.some(id => {
            const node = nodes.get(id)?.body;
            return node?.kind !== 'opaque' || !node.inputs.some(port => port.tensorId === tensorId);
          })) throw Error('无法定位 PCP 当前 K/V 的写入与缓存读取边界 '+occurrence.nodeId+'/'+gather.tensorId);
      const storage = storages.get(tensor.storageId);
      if (storage?.allocation.kind !== 'tensor' || storage.allocation.quantization || storage.category !== 'activation' ||
          tensor.dtype.category !== gather.payloadDtype.category || tensor.dtype.bits !== gather.payloadDtype.bits ||
          tensor.dtype.format !== gather.payloadDtype.format) throw Error('PCP 收集需要匹配的物化激活 '+tensorId);
      gathered.add(tensorId);
      // The producer writes a local view; the append consumes a full view of the same buffer.
      plan.assignments.push({ selector: { kind: 'nodes', nodeIds: consumers }, phases: preset.phases,
        tensorDistributions: [{ tensorId, distribution: replicated }], storageDistributions: [] });
      plan.communications.push({ operation: 'all_gather', groupId, source: { tensorId, distribution: sharded }, destination: { tensorId, distribution: replicated },
        payloadDtype: gather.payloadDtype,
        sendBytesPerMember: { kind: 'formula', call: { formula: { assetId: queryGatherTileFormula.assetId, revision: queryGatherTileFormula.revision, kind: 'formula' },
          bindings: { bytes: gather.payloadBytes, parts: { kind: 'literal', quantity: { value: degree, unit: 'count' } } } } },
        receiveBytesPerMember: gather.payloadBytes, algorithm: { name: 'Ring AllGather: local tile × (P-1)', trafficFactor: degree-1, startupRounds: degree-1 },
        timing: { kind: 'bandwidth_latency', bytePerSecond: network.bytesPerSecond, latencySeconds: network.latencySeconds },
        placement: { nodeId: NodeId.parse('$pcp-gather:'+tensorId), phases: preset.phases, afterNodeIds: [producer], beforeNodeIds: consumers }, temporaryStorageIds: [] });
    }
  }
  const storageDistributions = graph.storages.filter(storage => !tensorStorages.has(storage.storageId)).map(storage => ({
    storageId: storage.storageId, distribution: storage.allocation.kind === 'tensor' && usesQuery(storage.allocation.shape) && !cached.has(storage.storageId) ? sharded : replicated,
  }));
  for (const tensorId of gathered) {
    const storageId = tensors.get(tensorId)?.storageId;
    if (!storageId) throw Error('收集缓冲没有底层存储 '+tensorId);
    storageDistributions.push({ storageId, distribution: replicated });
  }
  plan.assignments.unshift({ selector: { kind: 'subtree', rootNodeId: NodeId.parse('$model') }, phases: preset.phases,
    tensorDistributions: graph.tensors.map(tensor => ({ tensorId: tensor.tensorId,
      distribution: usesQuery(tensor.shape) && !cached.has(tensor.storageId) ? sharded : replicated })), storageDistributions });
  return plan;
}
