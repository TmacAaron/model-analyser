import { ParallelPresetTemplate, TensorId, type AssetDocument, type GraphTemplate, type ValueExpr } from '@model-analyser/contracts';
import { type AxisBinding, withLocalCost } from './local-cost-authoring.js';
import { bf16, Equations, ref, symbol } from './model-authoring.js';

const note = 'Contiguous query partitions keep global causal positions. Each request group gathers BF16 normalized latents and rotary keys before its replicated append. Each rank evaluates its query tile against the full key extent.';

export function deepSeekV3QueryEquations(parameters: AssetDocument['parameters']) {
  return new Equations('builtin:formula:deepseek-v3-pcp', [
    ...parameters,
    ...['QueryStart', 'KeyLength', 'FullQuery'].map(key => ({ key, name: key, type: 'integer' as const, unit: 'count' as const, min: key === 'QueryStart' ? 0 : 1 })),
  ], [{ kind: 'note', text: note }]);
}

export function deepSeekV3QueryCost(graph: GraphTemplate, nodeAxes: Readonly<Record<string, AxisBinding[]>>,
  equations: Equations, description: string, logicalAccesses?: Readonly<Record<string, readonly string[]>>) {
  const tensors = new Map(graph.tensors.map(row => [row.tensorId, row]));
  const axes = { ...nodeAxes };
  for (const node of graph.nodes) {
    if (node.body.kind !== 'opaque') continue;
    const input = node.body.inputs[0] ?? node.body.outputs[0];
    if (!input || !tensors.get(input.tensorId)?.shape.some(axis => axis.axisId === 'q' && axis.semantic === 'token')) {
      throw Error('Missing DeepSeek query axis ' + node.nodeId);
    }
    axes[node.nodeId] = [...axes[node.nodeId] ?? [], ['Q', input.tensorId, 'q']];
  }
  const authored = withLocalCost(graph, axes, description, logicalAccesses);
  function cost(expression: string, unit: 'operation' | 'ratio', bindings: Record<string, string>): ValueExpr {
    const value = equations.value(expression, unit);
    if (value.kind !== 'formula') throw Error('Expected a local query equation');
    return { ...value, call: { ...value.call, bindings: Object.fromEntries(
      Object.entries(value.call.bindings).map(([key, operand]) => [key, bindings[key] ? symbol(bindings[key]) : operand]),
    ) } };
  }
  const localShare = cost('Q / FullQuery', 'ratio', { Q: 'allocated_Q', FullQuery: 'Q' });
  for (const node of authored.nodes) {
    if (node.body.kind !== 'opaque' || !node.body.localCost) continue;
    const rule = node.body.localCost;
    const gathered = node.nodeId === 'kv-a-norm' ? 'latent-new' : node.nodeId === 'rope' ? 'k-rope-new' : undefined;
    if (gathered) {
      const write = rule.cost.memoryAccess.find(access => access.mode === 'write' && access.storageId === gathered);
      if (!write) throw Error('Missing gathered DeepSeek projection ' + gathered);
      write.logicalBytes = { kind: 'storage_allocation', passes: localShare };
    }
    if (!['qk', 'softmax', 'av'].includes(node.nodeId)) continue;
    const segment = rule.cost.compute[0];
    if (!segment) throw Error('Missing DeepSeek attention cost ' + node.nodeId);
    const tensorId = TensorId.parse(node.nodeId === 'av' ? 'probabilities' : 'scores');
    rule.bindings.push(
      { symbol: 'queryStart', source: { kind: 'tensor_slice', tensorId, axisId: 'q', edge: 'start' } },
      { symbol: 'keyLength', source: { kind: 'tensor_axis', tensorId, axisId: 's', basis: 'allocated' } },
    );
    const work = (pairs: string) => node.nodeId === 'softmax' ? '5 * B * NH * ' + pairs :
      '2 * B * NH * ' + pairs + ' * ' + (node.nodeId === 'qk' ? '(R + DR)' : 'R');
    segment.usefulOperations = cost(work('(Q * (C + QueryStart) + Q * (Q + 1) / 2)'), 'operation',
      { B: 'logical_B', NH: 'logical_NH', Q: 'logical_Q', QueryStart: 'queryStart' });
    segment.executedOperations = cost(work('(Q * KeyLength)'), 'operation',
      { B: 'allocated_B', NH: 'allocated_NH', Q: 'allocated_Q', KeyLength: 'keyLength' });
  }
  return authored;
}

export function deepSeekV3QueryPreset(modules: AssetDocument[], equations: Equations, network: ParallelPresetTemplate['networkDefaults']) {
  const gathers = [
    { tensorId: 'latent-new', producerNodeId: 'kv-a-norm', payloadBytes: equations.value('2 * B * Q * R', 'byte') },
    { tensorId: 'k-rope-new', producerNodeId: 'rope', payloadBytes: equations.value('2 * B * Q * DR', 'byte') },
  ].map(gather => ({ ...gather, consumerNodeIds: ['cache-update'], payloadDtype: bf16 }));
  return ParallelPresetTemplate.parse({
    presetId: 'pcp-queries', name: 'Prefill 查询分片', description: '均分查询 token，收集当前 KV 潜向量与位置键后更新每卡缓存。',
    strategy: 'query_sharded', phases: ['prefill'], requestBatchSharding: true, tensorShards: [], reductions: [],
    networkDefaults: network, queryParallel: { axisId: 'q', moduleGathers: modules.map(module => ({ module: ref(module), gathers })) },
    assumptions: [note],
  });
}
