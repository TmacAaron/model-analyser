import { AssetDocument, type GraphTemplate, type Shape, type ValueExpr } from '@model-analyser/contracts';
import { Equations, GraphAuthor, bf16, fp32, int64, symbol } from './model-authoring.js';
import { addV4Attention, int32, sequence, vectorWork, weight } from './deepseek-v4-attention.js';
import { deepSeekV4Sources, loadDeepSeekV4 } from './deepseek-v4-profile.js';

type Axis = [string, Shape[number]['semantic'], string];
type Parameter = AssetDocument['parameters'][number];
export const token: Axis[] = [['b', 'batch', 'B'], ['q', 'token', 'Q']];
export const hidden = sequence('H');
export const residual: Axis[] = [...token, ['r', 'custom', 'HC'], ['d', 'hidden', 'H']];
const repeat = (count: ValueExpr): NonNullable<GraphTemplate['nodes'][number]['repeat']> => ({
  axis: 'layer', count, wiring: 'chain', carry: [{ inputPortId: 'x', outputPortId: 'y' }],
});
export const parameter = (key: string, value: number, min = 1): Parameter =>
  ({ key, name: key, type: 'integer', unit: 'count', min, default: { kind: 'integer', value } });

export function hyperCoefficients(graph: GraphAuthor, prefix: 'attn' | 'ffn', stream: string) {
  const n = (suffix: string) => prefix + '-hc-' + suffix;
  const mix = 'HC * (HC + 2)';
  weight(graph, n('fn'), [mix, 'HC * H'], fp32);
  weight(graph, n('scale'), ['3'], fp32); weight(graph, n('base'), [mix], fp32);
  graph.tensor(n('mixes'), sequence(mix), { dtype: fp32 });
  graph.node(n('mix'), 'FP32 hyper-connection projection and RMS scaling', [stream, n('fn')], [n('mixes')],
    vectorWork('B * Q * (2 * H * HC * HC * (HC + 2) + 4 * HC * H + HC * (HC + 2))'));
  graph.tensor(n('pre'), sequence('HC'), { dtype: fp32 });
  graph.tensor(n('post'), sequence('HC'), { dtype: fp32 });
  graph.tensor(n('comb'), [...token, ['from', 'custom', 'HC'], ['to', 'custom', 'HC']], { dtype: fp32 });
  graph.node(n('sinkhorn'), 'Pre/post gates and Sinkhorn residual mixing',
    [n('mixes'), n('scale'), n('base')], [n('pre'), n('post'), n('comb')],
    vectorWork('B * Q * (14 * HC + 2 * HC * HC + (3 + 4 * SI) * HC * HC)'));
}

export function hyperInput(graph: GraphAuthor, prefix: 'attn' | 'ffn', stream: string, pre: string, v41 = false) {
  const n = (suffix: string) => prefix + '-hc-' + suffix;
  graph.tensor(n('reduced'), hidden);
  graph.node(n('reduce'), 'Reduce hyper-connection streams', [stream, pre], [n('reduced')], vectorWork('B * Q * H * (2 * HC - 1)'));
  const norm = prefix + '-norm-weight', output = prefix + '-input';
  weight(graph, norm, ['H'], v41 ? bf16 : fp32);
  graph.tensor(output, hidden);
  graph.node(prefix + '-rmsnorm', prefix === 'attn' ? 'Attention input RMSNorm' : 'MoE input RMSNorm',
    [n('reduced'), norm], [output], vectorWork('5 * B * Q * H'));
}

function hyperPre(graph: GraphAuthor, prefix: 'attn' | 'ffn', stream: string) {
  hyperCoefficients(graph, prefix, stream);
  hyperInput(graph, prefix, stream, prefix + '-hc-pre');
}

export function hyperPost(graph: GraphAuthor, prefix: 'attn' | 'ffn', stream: string, branch: string, output: string) {
  graph.tensor(output, residual);
  graph.node(prefix + '-hc-merge', 'Expand branch and mix residual streams',
    [stream, branch, prefix + '-hc-post', prefix + '-hc-comb'], [output],
    vectorWork('B * Q * H * HC * (2 * HC + 1)'));
}

export function addV4Moe(graph: GraphAuthor, hashRoute: boolean, v41 = false) {
  const routedShape = (width: string): Axis[] => [...token, ['e', 'expert', 'K'], ['d', 'hidden', width]];
  weight(graph, 'router-weight', ['H', 'E']);
  graph.tensor('router-raw', sequence('E'), { dtype: fp32 });
  graph.tensor('affinities', sequence('E'), { dtype: fp32 });
  graph.node('router', 'FP32 MoE router projection', ['ffn-input', 'router-weight'], ['router-raw'], vectorWork('2 * B * Q * H * E'));
  graph.node('router-affinity', 'Square root of softplus router scores', ['router-raw'], ['affinities'], vectorWork('5 * B * Q * E'));
  graph.tensor('selected-experts', sequence('K'), { dtype: int32 });
  if (hashRoute) {
    weight(graph, 'token-expert-table', ['V', 'K'], int32);
    graph.node('hash-experts', 'Token ID to expert lookup', ['token-ids', 'token-expert-table'], ['selected-experts'], undefined,
      { accessBytes: { 'token-expert-table': '4 * B * Q * K' } });
  } else {
    weight(graph, 'router-bias', ['E'], fp32);
    graph.tensor('corrected', sequence('E'), { dtype: fp32 });
    graph.node('route-bias', 'Expert selection bias', ['affinities', 'router-bias'], ['corrected'], vectorWork('B * Q * E'));
    graph.node('route-topk', 'Select Top-K routed experts', ['corrected'], ['selected-experts'], vectorWork('3 * B * Q * E'));
  }
  graph.tensor('route-weights', sequence('K'), { dtype: fp32 });
  graph.node('route-normalize', 'Normalize selected original scores and apply route scale',
    ['affinities', 'selected-experts'], ['route-weights'], vectorWork(v41 ? 'B * Q * (3 * K + 1)' : '3 * B * Q * K'),
    { accessBytes: { affinities: '4 * B * Q * K' } });
  graph.tensor('dispatched', routedShape('H'));
  graph.node('route-dispatch', 'Dispatch tokens to selected experts', ['ffn-input', 'selected-experts'], ['dispatched']);
  const activeWeightBytes = '2 * min(E, B * Q * K) * H * I';
  for (const [path, groups] of [['routed', 'K'], ['shared', '1']] as const) {
    const routed = path === 'routed', route = routed ? ' * K' : '';
    const n = (suffix: string) => path + '-' + suffix;
    const shape = routed ? routedShape : sequence;
    for (const gate of ['gate', 'up', 'down'] as const) weight(graph, n(gate + '-weight'), routed ? ['E', 'H', 'I'] : ['H', 'I']);
    const input = routed ? 'dispatched' : 'ffn-input';
    for (const gate of ['gate', 'up'] as const) {
      graph.tensor(n(gate), shape('I'));
      const matrix = n(gate + '-weight');
      graph.node(n(gate + '-proj'), (routed ? 'Routed' : 'Shared') + ' expert ' + gate + ' projection',
        [input, matrix], [n(gate)], { useful: '2 * B * Q * ' + groups + ' * H * I' },
        routed ? { accessBytes: { [matrix]: activeWeightBytes } } : {});
    }
    graph.tensor(n('mix'), shape('I'));
    graph.node(n('swiglu'), 'Clamped SwiGLU' + (routed ? ' and route weighting' : ''),
      [n('gate'), n('up'), ...(routed ? ['route-weights'] : [])], [n('mix')],
      vectorWork((routed ? '8' : '7') + ' * B * Q * I' + route));
    graph.tensor(n('output'), shape('H'));
    graph.node(n('down-proj'), (routed ? 'Routed' : 'Shared') + ' expert down projection',
      [n('mix'), n('down-weight')], [n('output')], { useful: '2 * B * Q * ' + groups + ' * H * I' },
      routed ? { accessBytes: { [n('down-weight')]: activeWeightBytes } } : {});
  }
  graph.tensor('routed-reduced', hidden);
  graph.node('route-combine', 'Accumulate routed expert outputs', ['routed-output', 'selected-experts'], ['routed-reduced'],
    vectorWork('B * Q * K * H'));
  graph.tensor('ffn-output', hidden);
  graph.node('shared-add', 'Routed and shared expert merge', ['routed-reduced', 'shared-output'], ['ffn-output'], vectorWork('B * Q * H'));
}

export function makeDeepSeekV4Assets(): AssetDocument[] {
  const profile = loadDeepSeekV4();
  const parameters = [parameter('B', 1), parameter('Q', 4), parameter('C', 0, 0),
    ...Object.entries(profile.dimensions).map(([key, value]) => parameter(key, value))];
  const rootParams = [...parameters, parameter('Periods', profile.periods)];
  const equations = new Equations('builtin:formula:deepseek-v4', rootParams, deepSeekV4Sources);
  const base = { documentType: 'asset', schemaVersion: 1, revision: 1, sources: deepSeekV4Sources, tags: ['deepseek', 'deepseek-v4', 'text'] };
  const module = (id: string, name: string, graph: GraphTemplate) => AssetDocument.parse({
    ...base, assetId: 'builtin:module:deepseek-v4-' + id, name, parameters, definition: { kind: 'module', graph },
  });

  function decoder(ratio: 0 | 4 | 128, hashRoute: boolean) {
    const graph = new GraphAuthor(equations);
    graph.tensor('x', residual); graph.input('x');
    if (hashRoute) { graph.tensor('token-ids', token, { dtype: int64 }); graph.input('token-ids'); }
    hyperPre(graph, 'attn', 'x');
    addV4Attention(graph, ratio);
    hyperPost(graph, 'attn', 'x', 'attn-output', 'attention-residual');
    hyperPre(graph, 'ffn', 'attention-residual');
    addV4Moe(graph, hashRoute);
    hyperPost(graph, 'ffn', 'attention-residual', 'ffn-output', 'y');
    graph.output('y');
    const mode = ratio === 0 ? '滑窗' : ratio === 4 ? 'CSA · R4' : 'HCA · R128';
    return module('decoder-' + ratio + (hashRoute ? '-hash' : ''), mode + (hashRoute ? ' · 哈希路由' : ''), graph.graph);
  }

  const windowHash = decoder(0, true), csaHash = decoder(4, true), hca = decoder(128, false), csa = decoder(4, false);
  const periodGraph = new GraphAuthor(equations);
  periodGraph.tensor('x', residual); periodGraph.input('x');
  periodGraph.tensor('after-hca', residual); periodGraph.tensor('y', residual);
  periodGraph.module('hca', hca.name, hca, 'x', 'after-hca', parameters);
  periodGraph.module('csa', csa.name, csa, 'after-hca', 'y', parameters);
  periodGraph.output('y');
  const period = module('period', 'HCA → CSA 解码周期', periodGraph.graph);

  const graph = new GraphAuthor(equations);
  graph.tensor('token-ids', token, { dtype: int64 }); graph.input('token-ids');
  weight(graph, 'embedding-weight', ['V', 'H']);
  graph.tensor('embedding', hidden); graph.tensor('expanded', residual);
  graph.node('embedding', 'Token embedding lookup', ['token-ids', 'embedding-weight'], ['embedding'], undefined,
    { accessBytes: { 'embedding-weight': '2 * B * Q * H' } });
  graph.node('hyper-expand', 'Replicate embedding into hyper-connection streams', ['embedding'], ['expanded']);
  graph.tensor('after-window', residual); graph.tensor('after-hash', residual); graph.tensor('decoder-output', residual);
  graph.modulePorts('window-hash', windowHash.name, windowHash,
    { x: 'expanded', 'token-ids': 'token-ids' }, { y: 'after-window' }, parameters, repeat(equations.value('2', 'count')));
  graph.modulePorts('csa-hash', csaHash.name, csaHash,
    { x: 'after-window', 'token-ids': 'token-ids' }, { y: 'after-hash' }, parameters);
  graph.module('decoder', period.name, period, 'after-hash', 'decoder-output', parameters, repeat(symbol('Periods')));

  weight(graph, 'head-hc-fn', ['HC', 'HC * H'], fp32);
  weight(graph, 'head-hc-scale', ['1'], fp32); weight(graph, 'head-hc-base', ['HC'], fp32);
  graph.tensor('head-hc-output', hidden);
  graph.node('head-hc', 'Project, gate and reduce the final residual streams',
    ['decoder-output', 'head-hc-fn', 'head-hc-scale', 'head-hc-base'], ['head-hc-output'],
    vectorWork('B * Q * (2 * HC * HC * H + 4 * HC * H + 6 * HC + H * (2 * HC - 1))'));
  weight(graph, 'final-norm-weight', ['H'], fp32);
  graph.tensor('normalized', hidden);
  graph.node('final-rmsnorm', 'Final RMSNorm', ['head-hc-output', 'final-norm-weight'], ['normalized'], vectorWork('5 * B * Q * H'));
  weight(graph, 'lm-head-weight', ['V', 'H'], fp32);
  graph.tensor('logits', [['b', 'batch', 'B'], ['v', 'vocab', 'V']], { dtype: fp32 });
  graph.node('lm-head', 'Last-token untied FP32 output head', ['normalized', 'lm-head-weight'], ['logits'],
    vectorWork('2 * B * H * V'), { accessBytes: { normalized: '2 * B * H' } });
  graph.output('logits');

  const model = AssetDocument.parse({
    ...base, assetId: 'builtin:model:deepseek-v4-flash', name: 'DeepSeek-V4-Flash · 文本解码器', parameters: rootParams,
    definition: {
      kind: 'model', family: 'deepseek-v4', variant: 'flash-text-bf16', graph: graph.graph,
      assumptions: deepSeekV4Sources.flatMap(source => source.kind === 'note' ? [source.text] : []),
      workloadBindings: (['prefill', 'decode'] as const).flatMap(phase => [
        { phase, parameterKey: 'B', value: symbol('batchSize') },
        { phase, parameterKey: 'Q', value: symbol('queryTokensPerRequest') },
        { phase, parameterKey: 'C', value: symbol(phase === 'prefill' ? 'pastTokensPerRequest' : 'contextTokensPerRequest') },
      ]),
    },
  });
  return [model, period, windowHash, csaHash, hca, csa, ...equations.assets];
}
