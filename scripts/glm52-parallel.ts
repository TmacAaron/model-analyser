import { AssetDocument, NodeId, ParallelPresetTemplate, TensorId, type GraphTemplate, type ValueExpr } from '@model-analyser/contracts';
import { parameter } from './deepseek-v4-model.js';
import { makeGlm52Assets } from './glm52-model.js';
import { withLocalCost, type AxisBinding } from './local-cost-authoring.js';
import { Equations, bf16, ref } from './model-authoring.js';

type Shard = Readonly<{ tensorId: string; axisId: string; policy?: 'balanced' }>;
type PresetRule = NonNullable<ParallelPresetTemplate['moduleRules']>[number];
type Degree = NonNullable<ParallelPresetTemplate['sharedPoolDegrees']>[number];

const on = (axisId: string, tensors: string[]): Shard[] => tensors.map(tensorId => ({ tensorId, axisId }));
const attentionShards = [
  ...on('n', ['q-content', 'q-position-raw', 'q-position', 'q-absorbed', 'scores', 'probabilities', 'attended-latent', 'attended-value']),
  ...on('w1', ['qb-weight']), ...on('w0', ['k-absorb-weight', 'v-up-weight', 'o-weight']),
];
const expertShards: Shard[] = [
  ...on('w0', ['expert-gate-weight', 'expert-up-weight', 'expert-down-weight']),
  ...['expert-input', 'owner-ids', 'owner-weights', 'expert-gate-up-output', 'expert-activation', 'expert-output']
    .map((tensorId): Shard => ({ tensorId, axisId: 'e', policy: 'balanced' })),
];
const expertFeatureShards = [
  ...on('w2', ['expert-gate-weight', 'expert-up-weight']), ...on('w1', ['expert-down-weight']),
  ...on('d', ['expert-gate-up-output', 'expert-activation']),
];

const heads = (tensor: string): AxisBinding => ['N', tensor, 'n'];
const routes = (tensor: string): AxisBinding => ['K', tensor, 'e'];
const axes: Record<string, AxisBinding[]> = {
  'q-b': [heads('q-content')], 'qk-rope': [heads('q-position-raw')], 'q-absorb': [heads('q-content')],
  qk: [heads('q-absorbed')], softmax: [heads('scores')], av: [heads('probabilities')],
  'v-up': [heads('attended-latent')], 'o-proj': [heads('attended-value')],
  dispatch: [routes('expert-input')],
  'expert-gate-up': [routes('expert-input'), ['E', 'expert-gate-weight', 'w0'], ['J', 'expert-gate-up-output', 'd']],
  'expert-silu': [routes('expert-activation'), ['J', 'expert-activation', 'd']],
  'expert-down': [routes('expert-activation'), ['E', 'expert-down-weight', 'w0'], ['J', 'expert-activation', 'd']],
  combine: [routes('expert-output')],
};
const activeAccesses = {
  dispatch: ['read-ffn-input'], 'expert-gate-up': ['read-expert-gate-weight', 'read-expert-up-weight'], 'expert-down': ['read-expert-down-weight'],
};
const attention = 'Shard MLA query heads and their absorbed projections. Replicate the latent and rotary caches and each of the 21 DSA indexers. Reuse selected row IDs within each replica. Reduce the BF16 attention output before its residual add.';
const expert = 'Assign equal contiguous expert ranges to EP ranks. Preserve each token’s global Top-K and balance valid routes by quotient and remainder. Each rank reserves ceil(K/EP) slots. Token gathering and weight reads use valid slots. Reduce the BF16 routed output before adding the replicated shared expert.';
const expertFeature = 'Shard the intermediate width of each routed expert. Pair gate and up features on each rank and keep every selected expert available. Reduce the BF16 routed output before adding the replicated shared expert.';
const equationNote = 'Local equations bind the batch, MLA heads, owner routes, expert count and intermediate width from tensor layouts. AllReduce uses the configured ring model.';

function reduction(tensorId: string, producer: string, consumer: string, payloadBytes: ValueExpr) {
  return { tensorId: TensorId.parse(tensorId), producerNodeId: NodeId.parse(producer), consumerNodeIds: [NodeId.parse(consumer)], payloadBytes, payloadDtype: bf16 };
}

export function makeGlm52ParallelAssets(revision: 2 | 3 = 3): AssetDocument[] {
  const [root, ...dependencies] = makeGlm52Assets(revision);
  if (root?.definition.kind !== 'model') throw Error('Missing GLM-5.2 decoder');
  const notes = [equationNote, attention, expert, expertFeature];
  const sources: AssetDocument['sources'] = [
    ...root.sources.map(source => source.kind === 'note' ? {
      ...source, text: source.text.replace('RoPE table generation, distributed layout, and data-dependent routes', 'RoPE table generation and data-dependent routes'),
    } : source),
    { kind: 'url', url: 'https://github.com/vllm-project/vllm/blob/2cf0a6915ce544dc493a0990f2ea38d81601128a/vllm/model_executor/models/registry.py', checkedOn: '2026-11-21' },
    ...notes.map(text => ({ kind: 'note' as const, text })),
  ];
  const equations = new Equations('builtin:formula:glm-5.2-parallel', ['B', 'Q', 'H'].map(key => parameter(key, 1)), [
    { kind: 'note', text: 'Logical BF16 hidden tile for a reduction before ring traffic and launch factors.' },
  ]);
  const payload = equations.value('2 * B * Q * H', 'byte');
  const attentionReduction = reduction('attention-output', 'o-proj', 'attention-residual', payload);
  const expertReduction = reduction('routed-output', 'combine', 'shared-add', payload);
  const local = (graph: GraphTemplate) => withLocalCost(graph, axes, equationNote, activeAccesses);
  const modules = dependencies.flatMap(asset => asset.definition.kind === 'module' ? [{ ...asset, definition: asset.definition }] : []);
  const blocks = modules.filter(module => module.definition.graph.nodes.some(node => node.nodeId === 'q-b'));
  const moe = blocks.filter(module => module.definition.graph.nodes.some(node => node.nodeId === 'expert-gate-up'));
  const rule = (module: AssetDocument, shards: Shard[], reductions: PresetRule['reductions']): PresetRule => ({
    module: ref(module), tensorShards: shards.map(shard => ({ ...shard, tensorId: TensorId.parse(shard.tensorId) })), reductions,
  });
  const tp = blocks.map(module => rule(module, attentionShards, [attentionReduction]));
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
    { ...common, presetId: 'dp-batch', name: '请求 DP', description: '均分完整请求，每卡保留全部权重。', strategy: 'batch_sharded' },
    parallel('tp-glm-attention', 'Attention TP', '切分 MLA 查询头及其投影，每卡计算 DSA 索引。', ['attentionTp'], tp, [attention]),
    parallel('ep-glm-routed', 'MoE EP', '均分专家权重，按均衡路由估算。', ['moeEp'], ep, [expert]),
    parallel('tp-glm-routed', 'MoE TP', '切分各路由专家的中间特征。', ['moeTp'], moeTp, [expertFeature]),
    parallel('tp-glm-attention-ep', 'Attention TP ＋ MoE EP', '共用卡池切分 MLA 查询头和专家。', ['attentionTp', 'moeEp'], shared(ep), [attention, expert]),
    parallel('tp-glm-attention-moe', 'Attention TP ＋ MoE TP', '共用卡池切分 MLA 查询头和各专家中间特征。', ['attentionTp', 'moeTp'], shared(moeTp), [attention, expertFeature]),
  ].map(preset => ParallelPresetTemplate.parse(preset));
  const model = AssetDocument.parse({ ...root, sources, parallelPresets,
    definition: { ...root.definition, graph: local(root.definition.graph), assumptions: sources.flatMap(source => source.kind === 'note' ? [source.text] : []) } });
  return [model, ...modules.map(module => AssetDocument.parse({ ...module, sources,
    definition: { ...module.definition, graph: local(module.definition.graph) } })), ...dependencies.filter(asset => asset.definition.kind !== 'module'), ...equations.assets];
}
