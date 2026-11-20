import { AssetDocument, type GraphTemplate } from '@model-analyser/contracts';
import { Equations, GraphAuthor, fp32, int64, literal, symbol } from './model-authoring.js';
import { hidden, parameter, token } from './deepseek-v4-model.js';
import { int32, sequence, vectorWork, weight, type Axis } from './deepseek-v4-attention.js';
import { addGlm52Attention, selectedRows } from './glm52-attention.js';
import { glm52Sources, loadGlm52 } from './glm52-profile.js';
import { addSwiGlu } from './qwen-hybrid-model.js';

function addGlm52Moe(graph: GraphAuthor) {
  const routed = (width: string): Axis[] => [...token, ['e', 'expert', 'K'], ['d', 'hidden', width]];
  weight(graph, 'router-weight', ['H', 'E']);
  weight(graph, 'route-bias', ['E'], fp32);
  for (const id of ['router-logits', 'router-affinities', 'router-corrected']) graph.tensor(id, sequence('E'), { dtype: fp32 });
  graph.tensor('expert-ids', sequence('K'), { dtype: int32 });
  graph.tensor('expert-weights', sequence('K'), { dtype: fp32 });
  graph.node('router', 'FP32 routing projection', ['ffn-input', 'router-weight'], ['router-logits'],
    vectorWork('2 * B * Q * H * E'));
  graph.node('router-sigmoid', 'Sigmoid expert affinities', ['router-logits'], ['router-affinities'], vectorWork('4 * B * Q * E'));
  graph.node('router-bias', 'Add selection-only correction bias', ['router-affinities', 'route-bias'], ['router-corrected'],
    vectorWork('B * Q * E'));
  graph.node('route-topk', 'Select TopK experts in the single routing group', ['router-corrected'], ['expert-ids'], vectorWork('3 * B * Q * E'));
  graph.node('route-normalize', 'Normalize original affinities and apply the 2.5 route scale', ['router-affinities', 'expert-ids'],
    ['expert-weights'], vectorWork('3 * B * Q * K'), { accessBytes: { 'router-affinities': '4 * B * Q * K' } });
  graph.tensor('expert-input', routed('H'));
  graph.node('dispatch', 'Dispatch to selected routed experts', ['ffn-input', 'expert-ids'], ['expert-input']);

  weight(graph, 'expert-gate-weight', ['E', 'H', 'J']); weight(graph, 'expert-up-weight', ['E', 'H', 'J']);
  weight(graph, 'expert-down-weight', ['E', 'J', 'H']);
  graph.tensor('expert-gate-up-output', routed('2 * J')); graph.tensor('expert-activation', routed('J'));
  const expertRead = '2 * min(E, B * Q * K) * H * J';
  graph.node('expert-gate-up', 'Routed expert gate and up projections', ['expert-input', 'expert-gate-weight', 'expert-up-weight'],
    ['expert-gate-up-output'], { useful: '4 * B * Q * K * H * J' },
    { accessBytes: { 'expert-gate-weight': expertRead, 'expert-up-weight': expertRead } });
  graph.node('expert-silu', 'Routed expert SiLU(gate) × up', ['expert-gate-up-output'], ['expert-activation'],
    vectorWork('6 * B * Q * K * J'));
  graph.tensor('expert-output', routed('H')); graph.tensor('routed-output', hidden);
  graph.node('expert-down', 'Routed expert down projections', ['expert-activation', 'expert-down-weight'], ['expert-output'],
    { useful: '2 * B * Q * K * H * J' }, { accessBytes: { 'expert-down-weight': expertRead } });
  graph.node('combine', 'Weighted sum of routed expert outputs', ['expert-output', 'expert-weights'], ['routed-output'],
    vectorWork('B * Q * H * (2 * K - 1)'));
  addSwiGlu(graph, 'J', 'shared', 'ffn-input', 'shared-output');
  graph.tensor('ffn-output', hidden);
  graph.node('shared-add', 'Add routed and shared expert outputs', ['routed-output', 'shared-output'], ['ffn-output'],
    vectorWork('B * Q * H'));
}

export function makeGlm52Assets(): AssetDocument[] {
  const schedule = loadGlm52();
  const parameters = [parameter('B', 1), parameter('Q', 4), parameter('C', 0, 0),
    ...schedule.dimensions.map(([name, value]) => parameter(name, value))];
  const equations = new Equations('builtin:formula:glm-5.2', parameters, glm52Sources);
  const base = { documentType: 'asset' as const, schemaVersion: 1 as const, revision: 1, sources: glm52Sources,
    tags: ['glm', 'glm-5.2', 'dsa', 'sparse-mla', 'bf16'] };
  function define(id: string, name: string, body: GraphAuthor) {
    return AssetDocument.parse({ ...base, assetId: 'builtin:module:glm-5.2-' + id, name, parameters,
      definition: { kind: 'module', graph: body.graph } });
  }
  function norm(graph: GraphAuthor, id: string, name: string, input: string, output: string) {
    weight(graph, id + '-weight', ['H']); graph.tensor(output, hidden);
    graph.node(id, name, [input, id + '-weight'], [output], vectorWork('5 * B * Q * H'));
  }
  function block(id: string, name: string, ownsIndex: boolean, moe: boolean) {
    const graph = new GraphAuthor(equations);
    graph.tensor('x', hidden); graph.input('x');
    if (!ownsIndex) { graph.tensor('selected-rows', selectedRows, { dtype: int32 }); graph.input('selected-rows'); }
    norm(graph, 'input-rmsnorm', 'Attention input RMSNorm', 'x', 'attn-input');
    addGlm52Attention(graph, ownsIndex);
    graph.tensor('residual-attention', hidden);
    graph.node('attention-residual', 'Attention residual add', ['x', 'attention-output'], ['residual-attention'], vectorWork('B * Q * H'));
    norm(graph, 'post-rmsnorm', 'Feed-forward input RMSNorm', 'residual-attention', 'ffn-input');
    if (moe) addGlm52Moe(graph);
    else addSwiGlu(graph, 'I', 'ffn', 'ffn-input', 'ffn-output');
    graph.tensor('y', hidden);
    graph.node('ffn-residual', 'Feed-forward residual add', ['residual-attention', 'ffn-output'], ['y'], vectorWork('B * Q * H'));
    graph.output('y');
    if (ownsIndex) graph.output('selected-rows');
    return define('block-' + id, name, graph);
  }
  const dense = block('dense', 'Dense Block · 重算索引', true, false);
  const full = block('full', 'MoE Block · 重算索引', true, true);
  const shared = block('shared', 'MoE Block · 复用索引', false, true);
  const repeat = (n: number): GraphTemplate['nodes'][number]['repeat'] => ({
    axis: 'layer', count: literal(n), wiring: 'chain', carry: [{ inputPortId: 'x', outputPortId: 'y' }],
  });
  const group = new GraphAuthor(equations);
  group.tensor('x', hidden); group.input('x');
  group.tensor('reindexed', hidden); group.tensor('selected-rows', selectedRows, { dtype: int32 });
  group.modulePorts('source', full.name, full, { x: 'x' }, { y: 'reindexed', 'selected-rows': 'selected-rows' }, parameters);
  group.tensor('y', hidden);
  group.modulePorts('reuse', shared.name, shared, { x: 'reindexed', 'selected-rows': 'selected-rows' }, { y: 'y' }, parameters, repeat(3));
  group.output('y');
  const stage = define('index-period', 'MoE 索引周期', group);

  const graph = new GraphAuthor(equations);
  graph.tensor('tokens', token, { dtype: int64 }); graph.input('tokens');
  weight(graph, 'embedding-weight', ['V', 'H']); graph.tensor('embedded', hidden);
  graph.node('embedding', 'Token embedding lookup', ['tokens', 'embedding-weight'], ['embedded'], undefined,
    { accessBytes: { 'embedding-weight': '2 * B * Q * H' } });
  graph.tensor('dense-output', hidden); graph.tensor('selected-rows', selectedRows, { dtype: int32 });
  graph.modulePorts('dense', dense.name, dense, { x: 'embedded' }, { y: 'dense-output', 'selected-rows': 'selected-rows' }, parameters, repeat(schedule.dense));
  graph.tensor('prefix-output', hidden);
  graph.modulePorts('shared-prefix', shared.name, shared, { x: 'dense-output', 'selected-rows': 'selected-rows' },
    { y: 'prefix-output' }, parameters, repeat(schedule.initialReuse));
  graph.tensor('decoder-output', hidden);
  graph.module('decoder', stage.name, stage, 'prefix-output', 'decoder-output', parameters, repeat(schedule.periods));
  norm(graph, 'final-rmsnorm', 'Final RMSNorm', 'decoder-output', 'normalized');
  weight(graph, 'lm-head-weight', ['V', 'H']); graph.tensor('logits', [...token, ['v', 'vocab', 'V']]);
  graph.node('lm-head', 'Untied full-position output projection', ['normalized', 'lm-head-weight'], ['logits'],
    { useful: '2 * B * Q * H * V' });
  graph.output('logits');

  const model = AssetDocument.parse({ ...base, assetId: 'builtin:model:glm-5.2', name: 'GLM-5.2 · 文本解码器', parameters,
    definition: { kind: 'model', family: 'glm-5.2', variant: 'sparse-absorbed-mla-bf16', graph: graph.graph,
      assumptions: glm52Sources.flatMap(source => source.kind === 'note' ? [source.text] : []),
      workloadBindings: (['prefill', 'decode'] as const).flatMap(phase => [
        { phase, parameterKey: 'B', value: symbol('batchSize') }, { phase, parameterKey: 'Q', value: symbol('queryTokensPerRequest') },
        { phase, parameterKey: 'C', value: symbol(phase === 'prefill' ? 'pastTokensPerRequest' : 'contextTokensPerRequest') },
      ]),
    },
  });
  return [model, dense, full, shared, stage, ...equations.assets];
}
