import { AssetDocument, ParallelPresetTemplate, TensorId, type GraphTemplate, type ValueExpr } from '@model-analyser/contracts';
import { withLocalCost, type AxisBinding } from './local-cost-authoring.js';
import { bf16, Equations, ref, symbol } from './model-authoring.js';
import { qwenAttentionAxes } from './qwen-parallel-assets.js';

const note = 'Contiguous prefill query partitions retain global causal positions. Each layer gathers the complete current K/V before a replicated append. The local attention rectangle retains all available key positions.';

function bindQueryAxes(graph: GraphTemplate, description: string) {
  const axes: Record<string, AxisBinding[]> = { ...qwenAttentionAxes };
  for (const node of graph.nodes) {
    if (node.body.kind !== 'opaque') continue;
    const input = node.body.inputs[0] ?? node.body.outputs[0];
    if (!input || !graph.tensors.find(tensor => tensor.tensorId === input.tensorId)?.shape.some(axis => axis.axisId === 'q' && axis.semantic === 'token')) {
      throw Error('Missing Qwen query operand ' + node.nodeId);
    }
    axes[node.nodeId] = [...axes[node.nodeId] ?? [], ['Q', input.tensorId, 'q']];
  }
  return withLocalCost(graph, axes, description);
}

export function addQwenContextPreset(decoder: AssetDocument, models: AssetDocument[]) {
  if (decoder.definition.kind !== 'module') throw Error('Expected the dense Qwen decoder');
  const sources = [...decoder.sources, { kind: 'note' as const, text: note }];
  const equations = new Equations('builtin:formula:qwen-pcp', [...decoder.parameters, ...['QueryStart', 'KeyLength', 'FullQuery'].map(key => ({
    key, name: key, type: 'integer' as const, unit: 'count' as const, min: key === 'FullQuery' ? 1 : 0,
  }))], sources);
  function localFormula(expression: string, unit: 'operation' | 'ratio', names: Record<string, string>): ValueExpr {
    const value = equations.value(expression, unit);
    if (value.kind !== 'formula') return value;
    return { ...value, call: { ...value.call, bindings: Object.fromEntries(Object.entries(value.call.bindings)
      .map(([name, binding]) => [name, names[name] ? symbol(names[name]) : binding])) } };
  }
  const graph = bindQueryAxes(decoder.definition.graph, note);
  const fullTile = '2 * B * Q * NK * D';
  const payloadBytes = equations.value(fullTile, 'byte');
  const localTileShare = localFormula('Q / FullQuery', 'ratio', { Q: 'allocated_Q', FullQuery: 'Q' });
  for (const node of graph.nodes) {
    if (node.body.kind !== 'opaque' || !node.body.localCost) continue;
    const rule = node.body.localCost;
    if (node.nodeId === 'qkv' || node.nodeId === 'qk-norm-rope') {
      const output = node.nodeId === 'qkv' ? 'v-new' : 'k-new';
      const access = rule.cost.memoryAccess.find(row => row.mode === 'write' && row.storageId === output);
      if (!access) throw Error('Missing local K/V tile write ' + output);
      access.logicalBytes = { kind: 'storage_allocation', passes: localTileShare };
    }
    if (node.nodeId !== 'qk' && node.nodeId !== 'softmax' && node.nodeId !== 'av') continue;
    const value = rule.cost.compute[0];
    if (!value) throw Error('Missing attention work ' + node.nodeId);
    const scores = TensorId.parse(node.nodeId === 'av' ? 'probabilities' : 'scores');
    rule.bindings.push(
      { symbol: 'queryStart', source: { kind: 'tensor_slice', tensorId: scores, axisId: 'q', edge: 'start' } },
      { symbol: 'keyLength', source: { kind: 'tensor_axis', tensorId: scores, axisId: 's', basis: 'allocated' } },
    );
    const mask = '(Q * (C + QueryStart) + Q * (Q + 1) / 2)', softmax = node.nodeId === 'softmax';
    const elements = (pairs: string) => softmax ? '5 * B * NH * ' + pairs : '2 * B * NH * ' + pairs + ' * D';
    value.usefulOperations = localFormula(elements(mask), 'operation', { B: 'logical_B', NH: 'logical_NH', Q: 'logical_Q', QueryStart: 'queryStart' });
    value.executedOperations = localFormula(elements('Q * KeyLength'), 'operation', { B: 'allocated_B', NH: 'allocated_NH', Q: 'allocated_Q', KeyLength: 'keyLength' });
  }
  const module = AssetDocument.parse({ ...decoder, revision: decoder.revision + 1, sources, definition: { kind: 'module', graph } });
  const preset = ParallelPresetTemplate.parse({
    presetId: 'pcp-queries', name: 'Prefill 查询分片', description: '均分查询 token，合并当前 K/V 后更新每卡缓存。',
    strategy: 'query_sharded', phases: ['prefill'], tensorShards: [], reductions: [],
    networkDefaults: { scope: 'intra_group', bytesPerSecond: 100e9, latencySeconds: 3e-6, description: 'Editable reference link for K/V AllGather.' },
    queryParallel: { axisId: 'q', moduleGathers: [{ module: ref(module), gathers: [
      { tensorId: 'k-new', producerNodeId: 'qk-norm-rope' }, { tensorId: 'v-new', producerNodeId: 'qkv' },
    ].map(gather => ({ ...gather, consumerNodeIds: ['cache-update'], payloadBytes, payloadDtype: bf16 })) }] },
    assumptions: [note],
  });
  const roots = models.map(model => {
    if (model.definition.kind !== 'model') throw Error('Expected a Qwen root model');
    const graph = bindQueryAxes(model.definition.graph, note);
    graph.nodes = graph.nodes.map(node => node.body.kind === 'module' && node.body.asset.assetId === module.assetId ?
      { ...node, body: { ...node.body, asset: ref(module) } } : node);
    const parallelPresets = (model.parallelPresets ?? []).map(item => ({ ...item, ...(item.moduleRules ? {
      moduleRules: item.moduleRules.map(rule => rule.module.assetId === module.assetId ? { ...rule, module: ref(module) } : rule),
    } : {}) }));
    return AssetDocument.parse({ ...model, revision: model.revision + 1,
      definition: { ...model.definition, graph }, parallelPresets: [...parallelPresets, preset] });
  });
  return [...roots, module, ...equations.assets];
}
