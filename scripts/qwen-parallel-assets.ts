import { readFileSync } from 'node:fs';
import { AssetDocument, NodeId, ParallelPresetTemplate, TensorId } from '@model-analyser/contracts';
import { bf16, ref } from './model-authoring.js';
import { makeQwen17Assets } from './model-expansion.js';
import { makeQwenAssets } from './qwen-model.js';
import { withLocalCost, type AxisBinding } from './local-cost-authoring.js';

const attentionAxes: Record<string, AxisBinding[]> = {
  qkv: [['NH', 'q-proj', 'head'], ['NK', 'k-proj', 'kvhead']],
  'qk-norm-rope': [['NH', 'q-proj', 'head'], ['NK', 'k-proj', 'kvhead']],
  'cache-update': [['NK', 'k-new', 'kvhead']],
  qk: [['NH', 'q-rotary', 'head']],
  softmax: [['NH', 'scores', 'head']],
  av: [['NH', 'probabilities', 'head']],
  'o-proj': [['NH', 'attended', 'head']],
};

const description = 'Independent request batches or matching query/KV head slices use their declared local axes. ' +
  'Other dimensions retain their global values. Full object accesses use the local allocation. ' +
  'Explicit embedding and KV append traffic uses BF16 bytes for the newly accessed token tile.';

export function makeQwenParallelAssets() {
  const qwen06 = makeQwenAssets(), qwen17 = makeQwen17Assets();
  const originalDecoder = AssetDocument.parse(JSON.parse(readFileSync('assets/builtin/module/builtin%3Amodule%3Aqwen3-decoder-r2.json', 'utf8')));
  if (originalDecoder.definition.kind !== 'module') throw Error('Missing Qwen decoder module');
  const decoder = AssetDocument.parse({
    ...originalDecoder,
    revision: 3,
    definition: { ...originalDecoder.definition, graph: withLocalCost(originalDecoder.definition.graph, attentionAxes, description) },
    sources: [...originalDecoder.sources, { kind: 'note', text: 'Revision 3 declares local batch and attention-head equations and preserves the global equations.' }],
  });
  const localShards = [
    ['q-weight', 'out'], ['k-weight', 'out'], ['v-weight', 'out'], ['o-weight', 'in'],
    ...['q-proj', 'q-rotary', 'scores', 'probabilities', 'softmax-scratch', 'attended'].map(id => [id, 'head']),
    ...['k-proj', 'k-new', 'v-new', 'cache-k', 'cache-v'].map(id => [id, 'kvhead']),
  ];
  const common = {
    phases: ['prefill', 'decode'],
    tensorShards: [], reductions: [],
    assumptions: ['Even partitions with complete model weights where replicated. Physical work counts replicated execution per rank.'],
  };
  const models = [...qwen06, ...qwen17].flatMap(asset => {
    if (asset.definition.kind !== 'model') return [];
    const source = asset.definition.graph;
    // The result tensor has B × Q × H BF16 elements, identical to the declared embedding read tile.
    const embedding = source.nodes.find(node => node.nodeId === 'embedding');
    const payload = embedding?.body.kind === 'opaque' && embedding.body.cost.memoryAccess.find(access => access.storageId === 'embedding')?.logicalBytes;
    if (!payload || payload.kind === 'storage_allocation') throw Error('Missing Qwen BF16 hidden tile equation');
    const presets = [
      ParallelPresetTemplate.parse({ ...common, presetId: 'replicated', name: '单副本', description: '执行完整模型。', strategy: 'replicated' }),
      ParallelPresetTemplate.parse({ ...common, presetId: 'dp-batch', name: 'DP 请求分片', description: '均分请求，权重复制，无推理 collective。', strategy: 'batch_sharded' }),
      ParallelPresetTemplate.parse({
        ...common, presetId: 'tp-attention-heads', name: 'Attention TP · Q/KV heads 分片',
        description: '每层分片 Q/KV heads 和输出投影，残差前 AllReduce。FFN、embedding 和 LM head 在每卡执行。',
        strategy: 'tensor_sharded',
        assumptions: [...common.assumptions, 'Ring output AllReduce uses the full BF16 hidden tile. Additional local reduction arithmetic, scratch and conversion are not modeled.'],
        moduleRules: [{
          module: ref(decoder),
          tensorShards: localShards.map(([tensorId, axisId]) => ({ tensorId: TensorId.parse(tensorId), axisId })),
          reductions: [{
            tensorId: TensorId.parse('attention-output'), producerNodeId: NodeId.parse('o-proj'),
            consumerNodeIds: [NodeId.parse('attention-residual')], payloadBytes: payload, payloadDtype: bf16,
          }],
        }],
      }),
    ];
    const graph = withLocalCost(source, attentionAxes, description);
    graph.nodes = graph.nodes.map(node => node.body.kind === 'module' && node.body.asset.assetId === decoder.assetId
      ? { ...node, body: { ...node.body, asset: ref(decoder) } } : node);
    return [AssetDocument.parse({
      ...asset, revision: asset.revision + 1, parallelPresets: presets,
      definition: { ...asset.definition, graph },
    })];
  });
  return [...models, decoder, ...qwen06.filter(asset => asset.definition.kind === 'formula')];
}
