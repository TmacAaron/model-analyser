import { AssetDocument, NodeId, ParallelPresetTemplate, TensorId, type GraphTemplate, type ValueExpr } from '@model-analyser/contracts';
import { parameter } from './deepseek-v4-model.js';
import { makeKimiK3Assets } from './kimi-k3-model.js';
import { withLocalCost, type AxisBinding } from './local-cost-authoring.js';
import { Equations, bf16, ref } from './model-authoring.js';

type Shard = Readonly<{ tensorId: string; axisId: string; policy?: 'balanced' }>;
type PresetRule = NonNullable<ParallelPresetTemplate['moduleRules']>[number];
type Degree = NonNullable<ParallelPresetTemplate['sharedPoolDegrees']>[number];

const on = (axisId: string, tensors: string[]): Shard[] => tensors.map(tensorId => ({ tensorId, axisId }));
const channels = ['q', 'k', 'v'];
const kdaShards = [
  ...on('n', [...channels.flatMap(id => ['raw', 'filtered', 'history', 'history-next'].map(suffix => `${id}-${suffix}`)),
    'q-unit', 'k-unit', 'decay-logits', 'decay', 'matrix-state', 'matrix-next', 'matrix-work', 'recurrent-out', 'gate-logits', 'gated-values']),
  ...on('d', ['beta-logits', 'beta']),
  ...on('w1', [...channels.map(id => `kda-${id}-weight`), 'decay-b-weight', 'beta-weight', 'gate-weight']),
  ...on('w0', [...channels.map(id => `${id}-conv-weight`), 'decay-log-scale', 'decay-bias', 'attention-output-weight']),
];
const mlaShards = [
  ...on('n', ['q-main', 'q-extra', 'q-absorbed', 'attention-score', 'attention-probability', 'attended-latent',
    'attended-value', 'gate-logits', 'gated-values']),
  ...on('w1', ['qb-weight', 'gate-weight']), ...on('w0', ['k-absorb-weight', 'v-up-weight', 'attention-output-weight']),
];
const expertShards: Shard[] = [
  ...on('w0', ['expert-gate-weight', 'expert-up-weight', 'expert-down-weight']),
  ...['owner-ids', 'owner-weights', 'expert-input', 'expert-gate-up-output', 'expert-activation', 'expert-output']
    .map((tensorId): Shard => ({ tensorId, axisId: 'n', policy: 'balanced' })),
];
const expertFeatureShards = [
  ...on('w2', ['expert-gate-weight', 'expert-up-weight']), ...on('w1', ['expert-down-weight']),
  ...on('d', ['expert-gate-up-output', 'expert-activation']),
];

const heads = (tensor: string, axis = 'n'): AxisBinding => ['N', tensor, axis];
const routes = (tensor: string): AxisBinding => ['K', tensor, 'n'];
const axes: Record<string, AxisBinding[]> = {
  'kda-qkv': [heads('q-raw')], ...Object.fromEntries(channels.map(id => [`${id}-conv`, [heads(`${id}-raw`)]])),
  'qk-normalize': [heads('q-filtered')], 'decay-b': [heads('decay-logits')], 'bounded-decay': [heads('decay-logits')],
  'beta-proj': [heads('beta-logits', 'd')], 'beta-sigmoid': [heads('beta-logits', 'd')], recurrent: [heads('q-unit')],
  'kda-gate-proj': [heads('gate-logits')], 'kda-norm-gate': [heads('recurrent-out')], 'kda-o-proj': [heads('gated-values')],
  'q-b': [heads('q-main')], 'q-absorb': [heads('q-main')], qk: [heads('q-absorbed')], softmax: [heads('attention-score')],
  av: [heads('attention-probability')], 'v-up': [heads('attended-latent')], 'mla-gate-proj': [heads('gate-logits')],
  'mla-gate': [heads('attended-value')], 'mla-o-proj': [heads('gated-values')],
  dispatch: [routes('expert-input')],
  'expert-gate-up': [routes('expert-input'), ['E', 'expert-gate-weight', 'w0'], ['J', 'expert-gate-up-output', 'd']],
  'expert-situ': [routes('expert-activation'), ['J', 'expert-activation', 'd']],
  'expert-down': [routes('expert-activation'), ['E', 'expert-down-weight', 'w0'], ['J', 'expert-activation', 'd']],
  combine: [routes('expert-output')],
};
const activeAccesses = {
  dispatch: ['read-expert-latent'], 'expert-gate-up': ['read-expert-gate-weight', 'read-expert-up-weight'], 'expert-down': ['read-expert-down-weight'],
};
const attention = 'Shard KDA and Gated MLA projections by head. Each KDA rank maintains its own FP32 matrix and BF16 convolution history. MLA latent and shared NoPE key caches are replicated. Reduce attention before each depth mixing or residual consumer.';
const expert = 'Shard routed expert weights by contiguous ownership. Preserve the full per-token Top-K with balanced valid slots and padding to ceil(K/EP). Gather valid routes and reduce the BF16 latent result before its RMSNorm and up projection.';
const expertFeature = 'Shard paired gate and up features and matching down projection inputs within each routed expert. Reduce the BF16 latent result before RMSNorm. Router, latent input projections and shared experts are replicated across these ranks.';
const equationNote = 'Use local batch, heads, route slots, expert count and intermediate width from the declared layouts. Attention Residual archives are activations for the active request lanes. Link costs use the declared ring model.';

function reduction(tensorId: string, producer: string, consumers: string[], payloadBytes: ValueExpr) {
  if (!consumers.length) throw Error('Missing reduction consumers for ' + producer);
  return { tensorId: TensorId.parse(tensorId), producerNodeId: NodeId.parse(producer), consumerNodeIds: consumers.map(id => NodeId.parse(id)), payloadBytes, payloadDtype: bf16 };
}

export function makeKimiK3ParallelAssets(): AssetDocument[] {
  const [root, ...dependencies] = makeKimiK3Assets(2);
  if (root?.definition.kind !== 'model') throw Error('Missing Kimi-K3 decoder');
  const notes = [equationNote, attention, expert, expertFeature];
  const sources: AssetDocument['sources'] = [
    ...root.sources.map(source => source.kind === 'note' ? { ...source, text: source.text.replace('device sharding and vision encoder', 'and vision encoder') } : source),
    { kind: 'url', url: 'https://vllm.ai/blog/2026-09-08-vllm-agentx', checkedOn: '2026-11-21' },
    ...notes.map(text => ({ kind: 'note' as const, text })),
  ];
  const equations = new Equations('builtin:formula:kimi-k3-parallel', ['B', 'Q', 'H', 'M'].map(key => parameter(key, 1)), [
    { kind: 'note', text: 'Logical BF16 tile for an AllReduce prior to ring traffic and launch factors.' },
  ]);
  const hiddenPayload = equations.value('2 * B * Q * H', 'byte'), latentPayload = equations.value('2 * B * Q * M', 'byte');
  const expertReduction = reduction('combined-latent', 'combine', ['latent-rmsnorm'], latentPayload);
  const modules = dependencies.flatMap(asset => asset.definition.kind === 'module' ? [{ ...asset, definition: asset.definition }] : []);
  const rule = (module: AssetDocument, shards: Shard[], reductions: PresetRule['reductions']): PresetRule => ({
    module: ref(module), tensorShards: shards.map(shard => ({ ...shard, tensorId: TensorId.parse(shard.tensorId) })), reductions,
  });
  const tp = modules.flatMap(module => {
    const { nodes } = module.definition.graph;
    const projection = nodes.find(node => node.nodeId === 'kda-o-proj' || node.nodeId === 'mla-o-proj');
    if (!projection) return [];
    const consumers = nodes.filter(node => node.body.kind === 'opaque' && node.body.inputs.some(port => port.tensorId === 'attention-output'));
    const shards = projection.nodeId === 'kda-o-proj' ? kdaShards : mlaShards;
    return [rule(module, shards, [reduction('attention-output', projection.nodeId, consumers.map(node => node.nodeId), hiddenPayload)])];
  });
  const moe = modules.filter(module => module.definition.graph.nodes.some(node => node.nodeId === 'expert-gate-up'));
  const ep = moe.map(module => rule(module, expertShards, [expertReduction]));
  const moeTp = moe.map(module => rule(module, expertFeatureShards, [expertReduction]));
  const shared = (expertRules: PresetRule[]) => tp.map(attentionRule => {
    const expertRule = expertRules.find(candidate => candidate.module.assetId === attentionRule.module.assetId);
    return expertRule ? { ...attentionRule, tensorShards: [...attentionRule.tensorShards, ...expertRule.tensorShards],
      reductions: [...attentionRule.reductions, ...expertRule.reductions] } : attentionRule;
  });
  const common = { phases: ['prefill', 'decode'], tensorShards: [], reductions: [], assumptions: [equationNote] };
  const networkDefaults = { scope: 'intra_group', bytesPerSecond: 100e9, latencySeconds: 3e-6, description: 'Editable analytical reference link.' };
  const parallel = (presetId: string, name: string, description: string, sharedPoolDegrees: Degree[], moduleRules: PresetRule[], assumptions: string[]) => ({
    ...common, presetId, name, description, strategy: 'tensor_sharded', sharedPoolDegrees, networkDefaults, moduleRules, assumptions: [...common.assumptions, ...assumptions],
  });
  const parallelPresets = [
    { ...common, presetId: 'replicated', name: '单副本', description: '单卡执行完整文本解码器。', strategy: 'replicated' },
    { ...common, presetId: 'dp-batch', name: '请求 DP', description: '均分请求与状态，每卡保留全部权重。', strategy: 'batch_sharded' },
    parallel('tp-kimi-attention', 'Attention TP', '切分 KDA 与 MLA 头，按头分片 KDA 状态。', ['attentionTp'], tp, [attention]),
    parallel('ep-kimi-routed', 'MoE EP', '均分路由专家，按均衡负载估算，在潜空间归约。', ['moeEp'], ep, [expert]),
    parallel('tp-kimi-routed', 'MoE TP', '切分各路由专家的中间特征，在潜空间归约。', ['moeTp'], moeTp, [expertFeature]),
    parallel('tp-kimi-attention-ep', 'Attention TP ＋ MoE EP', '共用卡池切分注意力头和专家。', ['attentionTp', 'moeEp'], shared(ep), [attention, expert]),
    parallel('tp-kimi-attention-moe', 'Attention TP ＋ MoE TP', '共用卡池切分注意力头和专家中间特征。', ['attentionTp', 'moeTp'], shared(moeTp), [attention, expertFeature]),
  ].map(preset => ParallelPresetTemplate.parse(preset));
  const local = (graph: GraphTemplate) => withLocalCost(graph, axes, equationNote, activeAccesses);
  const model = AssetDocument.parse({ ...root, sources, parallelPresets,
    definition: { ...root.definition, graph: local(root.definition.graph), assumptions: sources.flatMap(source => source.kind === 'note' ? [source.text] : []) } });
  return [model, ...modules.map(module => AssetDocument.parse({ ...module, sources,
    definition: { ...module.definition, graph: local(module.definition.graph) } })), ...dependencies.filter(asset => asset.definition.kind !== 'module'), ...equations.assets];
}
