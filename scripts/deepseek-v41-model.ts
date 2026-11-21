import { AssetDocument, type GraphTemplate } from '@model-analyser/contracts';
import { Equations, GraphAuthor, fp32, int64, literal, symbol } from './model-authoring.js';
import { int32, sequence, vectorWork, weight } from './deepseek-v4-attention.js';
import { addV4Moe, hidden, hyperCoefficients, hyperInput, hyperPost, parameter, residual, token } from './deepseek-v4-model.js';
import { addV41Attention, cacheState, cacheTensor, candidateTensor, selectedRows, type Ratio, type SparseBranch } from './deepseek-v41-attention.js';
import { addEngramHash, addEngramLookup, engramHashes, hashesPort, type EngramLayer } from './deepseek-v41-engram.js';
import { deepSeekV41Sources, loadDeepSeekV41 } from './deepseek-v41-profile.js';

const preShape = sequence('HC');
type Stream = { x: string; pre: string };
type Module = AssetDocument & { definition: Extract<AssetDocument['definition'], { kind: 'module' }> };
const flowRepeat = (count: number): NonNullable<GraphTemplate['nodes'][number]['repeat']> => ({
  axis: 'layer', count: literal(count), wiring: 'chain',
  carry: [{ inputPortId: 'x', outputPortId: 'y' }, { inputPortId: 'pre', outputPortId: 'pre-next' }],
});

function streamTensors(graph: GraphAuthor, stream: Stream, input = false) {
  graph.tensor(stream.x, residual); graph.tensor(stream.pre, preShape, { dtype: fp32 });
  if (input) { graph.input(stream.x, 'x'); graph.input(stream.pre, 'pre'); }
  return stream;
}
function exit(graph: GraphAuthor, stream: Stream) {
  graph.output(stream.x, 'y'); graph.output(stream.pre, 'pre-next');
}
function sharedPair(graph: GraphAuthor, ratio: Ratio, input = false) {
  for (const cache of ['main', 'index'] as const) {
    cacheTensor(graph, cache, ratio); cacheState(graph, cache, ratio);
    if (input) graph.input(cache + '-cache');
  }
}

export function makeDeepSeekV41Assets(revision: 1 | 2 = 1): AssetDocument[] {
  const profile = loadDeepSeekV41();
  const parameters = [parameter('B', 1), parameter('Q', 4), parameter('C', 0, 0),
    ...Object.entries(profile.dimensions).map(([key, value]) => parameter(key, value))];
  const parallel = revision === 2;
  const equations = new Equations('builtin:formula:deepseek-v41', parallel ? [...parameters, parameter('RouteSlots', 0, 0)] : parameters,
    deepSeekV41Sources, parallel ? new Map([['RouteSlots', 'K']]) : undefined);
  const base = { documentType: 'asset', schemaVersion: 1, revision, sources: deepSeekV41Sources, tags: ['deepseek', 'deepseek-v41', 'text'] };
  const modules: Module[] = [];
  function define(id: string, name: string, graph: GraphAuthor) {
    const asset = AssetDocument.parse({
      ...base, assetId: 'builtin:module:deepseek-v41-' + id, name, parameters, definition: { kind: 'module', graph: graph.graph },
    });
    if (asset.definition.kind !== 'module') throw Error('Expected decoder module');
    const module: Module = { ...asset, definition: asset.definition };
    modules.push(module);
    return module;
  }
  function call(graph: GraphAuthor, id: string, asset: Module, from: Stream, to: Stream, count?: number) {
    streamTensors(graph, to);
    const { inputs, outputs, states } = asset.definition.graph;
    const portMap = (ports: GraphTemplate['inputs'], mapping: Record<string, string>) =>
      Object.fromEntries(ports.map(({ portId }) => [portId, mapping[portId] ?? portId]));
    const stateBindings = states.filter(row => graph.graph.states.some(parent => parent.stateId === row.stateId))
      .map(row => ({ localStateId: row.stateId, parentStateId: row.stateId }));
    graph.modulePorts(id, asset.name, asset, portMap(inputs, { x: from.x, pre: from.pre }),
      portMap(outputs, { y: to.x, 'pre-next': to.pre }), parameters, count ? flowRepeat(count) : undefined, stateBindings);
    return to;
  }
  function block(id: string, name: string, sparse?: SparseBranch, engram?: EngramLayer) {
    const graph = new GraphAuthor(equations);
    streamTensors(graph, { x: 'x', pre: 'pre' }, true);
    const attentionResidual = engram ? addEngramLookup(graph, engram) : 'x';
    hyperCoefficients(graph, 'attn', attentionResidual);
    hyperInput(graph, 'attn', attentionResidual, 'pre', true);
    addV41Attention(graph, sparse, parallel);
    hyperPost(graph, 'attn', attentionResidual, 'attn-output', 'attention-residual');
    hyperCoefficients(graph, 'ffn', 'attention-residual');
    hyperInput(graph, 'ffn', 'attention-residual', 'attn-hc-pre', true);
    addV4Moe(graph, false, true, parallel);
    hyperPost(graph, 'ffn', 'attention-residual', 'ffn-output', 'y');
    exit(graph, { x: 'y', pre: 'ffn-hc-pre' });
    return define('block-' + id, name, graph);
  }
  const window = block('window', '滑窗解码层');
  const windowEngram = block('window-engram', '滑窗解码层 + Engram', undefined, 1);
  const r2Source = block('r2-source', 'CSA2 R2 · 生成 KV 与索引', { ratio: 2, mode: 'source' });
  const r2Engram = block('r2-engram', 'CSA2 R2 · 生成 KV 与索引 + Engram', { ratio: 2, mode: 'source' }, 14);
  const r2Reuse = block('r2-reuse', 'CSA2 R2 · 复用 KV 与选中位置', { ratio: 2, mode: 'reuse' });
  const candidate = block('r1-candidate', 'CSA2 R1 · 生成 KV、索引与候选块', { ratio: 1, mode: 'candidate' });
  const reindex = block('r1-reindex', 'CSA2 R1 · 应用候选块并重算索引', { ratio: 1, mode: 'reindex' });
  const r1Reuse = block('r1-reuse', 'CSA2 R1 · 复用 KV 与选中位置', { ratio: 1, mode: 'reuse' });

  function r2Stage(owner: Module, engram: boolean) {
    const graph = new GraphAuthor(equations);
    const start = streamTensors(graph, { x: 'x', pre: 'pre' }, true);
    if (engram) {
      const hashes = hashesPort(14);
      graph.tensor(hashes, engramHashes, { dtype: int64 }); graph.input(hashes);
    }
    sharedPair(graph, 2);
    graph.tensor('selected-rows', selectedRows(2), { dtype: int32 });
    const published = call(graph, 'source', owner, start, { x: 'published-x', pre: 'published-pre' });
    exit(graph, call(graph, 'reuse', r2Reuse, published, { x: 'y', pre: 'out-pre' }, 5));
    return define(engram ? 'r2-stage-engram' : 'r2-stage', engram ? 'CSA2 R2 阶段 + Engram' : 'CSA2 R2 阶段', graph);
  }
  const normalR2 = r2Stage(r2Source, false), engramR2 = r2Stage(r2Engram, true);

  const reindexGraph = new GraphAuthor(equations);
  const reindexStart = streamTensors(reindexGraph, { x: 'x', pre: 'pre' }, true);
  sharedPair(reindexGraph, 1, true);
  candidateTensor(reindexGraph); reindexGraph.input('candidate-mask');
  reindexGraph.tensor('selected-rows', selectedRows(1), { dtype: int32 });
  const reindexOutput = call(reindexGraph, 'source', reindex, reindexStart, { x: 'reindex-x', pre: 'reindex-pre' });
  exit(reindexGraph, call(reindexGraph, 'reuse', r1Reuse, reindexOutput, { x: 'y', pre: 'out-pre' }, 3));
  const reindexStage = define('r1-reindex-stage', 'CSA2 R1 重算索引周期', reindexGraph);

  const r1Graph = new GraphAuthor(equations);
  const r1Start = streamTensors(r1Graph, { x: 'x', pre: 'pre' }, true);
  sharedPair(r1Graph, 1);
  candidateTensor(r1Graph); r1Graph.tensor('selected-rows', selectedRows(1), { dtype: int32 });
  const r1Owner = call(r1Graph, 'candidate-source', candidate, r1Start, { x: 'candidate-x', pre: 'candidate-pre' });
  const firstGroup = call(r1Graph, 'reuse', r1Reuse, r1Owner, { x: 'group-x', pre: 'group-pre' }, 3);
  exit(r1Graph, call(r1Graph, 'reindex', reindexStage, firstGroup, { x: 'y', pre: 'out-pre' }, 4));
  const r1Stage = define('r1-stage', 'CSA2 R1 候选与索引复用阶段', r1Graph);

  const graph = new GraphAuthor(equations);
  graph.tensor('tokens', token, { dtype: int64 }); graph.input('tokens');
  addEngramHash(graph);
  weight(graph, 'embedding-weight', ['V', 'H']);
  graph.tensor('embedded', hidden);
  graph.node('embedding', 'Token embedding lookup', ['tokens', 'embedding-weight'], ['embedded'], undefined,
    { accessBytes: { 'embedding-weight': '2 * B * Q * H' } });
  const start = streamTensors(graph, { x: 'expanded', pre: 'initial-pre' });
  graph.node('hyper-expand', 'Replicate token embeddings to the residual streams', ['embedded'], ['expanded']);
  graph.node('initial-mix', 'Initialize the first attention input with a one-hot mix', [], ['initial-pre']);
  const stem = call(graph, 'window', window, start, { x: 'window-x', pre: 'window-pre' });
  const engramStem = call(graph, 'window-engram', windowEngram, stem, { x: 'engram-x', pre: 'engram-pre' });
  const pairs = call(graph, 'r2', normalR2, engramStem, { x: 'r2-x', pre: 'r2-pre' }, 2);
  const third = call(graph, 'r2-engram', engramR2, pairs, { x: 'r2-engram-x', pre: 'r2-engram-pre' });
  const final = call(graph, 'r1', r1Stage, third, { x: 'decoder-x', pre: 'decoder-pre' });
  graph.tensor('collapsed', hidden);
  graph.node('final-mix', 'Collapse the final streams using the last MoE mix', [final.x, final.pre], ['collapsed'],
    vectorWork('B * Q * H * (2 * HC - 1)'));
  weight(graph, 'final-norm-weight', ['H']);
  graph.tensor('normalized', hidden);
  graph.node('final-rmsnorm', 'Final RMSNorm', ['collapsed', 'final-norm-weight'], ['normalized'], vectorWork('5 * B * Q * H'));
  weight(graph, 'lm-head-weight', ['V', 'H'], fp32);
  graph.tensor('logits', [['b', 'batch', 'B'], ['v', 'vocab', 'V']], { dtype: fp32 });
  graph.node('lm-head', 'Last-token untied FP32 output head', ['normalized', 'lm-head-weight'], ['logits'],
    vectorWork('2 * B * H * V'), { accessBytes: { normalized: '2 * B * H' } });
  graph.output('logits');

  const model = AssetDocument.parse({
    ...base, assetId: 'builtin:model:deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash · 文本解码器', parameters,
    definition: {
      kind: 'model', family: 'deepseek-v41', variant: 'flash-text-bf16', graph: graph.graph,
      assumptions: deepSeekV41Sources.flatMap(source => source.kind === 'note' ? [source.text] : []),
      workloadBindings: (['prefill', 'decode'] as const).flatMap(phase => [
        { phase, parameterKey: 'B', value: symbol('batchSize') },
        { phase, parameterKey: 'Q', value: symbol('queryTokensPerRequest') },
        { phase, parameterKey: 'C', value: symbol(phase === 'prefill' ? 'pastTokensPerRequest' : 'contextTokensPerRequest') },
      ]),
    },
  });
  return [model, ...modules, ...equations.assets];
}
