import { AssetDocument, LocalCostRule, NodeId, ParallelPresetTemplate, TensorId, type Shape, type ValueExpr } from '@model-analyser/contracts';
import { bf16, Equations, fp32, GraphAuthor, ref, symbol, vector } from './model-authoring.js';

const note = 'Decode uses one query per request and contiguous, equally sized KV slots. All ranks project the same token; the slot owner appends its K/V. FP32 max, denominator and weighted-value reductions merge the attention across ranks. The BF16 value matmul uses rounded unnormalized weights. This materialized reference scans the reserved slots and masks unused entries.';

export function addQwenDecodeContextPreset(decoder: AssetDocument, models: AssetDocument[]) {
  if (decoder.definition.kind !== 'module') throw Error('Expected the dense Qwen decoder');
  const graph = structuredClone(decoder.definition.graph);
  const sources = [...decoder.sources, { kind: 'note' as const, text: note }];
  const eq = new Equations('builtin:formula:qwen-dcp', [...decoder.parameters, ...['SlotStart', 'SlotEnd', 'Slots'].map(key => ({
    key, name: key, type: 'integer' as const, unit: 'count' as const, min: key === 'Slots' ? 1 : 0,
  }))], sources);
  for (const id of ['cache-k', 'cache-v']) {
    const tensor = graph.tensors.find(row => row.tensorId === id);
    const storage = graph.storages.find(row => row.storageId === tensor?.storageId)?.allocation;
    const axis = tensor?.shape.find(row => row.axisId === 's');
    const backingAxis = storage?.kind === 'tensor' ? storage.shape.find(row => row.axisId === 's') : undefined;
    if (!axis || !backingAxis) throw Error('Missing Qwen cache token axis '+id);
    axis.size = backingAxis.size = symbol('M');
  }
  const cache = graph.states.find(state => state.stateKind === 'kv');
  if (cache?.updatePolicy.kind !== 'append') throw Error('Missing Qwen append cache');
  cache.updatePolicy.fixedCapacity = symbol('M');
  cache.readers = cache.readers.map(reader => reader.kind === 'node' && reader.nodeId === 'av' ?
    { ...reader, nodeId: NodeId.parse('weighted-values') } : reader);

  const cacheK = TensorId.parse('cache-k');
  const update = graph.nodes.find(node => node.nodeId === 'cache-update')?.body;
  if (update?.kind !== 'opaque' || !update.localCost) throw Error('Missing Qwen cache writer');
  update.localCost.bindings.push(
    { symbol: 'SlotStart', source: { kind: 'tensor_slice', tensorId: cacheK, axisId: 's', edge: 'start' } },
    { symbol: 'SlotEnd', source: { kind: 'tensor_slice', tensorId: cacheK, axisId: 's', edge: 'end' } },
  );
  const append = eq.value('if(C >= SlotStart, if(C < SlotEnd, 2 * B * Q * NK * D, 0), 0)', 'byte');
  for (const access of update.localCost.cost.memoryAccess) access.logicalBytes = append;

  const attention = new GraphAuthor(eq);
  const inputIds = ['q-rotary', 'cache-k', 'cache-v'];
  for (const id of inputIds) {
    const tensor = graph.tensors.find(row => row.tensorId === id);
    if (!tensor) throw Error('Missing attention input '+id);
    attention.graph.tensors.push(tensor);
    attention.input(id);
  }
  const perHead: [string, Shape[number]['semantic'], string][] = [['b', 'batch', 'B'], ['q', 'token', 'Q'], ['head', 'head', 'NH']];
  const scoreShape: typeof perHead = [...perHead, ['s', 'token', 'M']];
  const valueShape: typeof perHead = [...perHead, ['d', 'hidden', 'D']];
  for (const id of ['scores', 'weights']) attention.tensor(id, scoreShape, { dtype: fp32 });
  attention.tensor('weights-bf16', scoreShape, { dtype: bf16 });
  for (const id of ['dcp-max', 'dcp-denom']) attention.tensor(id, perHead, { dtype: fp32 });
  attention.tensor('dcp-numerator', valueShape, { dtype: fp32 });
  attention.tensor('attended', valueShape);

  const valid = 'min(Slots, max(0, C + Q - SlotStart))';
  const head = 'B * Q * NH * ';
  const matmul = (n: string) => '2 * ' + head + '(' + n + ') * D';
  const reduce = (n: string) => head + 'max((' + n + ') - 1, 0)';
  const elementwise = (n: string) => head + '(' + n + ')';
  function work(id: string, name: string, inputs: string[], outputs: string[], count: (extent: string) => string, computeClass?: typeof vector) {
    attention.node(id, name, inputs, outputs, { useful: count('C + Q'), executed: count('M'), ...(computeClass ? { computeClass } : {}) });
    const node = attention.graph.nodes.at(-1);
    const body = node?.body;
    if (body?.kind !== 'opaque') throw Error('Missing attention work '+id);
    body.localCost = LocalCostRule.parse({
      participation: { kind: 'tensor_layout', tensorId: inputs[0] },
      bindings: [
        { symbol: 'SlotStart', source: { kind: 'tensor_slice', tensorId: cacheK, axisId: 's', edge: 'start' } },
        { symbol: 'Slots', source: { kind: 'tensor_axis', tensorId: cacheK, axisId: 's', basis: 'allocated' } },
      ],
      cost: { ...body.cost, compute: body.cost.compute.map(segment => ({ ...segment,
        usefulOperations: eq.value(count(valid), 'operation'), executedOperations: eq.value(count('Slots'), 'operation'),
      })) },
      description: note,
    });
  }
  work('qk', 'Local GQA QKᵀ', ['q-rotary', 'cache-k'], ['scores'], matmul);
  work('local-max', 'Valid local score maximum (−∞ for empty slice)', ['scores'], ['dcp-max'], reduce, vector);
  work('shift-exp', 'exp((score − global max) / √D), with masked rows zero', ['scores', 'dcp-max'], ['weights'],
    n => '4 * ' + elementwise(n), vector);
  work('sum-exp', 'Local FP32 softmax denominator', ['weights'], ['dcp-denom'], reduce, vector);
  work('cast-weights', 'Cast unnormalized weights to BF16', ['weights'], ['weights-bf16'], elementwise, vector);
  work('weighted-values', 'Local weighted values with FP32 accumulation', ['weights-bf16', 'cache-v'], ['dcp-numerator'], matmul);
  work('normalize', 'Divide global weighted values by the global denominator', ['dcp-numerator', 'dcp-denom'], ['attended'],
    () => head + 'D', vector);

  const replaces = (id: string) => id === 'qk' || id === 'softmax' || id === 'av';
  const retired = (id: string) => id === 'scores' || id === 'probabilities' || id === 'softmax-scratch';
  graph.nodes = [...graph.nodes.filter(node => !replaces(node.nodeId)), ...attention.graph.nodes];
  graph.tensors = [...graph.tensors.filter(tensor => !retired(tensor.tensorId)),
    ...attention.graph.tensors.filter(tensor => !inputIds.includes(tensor.tensorId) && tensor.tensorId !== 'attended')];
  graph.storages = [...graph.storages.filter(storage => !retired(storage.storageId)),
    ...attention.graph.storages.filter(storage => storage.storageId !== 'attended')];
  const upstream = new Map(graph.edges.filter(edge => inputIds.includes(edge.tensorId)).map(edge => [edge.tensorId, edge.from]));
  graph.edges = [
    ...graph.edges.filter(edge => edge.to.kind !== 'node' || !replaces(edge.to.nodeId)).map(edge =>
      edge.from.kind === 'node' && edge.from.nodeId === 'av' ? { ...edge, from: { ...edge.from, nodeId: NodeId.parse('normalize') } } : edge),
    ...attention.graph.edges.map(edge => {
      if (edge.from.kind !== 'graph_input') return edge;
      const from = upstream.get(edge.tensorId);
      if (!from) throw Error('Missing attention data flow '+edge.tensorId);
      return { ...edge, from };
    }),
  ];
  const replacement = AssetDocument.parse({ ...decoder, assetId: 'builtin:module:qwen3-dcp-decoder', revision: 1,
    name: 'Qwen3 Dense/GQA decode context partition', sources, definition: { kind: 'module', graph } });
  const tile = eq.value('4 * B * Q * NH', 'byte'), numerator = eq.value('4 * B * Q * NH * D', 'byte');
  const preset = ParallelPresetTemplate.parse({
    presetId: 'dcp-kv', name: 'Decode KV 分片', description: '均分固定 KV 槽位，每卡计算本地注意力并归约。',
    strategy: 'decode_context_sharded', phases: ['decode'], tensorShards: [], reductions: [], assumptions: [note],
    decodeContext: { module: ref(decoder), replacement: ref(replacement) },
    networkDefaults: { scope: 'intra_group', bytesPerSecond: 100e9, latencySeconds: 3e-6, description: 'Editable link for attention AllReduce.' },
    moduleRules: [{ module: ref(replacement), tensorShards: ['cache-k', 'cache-v', 'scores', 'weights', 'weights-bf16'].map(tensorId =>
      ({ tensorId, axisId: 's' })), reductions: [
      { tensorId: 'dcp-max', producerNodeId: 'local-max', consumerNodeIds: ['shift-exp'], operation: 'max', payloadBytes: tile, payloadDtype: fp32 },
      { tensorId: 'dcp-denom', producerNodeId: 'sum-exp', consumerNodeIds: ['normalize'], operation: 'sum', payloadBytes: tile, payloadDtype: fp32 },
      { tensorId: 'dcp-numerator', producerNodeId: 'weighted-values', consumerNodeIds: ['normalize'], operation: 'sum', payloadBytes: numerator, payloadDtype: fp32 },
    ] }],
  });
  return [...models.map(model => AssetDocument.parse({ ...model, revision: model.revision + 1,
    parallelPresets: [...model.parallelPresets ?? [], preset] })), replacement, ...eq.assets];
}

/** Reuse the existing DCP formulas with the physical request slice bound locally. */
export function addQwenDecodeRequestParallel(decoder: AssetDocument, models: AssetDocument[]) {
  if (decoder.definition.kind !== 'module') throw Error('Expected the Qwen DCP module');
  const graph = structuredClone(decoder.definition.graph);
  const batchNote = 'Request replicas use the same DCP equations on their local batch slices. Each replica merges its own requests across its KV ranks.';
  const localBatch = (value: ValueExpr, name: string): ValueExpr => {
    if (value.kind !== 'formula') return value;
    const binding = value.call.bindings.B;
    return binding?.kind === 'symbol' && binding.name === 'B'
      ? { ...value, call: { ...value.call, bindings: { ...value.call.bindings, B: symbol(name) } } }
      : value;
  };
  for (const node of graph.nodes) {
    if (node.body.kind !== 'opaque' || !node.body.localCost) throw Error('Missing Qwen DCP local cost '+node.nodeId);
    const { cost, bindings } = node.body.localCost, input = node.body.inputs[0];
    const axis = graph.tensors.find(tensor => tensor.tensorId === input?.tensorId)?.shape.find(row => row.semantic === 'batch');
    if (!input || !axis) throw Error('Missing Qwen DCP request axis '+node.nodeId);
    const batchBinding = (basis: 'logical' | 'allocated') => {
      const existing = bindings.find(binding => binding.source.kind === 'tensor_axis' && binding.source.tensorId === input.tensorId &&
        binding.source.axisId === axis.axisId && binding.source.basis === basis);
      if (existing) return existing.symbol;
      const name = basis + '_B';
      bindings.push({ symbol: name, source: { kind: 'tensor_axis', tensorId: input.tensorId, axisId: axis.axisId, basis } });
      return name;
    };
    const useful = batchBinding('logical'), executed = batchBinding('allocated');
    for (const segment of cost.compute) {
      segment.usefulOperations = localBatch(segment.usefulOperations, useful);
      segment.executedOperations = localBatch(segment.executedOperations, executed);
    }
    for (const access of cost.memoryAccess) {
      if (access.logicalBytes.kind !== 'storage_allocation') access.logicalBytes = localBatch(access.logicalBytes, executed);
    }
  }
  const module = AssetDocument.parse({ ...decoder, revision: decoder.revision + 1,
    sources: [...decoder.sources, { kind: 'note', text: batchNote }], definition: { kind: 'module', graph } });
  const roots = models.map(model => AssetDocument.parse({ ...model, revision: model.revision + 1,
    parallelPresets: model.parallelPresets?.map(preset => preset.decodeContext && 'module' in preset.decodeContext ? {
      ...preset, requestBatchSharding: true, assumptions: [...preset.assumptions, batchNote],
      decodeContext: { ...preset.decodeContext, replacement: ref(module) },
      moduleRules: preset.moduleRules?.map(rule => rule.module.assetId === decoder.assetId && rule.module.revision === decoder.revision ?
        { ...rule, module: ref(module) } : rule),
    } : preset),
  }));
  return [...roots, module];
}
