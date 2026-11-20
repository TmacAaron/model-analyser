import { NodeId, StateId, StorageId, type GraphTemplate } from '@model-analyser/contracts';
import { GraphAuthor, fp32 } from './model-authoring.js';
import { extent, finishV4Attention, groupTotal, heads, int32, prepareV4Attention, sequence, state, vectorWork, weight, type Axis } from './deepseek-v4-attention.js';

export type Ratio = 1 | 2;
export type SharedCache = 'main' | 'index';
export type SparseBranch = { ratio: Ratio; mode: 'source' | 'candidate' | 'reindex' | 'reuse' };
const predicate = { category: 'uint' as const, bits: 8, format: 'bool' };
const groups = (tokens: string, ratio: Ratio) => ratio === 1 ? '(' + tokens + ')' : 'floor((' + tokens + ') / 2)';
const cacheRows = (ratio: Ratio) => groups('C + Q', ratio);
const newlyCompleted = (ratio: Ratio) => ratio === 1 ? 'Q' : '(' + cacheRows(ratio) + ' - ' + groups('C', ratio) + ')';

export const selectedRows = (ratio: Ratio): Axis[] =>
  [['b', 'batch', 'B'], ['q', 'token', 'Q'], ['k', 'custom', 'min(IK, ' + cacheRows(ratio) + ')']];
const scoreRows = (ratio: Ratio): Axis[] => [['b', 'batch', 'B'], ['q', 'token', 'Q'], ['t', 'token', cacheRows(ratio)]];
const cachePolicy = (cache: SharedCache, ratio: Ratio): GraphTemplate['states'][number]['updatePolicy'] =>
  ({ kind: 'append', ...(ratio === 2 || cache === 'index' ? { tokensPerRow: ratio } : {}) });
const cacheId = (cache: SharedCache) => cache + '-cache';
export function cacheTensor(graph: GraphAuthor, cache: SharedCache, ratio: Ratio) {
  graph.tensor(cacheId(cache), extent(cacheRows(ratio), cache === 'main' ? 'D' : 'ID'), { category: 'state' });
}
export function cacheState(graph: GraphAuthor, cache: SharedCache, ratio: Ratio, readers: string[] = [], writer?: string) {
  const id = cacheId(cache);
  const port = (nodeId: string) => ({ kind: 'node' as const, nodeId: NodeId.parse(nodeId), portId: id });
  graph.graph.states.push({
    stateId: StateId.parse(id), name: id, stateKind: cache === 'main' ? 'latent' : 'indexer',
    allocationBasis: 'step_end', creator: { kind: 'initialized' }, storageIds: [StorageId.parse(id)],
    updatePolicy: cachePolicy(cache, ratio), readers: readers.map(port), writers: writer ? [port(writer)] : [],
  });
}
export function candidateTensor(graph: GraphAuthor) {
  graph.tensor('candidate-mask', scoreRows(1), { dtype: predicate });
}

function compress(graph: GraphAuthor, ratio: Ratio) {
  const current = newlyCompleted(ratio), normWeight = weight(graph, 'main-norm-weight', ['D']);
  weight(graph, 'main-value-weight', ['H', 'D'], ratio === 2 ? fp32 : undefined);
  graph.tensor('main-values', sequence('D'), ratio === 2 ? { dtype: fp32 } : {});
  graph.node('main-value-proj', 'Project compressed KV values', ['attn-input', 'main-value-weight'], ['main-values'],
    ratio === 2 ? vectorWork('2 * B * Q * H * D') : { useful: '2 * B * Q * H * D' });
  let normalInput = 'main-values';
  if (ratio === 2) {
    weight(graph, 'main-score-weight', ['H', 'D'], fp32);
    graph.tensor('main-scores', sequence('D'), { dtype: fp32 });
    graph.node('main-score-proj', 'Project FP32 pooling scores', ['attn-input', 'main-score-weight'], ['main-scores'],
      vectorWork('2 * B * Q * H * D'));
    const ring = extent('2', 'D');
    for (const part of ['value', 'score']) {
      graph.tensor('pending-' + part, ring, { dtype: fp32, category: 'state' });
      graph.tensor('next-' + part, ring, { dtype: fp32, storageId: 'pending-' + part });
    }
    graph.tensor('main-pooled', extent(current, 'D'), { dtype: fp32 });
    const access = '4 * B * D * if(' + current + ' > 0, C - 2 * floor(C / 2), 0)';
    graph.node('main-pool', 'Pool each completed pair using softmax scores',
      ['main-values', 'main-scores', 'pending-value', 'pending-score'], ['main-pooled'], vectorWork('14 * B * ' + current + ' * D'),
      { accessBytes: { 'pending-value': access, 'pending-score': access } });
    const write = '4 * B * D * min(Q, 2)';
    graph.node('main-pending', 'Retain FP32 partial-group values and scores', ['main-values', 'main-scores'], ['next-value', 'next-score'],
      undefined, { accessBytes: { 'main-values': write, 'main-scores': write, 'next-value': write, 'next-score': write } });
    graph.graph.dependencies.push({ edgeId: 'pool-before-history-update', fromNodeId: NodeId.parse('main-pool'),
      toNodeId: NodeId.parse('main-pending'), kind: 'control' });
    state(graph, 'main-compressor-history', 'recurrent', ['pending-value', 'pending-score'], { kind: 'replace' }, 'main-pending',
      ['next-value', 'next-score'], [['main-pool', 'pending-value'], ['main-pool', 'pending-score']]);
    normalInput = 'main-pooled';
  }
  graph.tensor('unrotated-latent', extent(current, 'D'));
  graph.node('main-norm', 'Normalize compressed latent before the KV / index fork', [normalInput, normWeight], ['unrotated-latent'],
    vectorWork('5 * B * ' + current + ' * D'));
}

function publishMain(graph: GraphAuthor, ratio: Ratio) {
  const current = newlyCompleted(ratio);
  graph.tensor('main-rotated', extent(current, 'D'), { storageId: 'unrotated-latent' });
  graph.node('main-rope', 'Rotate compressed KV at the group start position', ['unrotated-latent'], ['main-rotated'],
    vectorWork('3 * B * ' + current + ' * R'));
  graph.node('main-write', 'Simulate FP4 with E4M3 scales and append shared KV rows', ['main-rotated'], ['main-cache'],
    vectorWork('2 * B * ' + current + ' * D'), { accessBytes: { 'main-cache': '2 * B * ' + current + ' * D' } });
  graph.output('main-cache');
}

function publishIndex(graph: GraphAuthor, ratio: Ratio) {
  const current = newlyCompleted(ratio);
  weight(graph, 'index-key-weight', ['D', 'ID']); weight(graph, 'index-key-norm-weight', ['ID']);
  for (const id of ['index-new-key', 'index-key-normalized', 'index-key-rotated']) graph.tensor(id, extent(current, 'ID'));
  graph.node('index-key', 'Project index keys from the pre-RoPE shared latent', ['unrotated-latent', 'index-key-weight'], ['index-new-key'],
    { useful: '2 * B * ' + current + ' * D * ID' }, { accessBytes: { 'index-key-weight': 'if(' + current + ' > 0, 2 * D * ID, 0)' } });
  graph.node('index-key-norm', 'Index key RMSNorm', ['index-new-key', 'index-key-norm-weight'], ['index-key-normalized'],
    vectorWork('5 * B * ' + current + ' * ID'));
  graph.node('index-key-rope', 'Rotate index keys at the group start position', ['index-key-normalized'], ['index-key-rotated'],
    vectorWork('3 * B * ' + current + ' * R'));
  graph.node('index-write', 'Simulate FP4 and append shared index rows', ['index-key-rotated'], ['index-cache'],
    vectorWork('2 * B * ' + current + ' * ID'), { accessBytes: { 'index-cache': '2 * B * ' + current + ' * ID' } });
  graph.output('index-cache');
}

function selectRows(graph: GraphAuthor, { ratio, mode }: SparseBranch) {
  const rows = cacheRows(ratio), queries = 'if(' + rows + ' > 0, Q, 0)';
  const pairs = '(' + groupTotal('C + Q', ratio, false) + ' - ' + groupTotal('C', ratio, false) + ')';
  const exec = 'B * Q * ' + rows;
  weight(graph, 'index-q-weight', ['QR', 'IH', 'ID']); weight(graph, 'index-head-weight', ['H', 'IH']);
  const localHeads: Axis[] = [['b', 'batch', 'B'], ['q', 'token', queries], ['h', 'head', 'IH'], ['d', 'hidden', 'ID']];
  graph.tensor('index-q-raw', localHeads); graph.tensor('index-q', localHeads);
  graph.tensor('index-weights', [['b', 'batch', 'B'], ['q', 'token', queries], ['h', 'head', 'IH']]);
  graph.node('index-query', 'Indexer query projection', ['qr', 'index-q-weight'], ['index-q-raw'],
    { useful: '2 * B * ' + queries + ' * QR * IH * ID' }, {
      accessBytes: { qr: '2 * B * ' + queries + ' * QR', 'index-q-weight': 'if(' + rows + ' > 0, 2 * QR * IH * ID, 0)' },
    });
  graph.node('index-query-rope', 'Rotate index queries and simulate FP4', ['index-q-raw'], ['index-q'],
    vectorWork('B * ' + queries + ' * IH * (3 * R + 2 * ID)'));
  graph.node('index-weight', 'Project index head weights', ['attn-input', 'index-head-weight'], ['index-weights'],
    { useful: '2 * B * ' + queries + ' * H * IH' }, {
      accessBytes: { 'attn-input': '2 * B * ' + queries + ' * H', 'index-head-weight': 'if(' + rows + ' > 0, 2 * H * IH, 0)' },
    });
  graph.tensor('index-dot', [...heads('IH', 'ID').slice(0, 3), ['t', 'token', rows]], { dtype: fp32 });
  graph.node('index-score', 'Full index query-key scores', ['index-q', 'index-cache'], ['index-dot'],
    { useful: '2 * B * IH * ID * ' + pairs, executed: '2 * IH * ID * (' + exec + ')' });
  graph.tensor('index-ranked', scoreRows(ratio), { dtype: fp32 });
  graph.node('index-reduce', 'ReLU and weighted index head sum', ['index-dot', 'index-weights'], ['index-ranked'],
    vectorWork('3 * B * IH * ' + pairs, '3 * IH * (' + exec + ')'));
  let scores = 'index-ranked';
  if (mode === 'candidate') {
    const blocks = 'ceil(' + rows + ' / CB)';
    const picked = 'min(CK, ' + blocks + ')';
    graph.tensor('candidate-scores', [['b', 'batch', 'B'], ['q', 'token', 'Q'], ['p', 'custom', blocks]], { dtype: fp32 });
    graph.node('candidate-block-scores', 'Score each block by its highest causal index score', [scores], ['candidate-scores'],
      vectorWork('B * ' + pairs, exec));
    candidateTensor(graph);
    graph.node('candidate-blocks', 'Top-K blocks with the newest visible block pinned', ['candidate-scores'], ['candidate-mask'],
      vectorWork('B * Q * (3 * ' + blocks + ' + ' + picked + ') + ' + exec));
    graph.output('candidate-mask');
  } else if (mode === 'reindex') {
    candidateTensor(graph); graph.input('candidate-mask');
    graph.tensor('index-masked', scoreRows(ratio), { dtype: fp32 });
    graph.node('candidate-mask-apply', 'Mask full index scores using the published candidates', [scores, 'candidate-mask'], ['index-masked'],
      vectorWork(exec));
    scores = 'index-masked';
  }
  graph.tensor('selected-rows', selectedRows(ratio), { dtype: int32 });
  graph.node('index-topk', 'Select causal Top-K and sort the retained positions', [scores], ['selected-rows'],
    vectorWork('3 * B * ' + pairs, '3 * (' + exec + ')'));
  graph.output('selected-rows');
}

export function addV41Attention(graph: GraphAuthor, sparse?: SparseBranch) {
  prepareV4Attention(graph, true);
  if (!sparse) {
    finishV4Attention(graph, '0', '0', [], {}, true);
    return;
  }
  const { ratio, mode } = sparse;
  const owner = mode === 'source' || mode === 'candidate', reusesSelection = mode === 'reuse';
  cacheTensor(graph, 'main', ratio);
  cacheState(graph, 'main', ratio, ['sparse-qk', 'sparse-av'], owner ? 'main-write' : undefined);
  if (owner) {
    compress(graph, ratio);
    publishMain(graph, ratio);
  } else graph.input('main-cache');
  if (reusesSelection) {
    graph.tensor('selected-rows', selectedRows(ratio), { dtype: int32 });
    graph.input('selected-rows');
  } else {
    cacheTensor(graph, 'index', ratio);
    cacheState(graph, 'index', ratio, ['index-score'], owner ? 'index-write' : undefined);
    if (owner) {
      publishIndex(graph, ratio);
      graph.graph.dependencies.push({ edgeId: 'index-before-latent-rotation', fromNodeId: NodeId.parse('index-topk'),
        toNodeId: NodeId.parse('main-rope'), kind: 'control' });
    }
    else graph.input('index-cache');
    selectRows(graph, sparse);
  }
  const rows = cacheRows(ratio), groupPairs = '(' + groupTotal('C + Q', ratio, true) + ' - ' + groupTotal('C', ratio, true) + ')';
  finishV4Attention(graph, 'min(IK, ' + rows + ')', groupPairs, ['main-cache', 'selected-rows'],
    { 'main-cache': '2 * B * D * min(' + rows + ', ' + groupPairs + ')' }, true);
}
