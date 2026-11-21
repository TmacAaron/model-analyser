import { AssetDocument, NodeId, ParallelPresetTemplate, TensorId, type GraphTemplate, type ValueExpr } from '@model-analyser/contracts';
import { Equations, bf16, fp32, ref } from './model-authoring.js';
import { makeDeepSeekV4Assets, parameter } from './deepseek-v4-model.js';
import { makeDeepSeekV41Assets } from './deepseek-v41-model.js';
import { withLocalCost, type AxisBinding } from './local-cost-authoring.js';

type Shard = readonly [tensorId: string, axisId: string, policy?: 'balanced'];
const onAxis = (axis: string, ids: string[]): Shard[] => ids.map(id => [id, axis]);
const attentionShards = [
  ...onAxis('n', ['q0', 'q-normed', 'q', 'scores', 'probabilities', 'attended', 'attended-rotated', 'attended-quantized', 'group-output']),
  ...onAxis('w1', ['qb-weight', 'group-out-weight', 'index-q-weight', 'index-head-weight']),
  ...onAxis('w0', ['out-weight', 'sink-weight']),
];
const expertShards: Shard[] = [
  ...onAxis('w0', ['routed-gate-weight', 'routed-up-weight', 'routed-down-weight']),
  ...['dispatched', 'owner-experts', 'owner-weights', 'routed-gate', 'routed-up', 'routed-mix', 'routed-output']
    .map((id): Shard => [id, 'e', 'balanced']),
];
const expertFeatureShards = [
  ...onAxis('w2', ['routed-gate-weight', 'routed-up-weight', 'routed-down-weight']),
  ...onAxis('d', ['routed-gate', 'routed-up', 'routed-mix']),
];
const engramShards: Shard[] = [['engram-rows', 'w0', 'balanced'], ['engram-scales', 'w0', 'balanced']];

const heads = (tensor: string): AxisBinding[] => [['N', tensor, 'n']];
const groups = (tensor: string): AxisBinding[] => [['OG', tensor, 'n']];
const routes = (tensor: string): AxisBinding[] => [['K', tensor, 'e']];
const expert = (tensor: string, weight: string): AxisBinding[] => [...routes(tensor), ['E', weight, 'w0']];
const axes: Record<string, AxisBinding[]> = {
  'q-b': heads('q0'), 'q-head-rmsnorm': heads('q0'), 'q-rope': heads('q0'),
  'sparse-qk': heads('q'), 'sink-softmax': heads('scores'), 'sparse-av': heads('probabilities'),
  'output-rope': heads('attended'), 'output-fake-quant': heads('attended-rotated'),
  'group-output-proj': heads('attended-rotated'), 'output-proj': groups('group-output'),
  'route-dispatch': routes('dispatched'), 'routed-gate-proj': expert('dispatched', 'routed-gate-weight'),
  'routed-up-proj': expert('dispatched', 'routed-up-weight'), 'routed-swiglu': routes('routed-gate'),
  'routed-down-proj': expert('routed-mix', 'routed-down-weight'), 'route-combine': routes('routed-output'),
};
const featureAxes: Record<string, AxisBinding[]> = {
  ...axes,
  'routed-gate-proj': [...axes['routed-gate-proj']!, ['I', 'routed-gate', 'd']],
  'routed-up-proj': [...axes['routed-up-proj']!, ['I', 'routed-up', 'd']],
  'routed-swiglu': [...axes['routed-swiglu']!, ['I', 'routed-gate', 'd']],
  'routed-down-proj': [...axes['routed-down-proj']!, ['I', 'routed-mix', 'd']],
};
const activeAccesses = {
  'route-dispatch': ['read-ffn-input'], 'routed-gate-proj': ['read-routed-gate-weight'],
  'routed-up-proj': ['read-routed-up-weight'], 'routed-down-proj': ['read-routed-down-weight'],
};
const attentionNote = 'Each rank holds whole attention heads and matching output groups. Indexer query heads contribute FP32 partial scores, reduced before candidate selection or masking. Window, compressed latent, index K and compressor state are replicated, with one backing per shared cache on each rank. The row-parallel output partial uses an FP32 AllReduce before resuming the BF16 residual path.';
const expertNote = 'Each EP rank owns a contiguous, equal count of routed experts. Each token keeps its global Top-K, with per-rank route budgets balanced by quotient and remainder. Allocated slots use ceil(K/EP). Useful work and sparse gathers use valid slots. The shared expert is replicated and added after reducing FP32 routed partials.';
const featureNote = 'Routed-expert TP shards matched gate and up channels, SwiGLU results and down-projection input channels. TP peers within each owner group duplicate its route metadata. FP32 routed partials are summed across owner and feature ranks before the replicated shared expert is added.';
const engramNote = 'The combined V4.1 preset also shards the Engram weight and scale tables by rows, reserving ceil(rows/ranks) rows per rank. The lookup charges one read per requested hash on each rank, including the masked dummy row, and reduces the BF16 values before the replicated projection.';
const projectionNote = 'Local equations bind allocated request, head and expert extents. Lookup and sparse expert reads use explicit traffic equations. Link rates and analytical work proxies describe the configured estimate.';
const checkpointStorageNote = 'Non-quantized matrices retain the sampled checkpoint storage dtype. Routed memory traffic uses the touched fraction of local weights and scales. Published quantized matrices are available via the fixed weight preset.';
const formulaSources: AssetDocument['sources'] = [{ kind: 'note', text: 'Logical payload of an uncompressed reduction, before ring traffic and startup factors.' }];

function reduction(tensorId: string, producer: string, consumer: string, payloadBytes: ValueExpr, payloadDtype = fp32) {
  return { tensorId: TensorId.parse(tensorId), producerNodeId: NodeId.parse(producer), consumerNodeIds: [NodeId.parse(consumer)], payloadBytes, payloadDtype };
}

export function makeDeepSeekFlashParallelAssets(v41: boolean, revision: 2 | 3 | 4 = 4): AssetDocument[] {
  const [root, ...dependencies] = v41 ? makeDeepSeekV41Assets(revision) : makeDeepSeekV4Assets(revision);
  if (root?.definition.kind !== 'model') throw Error('Missing Flash decoder');
  const formulaParams = ['B', 'Q', 'H', 'Rows', 'EH', 'EN', 'ED'].map(key => parameter(key, 1, key === 'Rows' ? 0 : 1));
  const equations = new Equations('builtin:formula:deepseek-flash-parallel', formulaParams, formulaSources);
  const hiddenPayload = equations.value('4 * B * Q * H', 'byte');
  const sources: AssetDocument['sources'] = [...root.sources.map(source => source.kind === 'note' ? {
    ...source, text: source.text.replace(' and distributed layout are outside', ' are outside').replace(' and parallel layouts need', ' need'),
  } : source), ...[projectionNote, attentionNote, expertNote, ...(v41 ? [engramNote] : []),
    ...(revision >= 3 ? [featureNote] : []), ...(revision === 4 ? [checkpointStorageNote] : [])].map(text => ({ kind: 'note' as const, text }))];

  const modules = dependencies.flatMap(asset => asset.definition.kind === 'module' ? [{ ...asset, definition: asset.definition }] : []);
  const rules = modules.flatMap(module => {
    const graph = module.definition.graph;
    if (!graph.nodes.some(node => node.nodeId === 'route-combine')) return [];
    const tensorIds = new Set(graph.tensors.map(tensor => String(tensor.tensorId)));
    const contains = (name: string) => graph.nodes.some(node => node.nodeId === name);
    const existing = (rows: Shard[]) => rows.filter(([id]) => tensorIds.has(id));
    const attach = (shards: Shard[], reductions: ReturnType<typeof reduction>[]) => ({ module: ref(module), reductions,
      tensorShards: existing(shards).map(([id, axisId, policy]) => ({ tensorId: TensorId.parse(id), axisId, ...(policy ? { policy } : {}) })),
    });
    const tp = [reduction('attn-partial', 'output-proj', 'attn-output-cast', hiddenPayload)];
    const indexTensor = graph.tensors.find(tensor => tensor.tensorId === 'index-ranked');
    if (indexTensor) {
      const rows = indexTensor.shape.find(axis => axis.axisId === 't')?.size;
      const payload = equations.value('4 * B * Q * Rows', 'byte');
      if (!rows || payload.kind !== 'formula') throw Error('Missing index score row count');
      const consumer = contains('candidate-block-scores') ? 'candidate-block-scores' : contains('candidate-mask-apply') ? 'candidate-mask-apply' : 'index-topk';
      tp.push(reduction('index-ranked', 'index-reduce', consumer, { ...payload, call: { ...payload.call, bindings: { ...payload.call.bindings, Rows: rows } } }));
    }
    const indexShards = [...onAxis(v41 ? 'h' : 'n', ['index-q-raw', 'index-q']), ['index-dot', 'n'] as const,
      ['index-weights', v41 ? 'h' : 'd'] as const];
    const ep = [reduction('routed-reduced', 'route-combine', 'shared-add', hiddenPayload)];
    const hasEngram = contains('engram-lookup');
    const engram = hasEngram ? [reduction('engram-values', 'engram-lookup', 'engram-project', equations.value('2 * B * Q * EH * (EN - 1) * ED', 'byte'), bf16)] : [];
    const attention = [...attentionShards, ...indexShards];
    const shared = (expert: Shard[]) => attach([...attention, ...expert, ...(hasEngram ? engramShards : [])], [...tp, ...ep, ...engram]);
    return [{ tp: attach(attention, tp), ep: attach(expertShards, ep), moeTp: attach(expertFeatureShards, ep),
      combined: shared(expertShards), combinedTp: shared(expertFeatureShards) }];
  });

  const indexHeads = (id: string): AxisBinding[] => [['IH', id, v41 ? 'h' : 'n']];
  const flashAxes = { ...(revision >= 3 ? featureAxes : axes), 'index-query': indexHeads('index-q-raw'), 'index-query-rope': indexHeads('index-q-raw'),
    'index-weight': [['IH', 'index-weights', v41 ? 'h' : 'd']] as AxisBinding[], 'index-score': indexHeads('index-q'),
    'index-reduce': [['IH', 'index-dot', 'n']] as AxisBinding[] };
  const local = (graph: GraphTemplate) => withLocalCost(graph, flashAxes, projectionNote, activeAccesses);
  const common = { phases: ['prefill', 'decode'], tensorShards: [], reductions: [],
    assumptions: ['Declared mixed BF16/FP32 projection baseline and fixed cache formats. Link estimates use ring AllReduce.'] };
  const networkDefaults = { scope: 'intra_group', bytesPerSecond: 100e9, latencySeconds: 3e-6,
    description: 'Editable analytical reference link. Rates are illustrative.' };
  const presets = [
    { ...common, presetId: 'replicated', name: '单副本', description: '单卡执行完整文本解码器。', strategy: 'replicated' },
    { ...common, presetId: 'dp-batch', name: '请求 DP', description: '按请求分片，每卡持有模型权重。', strategy: 'batch_sharded' },
    { ...common, presetId: 'tp-flash-attention', name: 'Attention TP', description: '切分注意力与索引头，复制 KV，在索引选择和残差前归约。',
      strategy: 'tensor_sharded', sharedPoolDegrees: ['attentionTp'], networkDefaults, moduleRules: rules.map(rule => rule.tp), assumptions: [...common.assumptions, attentionNote] },
    { ...common, presetId: 'ep-flash-routed', name: 'MoE EP', description: '均分路由专家权重，按均衡路由估算负载。',
      strategy: 'tensor_sharded', sharedPoolDegrees: ['moeEp'], networkDefaults, moduleRules: rules.map(rule => rule.ep), assumptions: [...common.assumptions, expertNote] },
    { ...common, presetId: 'tp-flash-attention-ep', name: 'Attention TP ＋ MoE EP',
      description: v41 ? '共用卡池分片注意力头、专家和 Engram 表。' : '共用卡池分片注意力头与专家。',
      strategy: 'tensor_sharded', sharedPoolDegrees: ['attentionTp', 'moeEp'], networkDefaults, moduleRules: rules.map(rule => rule.combined),
      assumptions: [...common.assumptions, attentionNote, expertNote, ...(v41 ? [engramNote] : [])] },
    ...(revision >= 3 ? [
      { ...common, presetId: 'tp-flash-routed', name: 'MoE TP', description: '切分路由专家的中间通道。', strategy: 'tensor_sharded',
        sharedPoolDegrees: ['moeTp'], networkDefaults, moduleRules: rules.map(rule => rule.moeTp), assumptions: [...common.assumptions, featureNote] },
      { ...common, presetId: 'tp-flash-attention-moe', name: 'Attention TP ＋ MoE TP',
        description: v41 ? '共用卡池分片注意力头、专家中间通道和 Engram 表。' : '共用卡池分片注意力头与专家中间通道。',
        strategy: 'tensor_sharded', sharedPoolDegrees: ['attentionTp', 'moeTp'], networkDefaults, moduleRules: rules.map(rule => rule.combinedTp),
        assumptions: [...common.assumptions, attentionNote, featureNote, ...(v41 ? [engramNote] : [])] },
    ] : []),
  ].map(preset => ParallelPresetTemplate.parse(preset));
  const model = AssetDocument.parse({ ...root, sources, parallelPresets: presets,
    definition: { ...root.definition, graph: local(root.definition.graph), assumptions: sources.flatMap(source => source.kind === 'note' ? [source.text] : []) } });
  return [model, ...modules.map(module => AssetDocument.parse({ ...module, sources,
    definition: { ...module.definition, graph: local(module.definition.graph) } })), ...dependencies.filter(asset => asset.definition.kind !== 'module'), ...equations.assets];
}
