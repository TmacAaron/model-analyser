import { NodeId, StateId, StorageId, type GraphTemplate, type Shape } from '@model-analyser/contracts';
import { GraphAuthor, bf16, fp32, symbol, vector } from './model-authoring.js';

export type Axis = [string, Shape[number]['semantic'], string];
type DType = GraphTemplate['tensors'][number]['dtype'];
type Policy = GraphTemplate['states'][number]['updatePolicy'];
export const int32: DType = { category: 'int', bits: 32, format: 'int32' };
export const sequence = (width: string): Axis[] => [['b', 'batch', 'B'], ['q', 'token', 'Q'], ['d', 'hidden', width]];
export const heads = (count: string, width: string): Axis[] =>
  [['b', 'batch', 'B'], ['q', 'token', 'Q'], ['n', 'head', count], ['d', 'hidden', width]];
export const vectorWork = (useful: string, executed?: string) => ({ useful, ...(executed ? { executed } : {}), computeClass: vector });
export const weight = (graph: GraphAuthor, id: string, dimensions: string[], dtype = bf16) =>
  graph.tensor(id, dimensions.map((size, index) => ['w' + index, 'custom', size]), { category: 'weight', dtype });
export const extent = (length: string, width: string): Axis[] =>
  [['b', 'batch', 'B'], ['t', 'token', length], ['d', 'hidden', width]];
const completed = (length: string, ratio: number) => 'floor((' + length + ') / ' + ratio + ')';
const length = 'C + Q';

export function state(graph: GraphAuthor, id: string, kind: GraphTemplate['states'][number]['stateKind'],
  storages: string[], policy: Policy, writer: string, outputPorts: string[], reads: [string, string][]) {
  const port = ([nodeId, portId]: [string, string]) => ({ kind: 'node' as const, nodeId: NodeId.parse(nodeId), portId });
  graph.graph.states.push({
    stateId: StateId.parse(id), name: id, stateKind: kind, allocationBasis: 'step_end',
    storageIds: storages.map(id => StorageId.parse(id)), creator: { kind: 'initialized' },
    updatePolicy: policy, writers: outputPorts.map(output => port([writer, output])), readers: reads.map(port),
  });
}

function addCompressor(graph: GraphAuthor, prefix: 'main' | 'index', ratio: 4 | 128, width: 'D' | 'ID', reader: string) {
  const overlap = ratio === 4 ? 2 : 1;
  const doubled = overlap + ' * ' + width;
  const n = (suffix: string) => prefix + '-' + suffix;
  const value = n('value-state'), score = n('score-state'), valueNext = n('value-next'), scoreNext = n('score-next'), cache = n('cache');
  const added = '(' + completed(length, ratio) + ' - ' + completed('C', ratio) + ')';
  const ring = extent(String(overlap * ratio), doubled);
  for (const id of [value, score]) graph.tensor(id, ring, { dtype: fp32, category: 'state' });
  graph.tensor(valueNext, ring, { dtype: fp32, storageId: value });
  graph.tensor(scoreNext, ring, { dtype: fp32, storageId: score });
  weight(graph, n('value-weight'), ['H', doubled], fp32);
  weight(graph, n('score-weight'), ['H', doubled], fp32);
  weight(graph, n('position-weight'), [String(ratio), doubled], fp32);
  weight(graph, n('norm-weight'), [width], fp32);
  graph.tensor(n('values'), sequence(doubled), { dtype: fp32 });
  graph.tensor(n('scores'), sequence(doubled), { dtype: fp32 });
  graph.node(n('value-proj'), 'Compressor value projection', ['attn-input', n('value-weight')], [n('values')],
    vectorWork('2 * B * Q * H * (' + doubled + ')'));
  graph.node(n('score-proj'), 'Compressor gate projection', ['attn-input', n('score-weight')], [n('scores')],
    vectorWork('2 * B * Q * H * (' + doubled + ')'));
  const stateBytes = '4 * B * min(Q, ' + overlap * ratio + ') * (' + doubled + ')';
  graph.node(n('pending'), 'Keep FP32 compressor values and scores', [n('values'), n('scores'), n('position-weight')], [valueNext, scoreNext],
    vectorWork('B * Q * (' + doubled + ')'), { accessBytes: { [valueNext]: stateBytes, [scoreNext]: stateBytes } });
  graph.tensor(n('pooled'), extent(added, width), { dtype: fp32 });
  const historyReads = '4 * B * min(C, ' + overlap * ratio + ' * ' + added + ') * (' + doubled + ')';
  graph.node(n('pool'), (ratio === 4 ? 'Overlapping' : 'Block') + ' softmax pooling R' + ratio,
    [n('values'), n('scores'), n('position-weight'), value, score], [n('pooled')],
    vectorWork('7 * B * ' + added + ' * ' + (overlap * ratio) + ' * ' + width), {
      accessBytes: { [value]: historyReads, [score]: historyReads },
    });
  graph.tensor(n('normalized'), extent(added, width));
  graph.node(n('norm'), 'Compressed RMSNorm', [n('pooled'), n('norm-weight')], [n('normalized')],
    vectorWork('5 * B * ' + added + ' * ' + width));
  graph.tensor(n('rotated'), extent(added, width));
  graph.node(n('rope'), 'Compressed position RoPE', [n('normalized')], [n('rotated')],
    vectorWork('3 * B * ' + added + ' * R'));
  graph.tensor(cache, extent(completed(length, ratio), width), { category: 'state' });
  graph.node(n('write'), prefix === 'index' ? 'Hadamard and FP4 simulation; append index rows' : 'FP8 simulation; append BF16 latent rows',
    [n('rotated')], [cache], vectorWork('B * ' + added + ' * ' + (prefix === 'index' ? '9 * ID' : '2 * (D - R)')), {
      accessBytes: { [cache]: '2 * B * ' + added + ' * ' + width },
    });
  // Pooling reads the carried buffers before they are overwritten by the current chunk.
  graph.graph.dependencies.push({ edgeId: n('preserve-history'), fromNodeId: NodeId.parse(n('pool')), toNodeId: NodeId.parse(n('pending')), kind: 'control' });
  state(graph, n('compressor-history'), 'recurrent', [value, score], { kind: 'replace' }, n('pending'),
    [valueNext, scoreNext], [[n('pool'), value], [n('pool'), score]]);
  state(graph, n('completed'), prefix === 'index' ? 'indexer' : 'latent', [cache], { kind: 'append', tokensPerRow: ratio }, n('write'),
    [cache], prefix === 'main' ? [[reader, cache], ['sparse-av', cache]] : [[reader, cache]]);
  return cache;
}

export function windowTotal(tokens: string) {
  return '(min(W, ' + tokens + ') * (min(W, ' + tokens + ') + 1) / 2 + max(0, (' + tokens + ') - W) * W)';
}

/** Sum of complete groups visible at positions 1..length, with an optional Top-K cap. */
export function groupTotal(tokens: string, ratio: number, capped: boolean) {
  const n = capped ? 'min(' + tokens + ', ' + ratio + ' * IK - 1)' : '(' + tokens + ')';
  const groups = completed(n, ratio);
  const uncapped = ratio + ' * ' + groups + ' * (' + groups + ' - 1) / 2 + ' + groups + ' * (' + n + ' - ' + ratio + ' * ' + groups + ' + 1)';
  return '(' + uncapped + (capped ? ' + ((' + tokens + ') - ' + n + ') * IK' : '') + ')';
}

export function prepareV4Attention(graph: GraphAuthor, v41 = false) {
  const qType = heads('N', 'D'), norm = v41 ? bf16 : fp32;
  weight(graph, 'qa-weight', ['H', 'QR']); weight(graph, 'qb-weight', ['QR', 'N', 'D']);
  weight(graph, 'qr-norm-weight', ['QR'], norm);
  graph.tensor('qa', sequence('QR')); graph.tensor('qr', sequence('QR')); graph.tensor('q0', qType);
  graph.node('q-a', 'Query low-rank projection', ['attn-input', 'qa-weight'], ['qa'], { useful: '2 * B * Q * H * QR' });
  graph.node('q-rmsnorm', 'Query-rank RMSNorm', ['qa', 'qr-norm-weight'], ['qr'], vectorWork('5 * B * Q * QR'));
  graph.node('q-b', 'Query head projection', ['qr', 'qb-weight'], ['q0'], { useful: '2 * B * Q * QR * N * D' });
  if (!v41) graph.tensor('q-normed', qType);
  graph.tensor('q', qType);
  if (!v41) graph.node('q-head-rmsnorm', 'Per-head RMS normalization', ['q0'], ['q-normed'], vectorWork('4 * B * Q * N * D'));
  graph.node('q-rope', 'Query partial RoPE', [v41 ? 'q0' : 'q-normed'], ['q'], vectorWork('3 * B * Q * N * R'));
  weight(graph, 'kv-weight', ['H', 'D']); weight(graph, 'kv-norm-weight', ['D'], norm);
  for (const id of ['kv0', 'kv-normalized', 'kv-rotated']) graph.tensor(id, sequence('D'));
  graph.node('kv-project', 'Shared key/value projection', ['attn-input', 'kv-weight'], ['kv0'], { useful: '2 * B * Q * H * D' });
  graph.node('kv-rmsnorm', 'Key/value RMSNorm', ['kv0', 'kv-norm-weight'], ['kv-normalized'], vectorWork('5 * B * Q * D'));
  graph.node('kv-rope', 'Key/value partial RoPE', ['kv-normalized'], ['kv-rotated'], vectorWork('3 * B * Q * R'));
  graph.tensor('window-cache', extent('W', 'D'), { category: 'state' });
  graph.tensor('window-next', extent('W', 'D'), { storageId: 'window-cache' });
  graph.tensor('window-current', sequence('D'));
  graph.node('window-fake-quant', v41 ? 'Simulate FP8 on the full window latent' : 'Simulate FP8 on the non-rotary KV dimensions',
    ['kv-rotated'], ['window-current'], vectorWork(v41 ? '2 * B * Q * D' : '2 * B * Q * (D - R)'));
  graph.node('window-write', 'Retain the newest rows in the sliding KV ring', ['window-current'], ['window-next'],
    undefined, { accessBytes: { 'window-next': '2 * B * min(Q, W) * D', 'window-current': '2 * B * min(Q, W) * D' } });
  graph.graph.dependencies.push({ edgeId: 'read-window-before-update', fromNodeId: NodeId.parse('sparse-av'),
    toNodeId: NodeId.parse('window-write'), kind: 'control' });
  state(graph, 'window', 'window', ['window-cache'], { kind: 'windowed', window: symbol('W'), reserveFullWindow: true }, 'window-write',
    ['window-next'], [['sparse-qk', 'window-cache'], ['sparse-av', 'window-cache']]);

}

export function addV4Attention(graph: GraphAuthor, ratio: 0 | 4 | 128) {
  prepareV4Attention(graph);
  const rows = completed(length, ratio || 1);
  const groupSlots = ratio === 4 ? 'min(IK, ' + rows + ')' : ratio ? rows : '0';
  const groupPairs = ratio ? '(' + groupTotal(length, ratio, ratio === 4) + ' - ' + groupTotal('C', ratio, ratio === 4) + ')' : '0';
  const sparseInputs: string[] = [];
  if (ratio) sparseInputs.push(addCompressor(graph, 'main', ratio, 'D', 'sparse-qk'));
  if (ratio === 4) {
    const index = addCompressor(graph, 'index', ratio, 'ID', 'index-score');
    weight(graph, 'index-q-weight', ['QR', 'IH', 'ID']); weight(graph, 'index-head-weight', ['H', 'IH']);
    graph.tensor('index-q-raw', heads('IH', 'ID')); graph.tensor('index-q', heads('IH', 'ID'));
    graph.tensor('index-weights', sequence('IH'));
    graph.node('index-query', 'Indexer query projection', ['qr', 'index-q-weight'], ['index-q-raw'], { useful: '2 * B * Q * QR * IH * ID' });
    graph.node('index-query-rope', 'Indexer query RoPE, Hadamard and FP4 simulation', ['index-q-raw'], ['index-q'], vectorWork('B * Q * IH * (3 * R + 9 * ID)'));
    graph.node('index-weight', 'Indexer head-weight projection', ['attn-input', 'index-head-weight'], ['index-weights'], { useful: '2 * B * Q * H * IH' });
    const scoreShape: Axis[] = [['b', 'batch', 'B'], ['q', 'token', 'Q'], ['n', 'head', 'IH'], ['t', 'token', rows]];
    graph.tensor('index-dot', scoreShape, { dtype: fp32 });
    const indexPairs = '(' + groupTotal(length, ratio, false) + ' - ' + groupTotal('C', ratio, false) + ')';
    graph.node('index-score', 'Causal indexer query-key scores', ['index-q', index], ['index-dot'],
      { useful: '2 * B * IH * ID * ' + indexPairs, executed: '2 * B * Q * IH * ID * ' + rows });
    graph.tensor('index-ranked', [['b', 'batch', 'B'], ['q', 'token', 'Q'], ['t', 'token', rows]], { dtype: fp32 });
    graph.node('index-reduce', 'ReLU and weighted index head sum', ['index-dot', 'index-weights'], ['index-ranked'],
      vectorWork('3 * B * IH * ' + indexPairs, '3 * B * Q * IH * ' + rows));
    graph.tensor('indices', [['b', 'batch', 'B'], ['q', 'token', 'Q'], ['k', 'custom', groupSlots]], { dtype: int32 });
    graph.node('index-topk', 'Causal Top-K compressed row selection', ['index-ranked'], ['indices'],
      vectorWork('3 * B * ' + indexPairs, '3 * B * Q * ' + rows));
    sparseInputs.push('indices');
  }

  finishV4Attention(graph, groupSlots, groupPairs, sparseInputs,
    ratio ? { 'main-cache': '2 * B * D * min(' + rows + ', ' + groupPairs + ')' } : {});
}

export function finishV4Attention(graph: GraphAuthor, groupSlots: string, groupPairs: string, extraInputs: string[],
  extraReads: Record<string, string>, quantizeOutput = false) {
  const winSlots = 'min(W, C + Q)', winPairs = '(' + windowTotal(length) + ' - ' + windowTotal('C') + ')';
  const slots = '(' + winSlots + ' + ' + groupSlots + ')', pairs = '(' + winPairs + ' + ' + groupPairs + ')';
  const sparseInputs = ['window-current', 'window-cache', ...extraInputs], qType = heads('N', 'D');
  const scores: Axis[] = [['b', 'batch', 'B'], ['q', 'token', 'Q'], ['n', 'head', 'N'], ['s', 'custom', slots]];
  graph.tensor('scores', scores, { dtype: fp32 }); graph.tensor('probabilities', scores, { dtype: fp32 });
  graph.tensor('attended', qType); graph.tensor('attended-rotated', qType);
  weight(graph, 'sink-weight', ['N'], fp32);
  const attentionWork = { useful: '2 * B * N * D * ' + pairs, executed: '2 * B * Q * N * D * ' + slots };
  const reads = {
    'window-current': '2 * B * Q * D', 'window-cache': '2 * B * D * min(W - 1, C)',
    ...extraReads,
  };
  graph.node('sparse-qk', 'Sparse QK over sliding and compressed rows', ['q', ...sparseInputs], ['scores'], attentionWork, { accessBytes: reads });
  graph.node('sink-softmax', 'Causal masked softmax with attention sink', ['scores', 'sink-weight'], ['probabilities'],
    vectorWork('5 * B * N * (' + pairs + ' + Q)', '5 * B * Q * N * (' + slots + ' + 1)'));
  graph.node('sparse-av', 'Sparse probability-weighted value sum', ['probabilities', ...sparseInputs], ['attended'], attentionWork, { accessBytes: reads });
  graph.node('output-rope', 'Inverse output RoPE', ['attended'], ['attended-rotated'], vectorWork('3 * B * Q * N * R'));
  if (quantizeOutput) {
    graph.tensor('attended-quantized', qType);
    graph.node('output-fake-quant', 'Simulate FP8 before grouped output projection',
      ['attended-rotated'], ['attended-quantized'], vectorWork('2 * B * Q * N * D'));
  }
  weight(graph, 'group-out-weight', ['N * D / OG', 'OG', 'OR']);
  weight(graph, 'out-weight', ['OG', 'OR', 'H']);
  graph.tensor('group-output', sequence('OG * OR')); graph.tensor('attn-output', sequence('H'));
  graph.node('group-output-proj', 'Grouped low-rank output projection', [quantizeOutput ? 'attended-quantized' : 'attended-rotated', 'group-out-weight'], ['group-output'],
    { useful: '2 * B * Q * N * D * OR' });
  graph.node('output-proj', 'Attention output projection', ['group-output', 'out-weight'], ['attn-output'],
    { useful: '2 * B * Q * OG * OR * H' });
}
