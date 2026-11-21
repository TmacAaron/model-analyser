import { AssetDocument, NodeId, ParallelPresetTemplate, TensorId, type CostDefinition, type Shape, type ValueExpr } from '@model-analyser/contracts';
import { bf16, Equations, fp32, GraphAuthor, ref, symbol, vector } from './model-authoring.js';
import { withLocalCost } from './local-cost-authoring.js';

const note = 'Decode reserves contiguous equally sized MLA slots. Each request group merges FP32 score maxima, denominators and latent weighted sums. Each rank scans its reserved slots, masks unused entries and appends the current latent and rotary key only if it owns the slot. The weighted-value multiply rounds unnormalized weights to BF16.';

export function makeDeepSeekDecodeContext(modules: AssetDocument[]) {
  const base = modules[0];
  if (!base) throw Error('Missing DeepSeek decoder modules');
  const equations = new Equations('builtin:formula:deepseek-v3-dcp', [...base.parameters, ...['SlotStart', 'SlotEnd', 'Slots'].map(key => ({
    key, name: key, type: 'integer' as const, unit: 'count' as const, min: key === 'Slots' ? 1 : 0,
  }))], [{ kind: 'note', text: note }]);
  const latent = TensorId.parse('cache-latent'), rotary = TensorId.parse('cache-rope');
  const inputIds = ['q-absorbed', 'q-rope', latent, rotary];
  const outgoing = 'latent-attended';
  const live = 'min(Slots, max(0, C + Q - SlotStart))';
  function localFormula(expression: string, unit: 'operation' | 'ratio', batch: 'logical_B' | 'allocated_B'): ValueExpr {
    const formula = equations.value(expression, unit);
    if (formula.kind !== 'formula') throw Error('Expected a DCP equation');
    return Object.hasOwn(formula.call.bindings, 'B') ?
      { ...formula, call: { ...formula.call, bindings: { ...formula.call.bindings, B: symbol(batch) } } } : formula;
  }
  const slices = [
    { symbol: 'SlotStart', source: { kind: 'tensor_slice' as const, tensorId: latent, axisId: 's', edge: 'start' as const } },
    { symbol: 'Slots', source: { kind: 'tensor_axis' as const, tensorId: latent, axisId: 's', basis: 'allocated' as const } },
  ];
  const result = modules.map(module => {
    if (module.definition.kind !== 'module') throw Error('Expected a DeepSeek decoder module');
    const graph = structuredClone(module.definition.graph);
    for (const id of [latent, rotary]) {
      const tensor = graph.tensors.find(row => row.tensorId === id);
      const storage = graph.storages.find(row => row.storageId === tensor?.storageId)?.allocation;
      const axis = tensor?.shape.find(row => row.axisId === 's');
      const backingAxis = storage?.kind === 'tensor' ? storage.shape.find(row => row.axisId === 's') : undefined;
      if (!axis || !backingAxis) throw Error('Missing MLA token axis ' + id);
      axis.size = backingAxis.size = symbol('M');
    }
    const state = graph.states.find(row => row.stateKind === 'latent');
    if (state?.updatePolicy.kind !== 'append') throw Error('Missing MLA state');
    state.updatePolicy.fixedCapacity = symbol('M');
    state.readers = state.readers.map(reader => reader.nodeId === 'av' ?
      { ...reader, nodeId: NodeId.parse('weighted-values') } : reader);
    const writer = graph.nodes.find(node => node.nodeId === 'cache-update')?.body;
    if (writer?.kind !== 'opaque' || !writer.localCost) throw Error('Missing MLA cache append');
    writer.localCost.bindings.push(...slices,
      { symbol: 'SlotEnd', source: { kind: 'tensor_slice', tensorId: latent, axisId: 's', edge: 'end' } });
    for (const access of writer.localCost.cost.memoryAccess) {
      const share = access.mode === 'write' ? 'Q / Slots' : '1';
      access.logicalBytes = { kind: 'storage_allocation',
        passes: localFormula('if(C >= SlotStart, if(C < SlotEnd, ' + share + ', 0), 0)', 'ratio', 'allocated_B') };
    }

    const attention = new GraphAuthor(equations);
    for (const id of inputIds) {
      const tensor = graph.tensors.find(row => row.tensorId === id);
      if (!tensor) throw Error('Missing MLA input ' + id);
      attention.graph.tensors.push(tensor);
      attention.input(id);
    }
    type Axis = [string, Shape[number]['semantic'], string];
    const heads: Axis[] = [['b', 'batch', 'B'], ['q', 'token', 'Q'], ['head', 'head', 'NH']];
    const scores: Axis[] = [...heads, ['s', 'token', 'M']];
    const values: Axis[] = [...heads, ['d', 'hidden', 'R']];
    for (const id of ['scores', 'weights']) attention.tensor(id, scores, { dtype: fp32 });
    attention.tensor('weights-bf16', scores, { dtype: bf16 });
    for (const id of ['dcp-max', 'dcp-denom']) attention.tensor(id, heads, { dtype: fp32 });
    attention.tensor('dcp-numerator', values, { dtype: fp32 });
    attention.tensor(outgoing, values);
    const head = 'B * Q * NH';
    const matrix = (n: string, width: string) => `2 * ${head} * (${n}) * ${width}`;
    const reduce = (n: string) => `${head} * max((${n}) - 1, 0)`;
    const elementwise = (n: string) => `${head} * (${n})`;
    const counts = new Map<string, (extent: string) => string>();
    const work = (id: string, label: string, inputs: string[], output: string, count: (extent: string) => string,
      computeClass?: CostDefinition['compute'][number]['computeClass']) => {
      counts.set(id, count);
      attention.node(id, label, inputs, [output], { useful: count('C + Q'), executed: count('M'), ...(computeClass ? { computeClass } : {}) });
    };
    work('qk', 'Local latent and rotary score contractions', ['q-absorbed', 'q-rope', latent, rotary], 'scores', n => matrix(n, '(R + DR)'));
    work('local-max', 'Maximum valid local score (−∞ for an empty slice)', ['scores'], 'dcp-max', reduce, vector);
    work('shift-exp', 'Exponentiate the scaled difference from the global maximum', ['scores', 'dcp-max'], 'weights', n => '4 * ' + elementwise(n), vector);
    work('sum-exp', 'Local FP32 softmax denominator', ['weights'], 'dcp-denom', reduce, vector);
    work('cast-weights', 'Cast unnormalized weights to BF16', ['weights'], 'weights-bf16', elementwise, vector);
    work('weighted-values', 'Local weighted MLA latents with FP32 accumulation', ['weights-bf16', latent], 'dcp-numerator', n => matrix(n, 'R'));
    work('normalize', 'Normalize the global weighted latents', ['dcp-numerator', 'dcp-denom'], outgoing, () => head + ' * R', vector);
    const local = withLocalCost(attention.graph, {}, note);
    for (const node of local.nodes) {
      if (node.body.kind !== 'opaque' || !node.body.localCost) throw Error('Missing local MLA node ' + node.nodeId);
      const count = counts.get(node.nodeId), segment = node.body.localCost.cost.compute[0];
      if (!count || !segment) throw Error('Missing local MLA operation count ' + node.nodeId);
      if (node.nodeId !== 'normalize') node.body.localCost.bindings.push(...slices);
      segment.usefulOperations = localFormula(count(live), 'operation', 'logical_B');
      segment.executedOperations = localFormula(count('Slots'), 'operation', 'allocated_B');
    }
    const replaced = new Set(['qk', 'softmax', 'av']);
    const retired = new Set(['scores', 'probabilities', 'softmax-scratch']);
    const producers = new Map(graph.edges.filter(edge => inputIds.includes(edge.tensorId)).map(edge => [edge.tensorId, edge.from]));
    graph.nodes = [...graph.nodes.filter(node => !replaced.has(node.nodeId)), ...local.nodes];
    graph.tensors = [...graph.tensors.filter(tensor => !retired.has(tensor.tensorId)),
      ...local.tensors.filter(tensor => !inputIds.includes(tensor.tensorId) && tensor.tensorId !== outgoing)];
    graph.storages = [...graph.storages.filter(storage => !retired.has(storage.storageId)), ...local.storages.filter(storage => storage.storageId !== outgoing)];
    graph.edges = [
      ...graph.edges.filter(edge => edge.to.kind !== 'node' || !replaced.has(edge.to.nodeId)).map(edge =>
        edge.from.kind === 'node' && edge.from.nodeId === 'av' ? { ...edge, from: { ...edge.from, nodeId: NodeId.parse('normalize') } } : edge),
      ...local.edges.map(edge => {
        if (edge.from.kind !== 'graph_input') return edge;
        const from = producers.get(edge.tensorId);
        if (!from) throw Error('Missing MLA input edge ' + edge.tensorId);
        return { ...edge, from };
      }),
    ];
    return AssetDocument.parse({ ...module, assetId: module.assetId.replace('-absorbed-', '-dcp-'), revision: 1,
      name: module.name + ' · Decode KV 分片', sources: [...module.sources, ...equations.sources], definition: { kind: 'module', graph } });
  });
  const tile = equations.value('4 * B * Q * NH', 'byte');
  const reductions = [
    { tensorId: 'dcp-max', producerNodeId: 'local-max', consumerNodeIds: ['shift-exp'], operation: 'max', payloadBytes: tile },
    { tensorId: 'dcp-denom', producerNodeId: 'sum-exp', consumerNodeIds: ['normalize'], operation: 'sum', payloadBytes: tile },
    { tensorId: 'dcp-numerator', producerNodeId: 'weighted-values', consumerNodeIds: ['normalize'], operation: 'sum', payloadBytes: equations.value('4 * B * Q * NH * R', 'byte') },
  ].map(rule => ({ ...rule, payloadDtype: fp32 }));
  const preset = ParallelPresetTemplate.parse({
    presetId: 'dcp-kv', name: 'Decode KV 分片', description: '均分 MLA 的固定 KV 槽位，并合并各卡的注意力结果。',
    strategy: 'decode_context_sharded', phases: ['decode'], requestBatchSharding: true, tensorShards: [], reductions: [],
    networkDefaults: { scope: 'intra_group', bytesPerSecond: 100e9, latencySeconds: 3e-6, description: 'Editable reference link for attention AllReduce.' },
    decodeContext: { replacements: result.map((replacement, index) => {
      const module = modules[index];
      if (!module) throw Error('Missing source decoder module');
      return { module: ref(module), replacement: ref(replacement) };
    }) },
    moduleRules: result.map(module => ({ module: ref(module), reductions,
      tensorShards: [latent, rotary, 'scores', 'weights', 'weights-bf16'].map(tensorId => ({ tensorId, axisId: 's' })) })),
    assumptions: [note],
  });
  return { preset, assets: [...result, ...equations.assets] };
}
