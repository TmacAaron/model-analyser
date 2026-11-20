import { AssetDocument, type GraphTemplate } from '@model-analyser/contracts';
import { Equations, GraphAuthor, fp32, int64, symbol, vector } from './model-authoring.js';
import { selection } from './deepseek-model.js';
import { addDeltaAttention, addGatedAttention, hidden, matrixWeight, normWeight, sequence, type Axis } from './qwen-hybrid-attention.js';
import { hybridSources, loadQwenHybrid, type QwenHybridRelease } from './qwen-hybrid-profile.js';

export function addSwiGlu(graph: GraphAuthor, width: string, prefix: string, input: string, output: string) {
  for (const part of ['gate', 'up']) matrixWeight(graph, prefix + '-' + part + '-weight', width);
  graph.tensor(prefix + '-gate-up', sequence('i', '2 * ' + width));
  graph.node(prefix + '-gate-up', 'SwiGLU gate and up projections', [input, prefix + '-gate-weight', prefix + '-up-weight'],
    [prefix + '-gate-up'], { useful: '4 * B * Q * H * ' + width });
  graph.tensor(prefix + '-activation', sequence('i', width));
  graph.node(prefix + '-silu', 'SiLU(gate) × up', [prefix + '-gate-up'], [prefix + '-activation'],
    { useful: '6 * B * Q * ' + width, computeClass: vector });
  matrixWeight(graph, prefix + '-down-weight', 'H', width);
  graph.tensor(output, hidden);
  graph.node(prefix + '-down', 'SwiGLU down projection', [prefix + '-activation', prefix + '-down-weight'], [output],
    { useful: '2 * B * Q * H * ' + width });
}

export type HybridModelRevision = 1 | 2 | 3 | 4;

function addMoe(graph: GraphAuthor, revision: HybridModelRevision) {
  const shardIntermediate = revision >= 2, packByOwner = revision >= 3;
  matrixWeight(graph, 'router-weight', 'E');
  const routerShape: Axis[] = [['b', 'batch', 'B'], ['q', 'token', 'Q'], ['expert', 'expert', 'E']];
  const selected = 'if(K <= E, K, 1 / 0)';
  const selectedShape: Axis[] = [['b', 'batch', 'B'], ['q', 'token', 'Q'], ['expert', 'expert', selected]];
  graph.tensor('router-logits', routerShape);
  graph.node('router', 'Routed expert logits', ['ffn-input', 'router-weight'], ['router-logits'], { useful: '2 * B * Q * H * E' });
  graph.tensor('router-probabilities', routerShape, { dtype: fp32 });
  graph.node('router-softmax', 'FP32 expert softmax', ['router-logits'], ['router-probabilities'],
    { useful: '5 * B * Q * E', computeClass: vector });
  graph.tensor('topk-indices', selectedShape, { dtype: int64 });
  graph.tensor('topk-probabilities', selectedShape, { dtype: fp32 });
  graph.node('topk', 'Select TopK routed experts', ['router-probabilities'], ['topk-indices', 'topk-probabilities'],
    { useful: 'B * Q * E * K', computeClass: shardIntermediate ? vector : selection });
  graph.tensor('route-weights', selectedShape);
  graph.node('route-renormalize', 'Renormalize selected expert weights', ['topk-probabilities'], ['route-weights'],
    { useful: 'B * Q * (2 * K - 1)', computeClass: vector });

  const slots = packByOwner ? 'RouteSlots' : 'K';
  const ids = packByOwner ? 'owner-route-ids' : 'topk-indices';
  const weights = packByOwner ? 'owner-route-weights' : 'route-weights';
  graph.tensor('expert-input', [...selectedShape, ['h', 'hidden', 'H']]);
  if (packByOwner) {
    graph.tensor(ids, selectedShape, { dtype: int64 });
    graph.tensor(weights, selectedShape);
  }
  graph.node('dispatch', packByOwner ? 'Pack tokens and normalized routes by expert owner' : 'Dispatch tokens to selected experts',
    ['ffn-input', 'topk-indices', ...(packByOwner ? ['route-weights'] : [])],
    ['expert-input', ...(packByOwner ? [ids, weights] : [])], undefined,
    { accessBytes: { 'ffn-input': '2 * B * Q * ' + slots + ' * H' } });
  // Keep gate and up paired when each rank owns a slice of the intermediate dimension.
  const gateUp: Axis[] = shardIntermediate ? [['gate-up', 'custom', '2'], ['i', 'hidden', 'J']] : [['i', 'hidden', '2 * J']];
  const weightGateUp: Axis[] = shardIntermediate ? gateUp : [['out', 'hidden', '2 * J']];
  graph.tensor('expert-gate-up-weight', [['expert', 'expert', 'E'], ...weightGateUp, ['in', 'hidden', 'H']], { category: 'weight' });
  graph.tensor('expert-gate-up', [...selectedShape, ...gateUp]);
  const ownerIds = packByOwner ? [ids] : [];
  graph.node('expert-gate-up', 'Routed SwiGLU gate and up projections', ['expert-input', 'expert-gate-up-weight', ...ownerIds], ['expert-gate-up'],
    { useful: '4 * B * Q * ' + slots + ' * H * J' }, { accessBytes: { 'expert-gate-up-weight': '4 * min(E, B * Q * ' + slots + ') * H * J' } });
  graph.tensor('expert-activation', [...selectedShape, ['i', 'hidden', 'J']]);
  graph.node('expert-silu', 'Routed SiLU(gate) × up', ['expert-gate-up'], ['expert-activation'],
    { useful: '6 * B * Q * ' + slots + ' * J', computeClass: vector });
  graph.tensor('expert-down-weight', [['expert', 'expert', 'E'], ['out', 'hidden', 'H'], ['in', 'hidden', 'J']], { category: 'weight' });
  graph.tensor('expert-output', [...selectedShape, ['h', 'hidden', 'H']]);
  graph.node('expert-down', 'Routed SwiGLU down projection', ['expert-activation', 'expert-down-weight', ...ownerIds], ['expert-output'],
    { useful: '2 * B * Q * ' + slots + ' * H * J' }, { accessBytes: { 'expert-down-weight': '2 * min(E, B * Q * ' + slots + ') * H * J' } });
  if (revision === 4) {
    // The expert axis contains uniform matrices. The accessed share includes their local scales.
    const passes = graph.equations.value('min(E, B * Q * RouteSlots) / E', 'ratio');
    for (const [id, weightId] of [['expert-gate-up', 'expert-gate-up-weight'], ['expert-down', 'expert-down-weight']]) {
      const node = graph.graph.nodes.find(row => row.nodeId === id);
      const read = node?.body.kind === 'opaque' && node.body.cost.memoryAccess.find(row => row.accessId === 'read-' + weightId);
      if (!read) throw Error('Missing sparse expert read ' + id);
      read.logicalBytes = { kind: 'storage_allocation', passes };
    }
  }
  graph.tensor('routed-output', hidden);
  graph.node('combine', 'Weighted routed expert sum', ['expert-output', weights, ids], ['routed-output'],
    { useful: '2 * B * Q * ' + slots + ' * H', computeClass: vector });

  addSwiGlu(graph, 'S', 'shared', 'ffn-input', 'shared-output');
  matrixWeight(graph, 'shared-mix-weight', '1');
  graph.tensor('shared-mix', sequence('h', '1'));
  graph.node('shared-mix-proj', 'Shared expert gate projection', ['ffn-input', 'shared-mix-weight'], ['shared-mix'], { useful: '2 * B * Q * H' });
  graph.tensor('shared-gated', hidden);
  graph.node('shared-gate', 'Apply sigmoid shared expert gate', ['shared-output', 'shared-mix'], ['shared-gated'],
    { useful: 'B * Q * (4 + H)', computeClass: vector });
  graph.tensor('ffn-output', hidden);
  graph.node('shared-add', 'Routed and shared expert merge', ['routed-output', 'shared-gated'], ['ffn-output'],
    { useful: 'B * Q * H', computeClass: vector });
}

const repeat = (count: string): GraphTemplate['nodes'][number]['repeat'] => ({
  axis: 'layer', count: symbol(count), wiring: 'chain', carry: [{ inputPortId: 'x', outputPortId: 'y' }],
});
const integer = (key: string, value: number, min = 1): AssetDocument['parameters'][number] =>
  ({ key, name: key, type: 'integer', unit: 'count', min, default: { kind: 'integer', value } });

export function makeQwenHybridAssets(release: QwenHybridRelease, revision: HybridModelRevision = 1): AssetDocument[] {
  const profile = loadQwenHybrid(release);
  if (revision >= 3 && !profile.moe) throw Error('Owner-local expert slots require a MoE decoder');
  const parameters = [
    integer('B', 1), integer('Q', 1), integer('C', 0, 0),
    ...Object.entries(profile.dimensions).map(([key, value]) => integer(key, value)),
  ];
  const dimensionParameters = [...parameters, integer('LinearCount', 3), integer('Periods', profile.periods)];
  // Global equations still evaluate exactly K >= 1. An EP owner can receive zero of those routes.
  const equations = new Equations('builtin:formula:qwen-hybrid',
    revision >= 3 ? [...dimensionParameters, integer('RouteSlots', 0, 0)] : dimensionParameters, hybridSources,
    revision >= 3 ? new Map([['RouteSlots', 'K']]) : undefined);
  const variant = profile.moe ? 'moe' : 'dense', modulePrefix = 'builtin:module:qwen-hybrid-' + variant + '-';
  const base = {
    documentType: 'asset', schemaVersion: 1, revision, tags: ['qwen', 'hybrid', 'text', 'bf16', variant],
    sources: hybridSources,
  };
  const module = (id: string, name: string, graph: GraphTemplate, params = parameters) =>
    AssetDocument.parse({ ...base, assetId: modulePrefix + id, name, parameters: params, definition: { kind: 'module', graph } });
  function makeLayer(linear: boolean) {
    const graph = new GraphAuthor(equations);
    graph.tensor('x', hidden);
    graph.input('x');
    normWeight(graph, 'input-norm-weight', 'H');
    graph.tensor('normed', hidden);
    graph.node('input-norm', 'Input RMSNorm', ['x', 'input-norm-weight'], ['normed'], { useful: '5 * B * Q * H', computeClass: vector });
    if (linear) addDeltaAttention(graph, revision >= 2);
    else addGatedAttention(graph);
    graph.tensor('attention-residual-output', hidden);
    graph.node('attention-residual', 'Attention residual add', ['x', 'attention-output'], ['attention-residual-output'],
      { useful: 'B * Q * H', computeClass: vector });
    normWeight(graph, 'post-norm-weight', 'H');
    graph.tensor('ffn-input', hidden);
    graph.node('post-norm', 'Post-attention RMSNorm', ['attention-residual-output', 'post-norm-weight'], ['ffn-input'],
      { useful: '5 * B * Q * H', computeClass: vector });
    if (profile.moe) addMoe(graph, revision);
    else addSwiGlu(graph, 'I', 'ffn', 'ffn-input', 'ffn-output');
    graph.tensor('y', hidden);
    graph.node('ffn-residual', 'FFN residual add', ['attention-residual-output', 'ffn-output'], ['y'],
      { useful: 'B * Q * H', computeClass: vector });
    graph.output('y');
    return module(linear ? 'delta' : 'gqa', linear ? 'Gated DeltaNet decoder' : 'Gated GQA decoder', graph.graph);
  }

  const linear = makeLayer(true), full = makeLayer(false), block = new GraphAuthor(equations);
  const blockParameters = [...parameters, integer('LinearCount', 3)];
  block.tensor('x', hidden); block.input('x'); block.tensor('after-linear', hidden); block.tensor('y', hidden);
  block.module('linear', linear.name, linear, 'x', 'after-linear', parameters, repeat('LinearCount'));
  block.module('full', full.name, full, 'after-linear', 'y', parameters);
  block.output('y');
  const period = module('period', 'Hybrid decoder period', block.graph, blockParameters);

  const graph = new GraphAuthor(equations);
  graph.tensor('tokens', [['b', 'batch', 'B'], ['q', 'token', 'Q']], { dtype: int64 });
  graph.input('tokens');
  matrixWeight(graph, 'embedding-weight', 'V');
  graph.tensor('embedded', hidden);
  graph.node('embedding', 'Token embedding lookup', ['tokens', 'embedding-weight'], ['embedded'], undefined,
    { accessBytes: { 'embedding-weight': '2 * B * Q * H' } });
  graph.tensor('decoder-output', hidden);
  graph.module('decoder', 'Hybrid decoder period', period, 'embedded', 'decoder-output', blockParameters, repeat('Periods'));
  normWeight(graph, 'final-norm-weight', 'H');
  graph.tensor('normalized', hidden);
  graph.node('final-norm', 'Final RMSNorm', ['decoder-output', 'final-norm-weight'], ['normalized'],
    { useful: '5 * B * Q * H', computeClass: vector });
  matrixWeight(graph, 'lm-head-weight', 'V');
  graph.tensor('logits', [['b', 'batch', 'B'], ['q', 'token', 'Q'], ['v', 'vocab', 'V']]);
  graph.node('lm-head', 'Untied full-position output head', ['normalized', 'lm-head-weight'], ['logits'],
    { useful: '2 * B * Q * H * V' });
  graph.output('logits');
  const model = AssetDocument.parse({
    ...base, assetId: 'builtin:model:' + profile.id, name: profile.name + ' · 文本解码器',
    parameters: dimensionParameters, definition: {
      kind: 'model', family: profile.family, variant: 'hybrid-text-' + variant, graph: graph.graph,
      assumptions: hybridSources.flatMap(source => source.kind === 'note' ? [source.text] : []),
      workloadBindings: (['prefill', 'decode'] as const).flatMap(phase => [
        ['B', 'batchSize'], ['Q', 'queryTokensPerRequest'], ['C', phase === 'prefill' ? 'pastTokensPerRequest' : 'contextTokensPerRequest'],
      ].map(([parameterKey, field]) => ({ phase, parameterKey, value: symbol(field!) }))),
    },
  });
  return [model, period, linear, full, ...equations.assets];
}
