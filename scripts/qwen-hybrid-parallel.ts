import { AssetDocument, NodeId, ParallelPresetTemplate, TensorId, type ValueExpr } from '@model-analyser/contracts';
import { bf16, ref } from './model-authoring.js';
import { withLocalCost, type AxisBinding } from './local-cost-authoring.js';
import { makeQwenHybridAssets } from './qwen-hybrid-model.js';
import type { QwenHybridRelease } from './qwen-hybrid-profile.js';

type Shard = readonly [tensorId: string, axisId: string, policy?: 'balanced'];
const onAxis = (axis: string, ...ids: string[]): Shard[] => ids.map(id => [id, axis]);
const gqaShards: Shard[] = [
  ...onAxis('out', 'q-weight', 'k-weight', 'v-weight'), ['o-weight', 'in'],
  ...onAxis('head', 'q-proj', 'attn-gate', 'k-proj', 'v-new', 'query', 'key-new', 'cache-k', 'cache-v',
    'scores', 'probabilities', 'softmax-work', 'attended', 'gated-attention'),
];
const deltaShards: Shard[] = [
  ...['q', 'k', 'v'].flatMap(part => onAxis('head', ...['delta-qkv-weight', 'delta-mixed', 'conv-state', 'conv-next', 'conv-weight']
    .map(id => id + '-' + part))),
  ...onAxis('out', 'delta-output-gate-weight', 'beta-weight', 'decay-weight'),
  ...onAxis('d', 'decay-log', 'decay-bias'), ['delta-o-weight', 'in'],
  ...onAxis('head', 'linear-z', 'beta-logits', 'decay-logits', 'linear-query', 'linear-key', 'linear-value', 'query-l2', 'key-l2',
    'beta', 'decay', 'delta-state', 'delta-next', 'state-work', 'delta-output', 'gated-values'),
];
const expertShards: Shard[] = [
  ...onAxis('i', 'expert-gate-up-weight', 'expert-gate-up', 'expert-activation'), ['expert-down-weight', 'in'],
];
const ownerShards: Shard[] = [
  ...onAxis('expert', 'expert-gate-up-weight', 'expert-down-weight'),
  ...['owner-route-ids', 'owner-route-weights', 'expert-input', 'expert-gate-up', 'expert-activation', 'expert-output']
    .map((id): Shard => [id, 'expert', 'balanced']),
];

const gqaHeads = (query: string, kv: string): AxisBinding[] => [['NH', query, 'head'], ['NK', kv, 'head']];
const gqaAxes: Record<string, AxisBinding[]> = {
  qkv: gqaHeads('q-proj', 'k-proj'), 'qk-norm-rope': gqaHeads('q-proj', 'k-proj'),
  'cache-update': [['NK', 'key-new', 'head']], qk: [['NH', 'query', 'head']],
  softmax: [['NH', 'scores', 'head']], av: [['NH', 'probabilities', 'head']],
  'output-gate': [['NH', 'attended', 'head']], 'o-proj': [['NH', 'gated-attention', 'head']],
};
const linearProjection: AxisBinding[] = [['LK', 'delta-mixed-q', 'head'], ['LV', 'delta-mixed-v', 'head']];
const deltaAxes: Record<string, AxisBinding[]> = {
  'delta-qkv': linearProjection, convolve: linearProjection,
  'delta-output-gate-proj': [['LV', 'linear-z', 'head']],
  'beta-proj': [['LV', 'beta-logits', 'head']], 'decay-proj': [['LV', 'decay-logits', 'head']],
  'qk-l2-norm': [['LK', 'linear-query', 'head']], beta: [['LV', 'beta-logits', 'head']], decay: [['LV', 'decay-logits', 'head']],
  recurrent: [['LV', 'linear-value', 'head']], 'value-norm-gate': [['LV', 'delta-output', 'head']],
  'delta-o-proj': [['LV', 'gated-values', 'head']],
};
const expertAxes: Record<string, AxisBinding[]> = {
  'expert-gate-up': [['J', 'expert-gate-up', 'i']], 'expert-silu': [['J', 'expert-gate-up', 'i']],
  'expert-down': [['J', 'expert-activation', 'i']],
};
const routes = (tensorId: string): AxisBinding => ['K', tensorId, 'expert'];
const ownerAxes: Record<string, AxisBinding[]> = {
  dispatch: [routes('expert-input')],
  'expert-gate-up': [...expertAxes['expert-gate-up']!, routes('expert-input'), ['E', 'expert-gate-up-weight', 'expert']],
  'expert-silu': [...expertAxes['expert-silu']!, routes('expert-gate-up')],
  'expert-down': [...expertAxes['expert-down']!, routes('expert-activation'), ['E', 'expert-down-weight', 'expert']],
  combine: [routes('expert-output')],
};
const activeRouteReads = {
  dispatch: ['read-ffn-input'],
  'expert-gate-up': ['read-expert-gate-up-weight'],
  'expert-down': ['read-expert-down-weight'],
};

const attentionNote = 'GQA assigns each rank matching query groups and whole KV heads. DeltaNet splits the Q, K and V convolution channels independently, associates each key head with its value heads, and partitions the FP32 recurrent matrix on the value-head axis. Each attention output projection contributes a partial hidden tile to the residual AllReduce.';
const expertNote = 'Routed expert TP splits J within every expert. Gate and up retain their paired feature slices; every rank receives the same selected expert IDs and normalized weights, and contributes a partial weighted output. The partial routed output is reduced before the replicated shared expert is added. Routing comparisons use a scalar FP32 vector work proxy.';
const ownerNote = 'MoE EP uses contiguous ownership of the expert weights. Each rank reads the replicated token and global TopK routes, packs its owned expert IDs and original normalized weights, and reduces the partial weighted outputs before adding the replicated shared expert. The analytical route profile splits K selected slots into quotient and remainder on each token, reserves ceil(K/P) slots per rank, and evaluates padded execution with the reserved count. Token gathers and expert-weight HBM use valid routes only. Live routing skew, capacity overflow, and runtime token exchanges are outside this profile.';
const localNote = 'Local compute and tile accesses bind actual batch, head or expert feature extents. Fully accessed objects use their allocated bytes.';
const runtimeSource = 'https://github.com/vllm-project/vllm/blob/9a4930a797846e4d57af7f72df20d82acaeb9c10/vllm/model_executor/layers/mamba/gdn/qwen_gdn_linear_attn.py';
const expertSource = 'https://github.com/huggingface/transformers/blob/506ac612812b9682dfcfea300b71c1b709cfbae0/docs/source/en/expert_parallelism.md';

function reduction(tensorId: string, producer: string, consumer: string, payloadBytes: ValueExpr) {
  return { tensorId: TensorId.parse(tensorId), producerNodeId: NodeId.parse(producer), consumerNodeIds: [NodeId.parse(consumer)],
    payloadBytes, payloadDtype: bf16 };
}

export function makeQwenHybridParallelAssets(release: QwenHybridRelease, revision: 2 | 3 = 2): AssetDocument[] {
  const [root, period, delta, gqa, ...formulas] = makeQwenHybridAssets(release, revision);
  if (root?.definition.kind !== 'model' || period?.definition.kind !== 'module' ||
      delta?.definition.kind !== 'module' || gqa?.definition.kind !== 'module') throw Error('Missing hybrid decoder graph');
  const moe = release === 'qwen35';
  const owners = revision === 3;
  const notes = moe ? [attentionNote, expertNote] : [attentionNote];
  const sources: AssetDocument['sources'] = [
    ...root.sources.map(source => source.kind === 'note' ? { ...source, text: source.text.replace('allocator and distributed execution', 'allocator and framework kernel execution') } : source),
    { kind: 'url', url: runtimeSource, checkedOn: '2026-11-21' }, ...notes.map(text => ({ kind: 'note' as const, text })),
    ...(owners ? [{ kind: 'url' as const, url: expertSource, checkedOn: '2026-11-21' }, { kind: 'note' as const, text: ownerNote }] : []),
  ];
  const publish = (asset: AssetDocument, axes: Record<string, AxisBinding[]>) => {
    if (asset.definition.kind !== 'module') throw Error('Missing decoder module');
    return AssetDocument.parse({ ...asset, sources, definition: { ...asset.definition,
      graph: withLocalCost(asset.definition.graph, { ...(owners ? ownerAxes : moe ? expertAxes : {}), ...axes },
        owners ? localNote + ' Expert dispatch gathers and selected weight reads use valid routes.' : localNote,
        owners ? activeRouteReads : undefined) } });
  };
  const deltaModule = publish(delta, deltaAxes), gqaModule = publish(gqa, gqaAxes);
  const embedding = root.definition.graph.nodes.find(node => node.nodeId === 'embedding');
  const payload = embedding?.body.kind === 'opaque' && embedding.body.cost.memoryAccess.find(access => access.storageId === 'embedding-weight')?.logicalBytes;
  if (!payload || payload.kind === 'storage_allocation') throw Error('Missing BF16 hidden tile equation');
  const routedReduce = reduction('routed-output', 'combine', 'shared-add', payload);
  const rule = (module: AssetDocument, shards: Shard[], reductions: ReturnType<typeof reduction>[]) => ({
    module: ref(module), tensorShards: shards.map(([tensorId, axisId, policy]) => ({ tensorId: TensorId.parse(tensorId), axisId,
      ...(policy ? { policy } : {}) })), reductions,
  });
  const deltaReduce = reduction('attention-output', 'delta-o-proj', 'attention-residual', payload);
  const gqaReduce = reduction('attention-output', 'o-proj', 'attention-residual', payload);
  const common = { phases: ['prefill', 'decode'], tensorShards: [], reductions: [],
    assumptions: ['Replicated objects retain full weights and execute locally where used. Ring AllReduce uses the full BF16 hidden tile.'] };
  const networkDefaults = { scope: 'intra_group', bytesPerSecond: 100_000_000_000, latencySeconds: 0.000003,
    description: 'Editable analytical reference link. Rates are illustrative, not measured hardware capabilities.' };
  const tp = { ...common, presetId: 'tp-hybrid-attention', name: 'Attention TP',
    description: '分片 GQA KV 头与 DeltaNet 固定状态，在每层注意力残差前归约。', strategy: 'tensor_sharded',
    sharedPoolDegrees: ['attentionTp'], networkDefaults,
    moduleRules: [rule(deltaModule, deltaShards, [deltaReduce]), rule(gqaModule, gqaShards, [gqaReduce])] };
  const presets = [
    { ...common, presetId: 'replicated', name: '单副本', description: '单卡执行完整模型。', strategy: 'replicated' },
    { ...common, presetId: 'dp-batch', name: '请求 DP', description: '按请求均分 batch，复制模型权重，无新增通信。', strategy: 'batch_sharded' },
    tp,
    ...(moe ? [
      { ...common, presetId: 'tp-routed-expert', name: 'MoE TP',
        description: '切分各路由专家的中间维度，在合并共享专家前归约。Attention 和共享专家在每卡执行。', strategy: 'tensor_sharded',
        sharedPoolDegrees: ['moeTp'], networkDefaults, moduleRules: [deltaModule, gqaModule].map(module => rule(module, expertShards, [routedReduce])) },
      { ...tp, presetId: 'tp-hybrid-attention-routed-expert', name: 'Attention TP ＋ MoE TP',
        description: '同一批卡切分 GQA、DeltaNet 及路由专家中间维度，分别在注意力残差和共享专家合并前归约。',
        sharedPoolDegrees: ['attentionTp', 'moeTp'], moduleRules: [rule(deltaModule, [...deltaShards, ...expertShards], [deltaReduce, routedReduce]),
          rule(gqaModule, [...gqaShards, ...expertShards], [gqaReduce, routedReduce])] },
    ] : []),
    ...(owners ? [
      { ...common, presetId: 'ep-routed', name: 'MoE EP',
        description: '分片路由专家权重，按均衡路由估算负载，在合并共享专家前归约。', strategy: 'tensor_sharded',
        sharedPoolDegrees: ['moeEp'], networkDefaults, assumptions: [...common.assumptions, ownerNote],
        moduleRules: [deltaModule, gqaModule].map(module => rule(module, ownerShards, [routedReduce])) },
      { ...tp, presetId: 'tp-hybrid-attention-ep-routed', name: 'Attention TP ＋ MoE EP',
        description: '共用一组卡切分 Attention 头和路由专家，分别在注意力残差和共享专家合并前归约。',
        sharedPoolDegrees: ['attentionTp', 'moeEp'], assumptions: [...common.assumptions, ownerNote],
        moduleRules: [rule(deltaModule, [...deltaShards, ...ownerShards], [deltaReduce, routedReduce]),
          rule(gqaModule, [...gqaShards, ...ownerShards], [gqaReduce, routedReduce])] },
    ] : []),
  ].map(preset => ParallelPresetTemplate.parse(preset));
  const model = AssetDocument.parse({ ...root, sources, parallelPresets: presets, definition: { ...root.definition,
    graph: withLocalCost(root.definition.graph, {}, localNote),
    assumptions: sources.flatMap(source => source.kind === 'note' ? [source.text] : []),
  } });
  return [model, { ...period, sources }, deltaModule, gqaModule, ...formulas];
}
