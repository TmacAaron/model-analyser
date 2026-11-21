import { AssetDocument, NodeId, ParallelPresetTemplate, TensorId, type GraphTemplate, type ValueExpr } from '@model-analyser/contracts';
import { bf16, ref, vector } from './model-authoring.js';
import { makeDeepSeekAssets } from './deepseek-model.js';
import { loadDeepSeekV3Profile, type DeepSeekV3Release } from './deepseek-v3-profile.js';
import { withLocalCost, type AxisBinding } from './local-cost-authoring.js';

const attentionTensors = [
  ['q-weight', 'out'], ['kv-b-k-weight', 'out'], ['kv-b-v-weight', 'out'], ['o-weight', 'in'],
  ...['q-raw', 'q-nope', 'q-rope', 'q-absorbed', 'scores', 'probabilities', 'softmax-scratch', 'latent-attended', 'attended']
    .map(id => [id, 'head']),
];
const expertTensors = [
  ...['expert-gate-weight', 'expert-up-weight', 'expert-down-weight'].map(id => [id, 'owner-expert']),
  ...['expert-route-ids', 'expert-route-weights', 'expert-input', 'expert-gate-up', 'expert-activated', 'expert-output']
    .map(id => [id, 'selected']),
];
const expertFeatureTensors = [
  ['expert-gate-weight', 'out'], ['expert-up-weight', 'out'], ['expert-down-weight', 'in'],
  ['expert-gate-up', 'j'], ['expert-activated', 'j'],
];
const axes: Record<string, AxisBinding[]> = {
  'q-proj': [['NH', 'q-raw', 'head']],
  rope: [['NH', 'q-raw', 'head']],
  'q-absorb': [['NH', 'q-nope', 'head']],
  qk: [['NH', 'q-absorbed', 'head']],
  softmax: [['NH', 'scores', 'head']],
  av: [['NH', 'probabilities', 'head']],
  'v-up': [['NH', 'latent-attended', 'head']],
  'o-proj': [['NH', 'attended', 'head']],
  dispatch: [['K', 'expert-input', 'selected']],
  'expert-gate-up': [['K', 'expert-input', 'selected'], ['E', 'expert-gate-weight', 'owner-expert']],
  'expert-silu': [['K', 'expert-gate-up', 'selected']],
  'expert-down': [['K', 'expert-activated', 'selected'], ['E', 'expert-down-weight', 'owner-expert']],
  combine: [['K', 'expert-output', 'selected']],
};
const featureAxes: Record<string, AxisBinding[]> = {
  ...axes,
  'expert-gate-up': [...axes['expert-gate-up']!, ['J', 'expert-gate-weight', 'out']],
  'expert-silu': [...axes['expert-silu']!, ['J', 'expert-activated', 'j']],
  'expert-down': [...axes['expert-down']!, ['J', 'expert-activated', 'j']],
};
const placementNote = 'The BF16 local equations use allocated request, head and owner slot extents. Comparisons use FP32 vector proxies. With P expert ranks, logical expert e belongs to e mod P; the owner-expert storage axis orders the weights by rank, then by floor(e/P). That placement stripes every router group across the ranks. The estimate assumes K/P selected slots per owner per token. Each owner packs its rows from the replicated token, IDs and original normalized scores, and the routed partials are summed before adding replicated shared experts.';
const balancedPlacementNote = 'Expert weights are evenly split by striped owner (expert e belongs to rank e mod P). Each token still selects K experts globally. The theoretical route budget distributes those K slots by quotient and remainder. Each owner reserves ceil(K/P) slots; useful work, token gathers and routed weight reads use valid slots, while executed slot work includes padding. Each owner packs its rows from the replicated token, IDs and original normalized scores, and the routed partials are summed before adding replicated shared experts.';
const expertFeatureNote = 'Analytical routed-expert TP slices matching gate and up channels and the same down-projection inputs. The packed gate/up activation stores channel pairs together. TP peers in an owner group use the same valid routes, and route-weighted hidden partials can be summed across owners and feature ranks in one reduction before adding replicated shared experts.';
const activeRouteReads = {
  dispatch: ['read-post-norm'],
  'expert-gate-up': ['read-expert-gate-weight', 'read-expert-up-weight'],
  'expert-down': ['read-expert-down-weight'],
};
const layoutSource = 'https://github.com/deepseek-ai/DeepSeek-V3/blob/b15f0dbbbe6a4bc403306175698439ef380f5fb5/inference/model.py';

function withVectorRouting(graph: GraphTemplate): GraphTemplate {
  return { ...graph, nodes: graph.nodes.map(node => node.body.kind !== 'opaque' ? node : {
    ...node, body: { ...node.body, cost: { ...node.body.cost, compute: node.body.cost.compute.map(segment =>
      segment.computeClass.resourceKey === 'topk-comparison' ? { ...segment, computeClass: vector } : segment,
    ) } },
  }) };
}

function reduction(tensorId: string, producer: string, consumer: string, payload: ValueExpr) {
  return { tensorId: TensorId.parse(tensorId), producerNodeId: NodeId.parse(producer), consumerNodeIds: [NodeId.parse(consumer)],
    payloadBytes: payload, payloadDtype: bf16 };
}

export function makeDeepSeekV3ParallelAssets(release: DeepSeekV3Release, revision: 2 | 3 | 4 = 4) {
  const profile = loadDeepSeekV3Profile(release);
  const balanced = revision >= 3;
  const [root, dense, moe, ...formulas] = makeDeepSeekAssets('absorbed', profile, true, balanced);
  if (root?.definition.kind !== 'model' || dense?.definition.kind !== 'module' || moe?.definition.kind !== 'module') throw Error('Missing V3 decoder assets');
  const sources: AssetDocument['sources'] = [...profile.sources.map(source => source.kind === 'note' ?
    { ...source, text: source.text.replace(', kernel fusion and distributed layout', ' and kernel fusion') } : source),
  { kind: 'url', url: layoutSource, checkedOn: '2026-11-21' }, { kind: 'note', text: balanced ? balancedPlacementNote : placementNote }];
  const localNote = balanced ? balancedPlacementNote : placementNote;
  const featureSources: AssetDocument['sources'] = [...sources, { kind: 'note', text: expertFeatureNote }];
  const publishModule = (asset: AssetDocument, splitFeatures: boolean) => {
    if (asset.definition.kind !== 'module') throw Error('Expected a decoder module');
    return AssetDocument.parse({ ...asset, revision: splitFeatures ? 4 : Math.min(revision, 3), sources: splitFeatures ? featureSources : sources,
      definition: { ...asset.definition, graph: withLocalCost(withVectorRouting(asset.definition.graph), splitFeatures ? featureAxes : axes,
        splitFeatures ? localNote + ' ' + expertFeatureNote : localNote, balanced ? activeRouteReads : undefined) } });
  };
  const denseModule = publishModule(dense, false), moeModule = publishModule(moe, revision === 4);
  const embedding = root.definition.graph.nodes.find(node => node.nodeId === 'embedding');
  const payload = embedding?.body.kind === 'opaque' && embedding.body.cost.memoryAccess.find(access => access.storageId === 'embedding')?.logicalBytes;
  if (!payload || payload.kind === 'storage_allocation') throw Error('Missing BF16 hidden output tile equation');
  const headReduce = reduction('attention-output', 'o-proj', 'attention-residual', payload);
  const expertReduce = reduction('routed-output', 'combine', 'shared-add', payload);
  const sharding = (rows: string[][]) => rows.map(([tensorId, axisId]) => ({ tensorId: TensorId.parse(tensorId), axisId,
    ...(balanced && axisId === 'selected' ? { policy: 'balanced' as const } : {}) }));
  const common = { phases: ['prefill', 'decode'], tensorShards: [], reductions: [],
    assumptions: ['Replicated tensors execute locally. The checkpoint is represented with the BF16 analytical weight format.'] };
  const networkDefaults = { scope: 'intra_group', bytesPerSecond: 100_000_000_000, latencySeconds: 0.000003,
    description: 'Editable analytical reference link. Rates are illustrative, not measured hardware capabilities.' };
  const tp = { module: ref(denseModule), tensorShards: sharding(attentionTensors), reductions: [headReduce] };
  const ep = { module: ref(moeModule), tensorShards: sharding(expertTensors), reductions: [expertReduce] };
  const moeTp = { ...ep, tensorShards: sharding(expertFeatureTensors) };
  const shared = (expert: typeof ep) => [tp, { ...expert, tensorShards: [...tp.tensorShards, ...expert.tensorShards], reductions: [headReduce, expertReduce] }];
  const presets = [
    { ...common, presetId: 'replicated', name: '单副本', description: '单卡执行完整模型。', strategy: 'replicated' },
    { ...common, presetId: 'dp-batch', name: '请求 DP', description: '按请求均分 batch，每卡持有完整模型。', strategy: 'batch_sharded' },
    { ...common, presetId: 'tp-mla', name: 'Attention TP', description: '分片 MLA 查询头，复制潜向量 KV，归约注意力输出。', strategy: 'tensor_sharded',
      sharedPoolDegrees: ['attentionTp'], networkDefaults, moduleRules: [tp, { ...tp, module: ref(moeModule) }] },
    { ...common, presetId: 'ep-routed', name: 'MoE EP', description: balanced ? '均分专家权重，按均衡路由估算负载，归约路由输出。' : '均分路由专家与每 token 的已选位置，归约路由输出。', strategy: 'tensor_sharded',
      sharedPoolDegrees: ['moeEp'], networkDefaults, moduleRules: [ep], assumptions: [...common.assumptions, localNote] },
    { ...common, presetId: 'tp-mla-ep-routed', name: 'Attention TP ＋ MoE EP',
      description: '同一批卡分片 MLA 查询头和路由专家，复制潜向量 KV 与共享专家。路由负载按均衡分布估算。', strategy: 'tensor_sharded',
      sharedPoolDegrees: ['attentionTp', 'moeEp'], networkDefaults, moduleRules: shared(ep), assumptions: [...common.assumptions, localNote] },
    ...(revision === 4 ? [
      { ...common, presetId: 'tp-routed', name: 'MoE TP', description: '切分各路由专家的中间特征。', strategy: 'tensor_sharded',
        sharedPoolDegrees: ['moeTp'], networkDefaults, moduleRules: [moeTp], assumptions: [...common.assumptions, expertFeatureNote] },
      { ...common, presetId: 'tp-mla-tp-routed', name: 'Attention TP ＋ MoE TP', description: '共用卡池切分 MLA 查询头和各路由专家的中间特征。',
        strategy: 'tensor_sharded', sharedPoolDegrees: ['attentionTp', 'moeTp'], networkDefaults, moduleRules: shared(moeTp),
        assumptions: [...common.assumptions, expertFeatureNote] },
    ] : []),
  ].map(preset => ParallelPresetTemplate.parse(preset));
  const graph = withLocalCost(root.definition.graph, {}, localNote);
  const modules = new Map([denseModule, moeModule].map(module => [module.assetId, module]));
  graph.nodes = graph.nodes.map(node => {
    if (node.body.kind !== 'module') return node;
    const module = modules.get(node.body.asset.assetId);
    if (!module) throw Error('Missing DeepSeek module ' + node.body.asset.assetId);
    return { ...node, body: { ...node.body, asset: ref(module) } };
  });
  const modelSources = revision === 4 ? featureSources : sources;
  const model = AssetDocument.parse({ ...root, revision, sources: modelSources, parallelPresets: presets, definition: { ...root.definition,
    graph,
    assumptions: modelSources.flatMap(source => source.kind === 'note' ? [source.text] : []),
  } });
  return [model, denseModule, moeModule, ...formulas];
}
