import { GraphAuthor, fp32 } from './model-authoring.js';
import { extent, heads, int32, sequence, state, vectorWork, weight, type Axis } from './deepseek-v4-attention.js';

const length = 'C + Q';
export const selectedRows = sequence('min(IK, C + Q)');
const causalPairs = '(Q * C + Q * (Q + 1) / 2)';
const fullPairs = '(Q * (C + Q))';
const unsaturated = 'min(Q, max(0, IK - C))';
const sparsePairs = '(' + unsaturated + ' * (2 * C + ' + unsaturated + ' + 1) / 2 + (Q - ' + unsaturated + ') * IK)';
const sparseTile = '(Q * min(IK, C + Q))';

function addIndexer(graph: GraphAuthor) {
  const query = heads('IH', 'ID'), key = sequence('ID');
  weight(graph, 'index-q-weight', ['QR', 'IH', 'ID']);
  graph.tensor('index-q-raw', query); graph.tensor('index-q', query);
  graph.node('index-query', 'DSA query projection from normalized Q rank', ['q-rank', 'index-q-weight'], ['index-q-raw'],
    { useful: '2 * B * Q * QR * IH * ID' });
  graph.node('index-query-rope', 'DSA query prefix RoPE', ['index-q-raw'], ['index-q'], vectorWork('3 * B * Q * IH * DR'));

  weight(graph, 'index-k-weight', ['H', 'ID']);
  weight(graph, 'index-norm-weight', ['ID']); weight(graph, 'index-norm-bias', ['ID']);
  for (const id of ['index-k-raw', 'index-k-normalized', 'index-k']) graph.tensor(id, key);
  graph.node('index-key', 'DSA key projection', ['attn-input', 'index-k-weight'], ['index-k-raw'],
    { useful: '2 * B * Q * H * ID' });
  graph.node('index-key-norm', 'DSA key LayerNorm', ['index-k-raw', 'index-norm-weight', 'index-norm-bias'], ['index-k-normalized'],
    vectorWork('8 * B * Q * ID'));
  graph.node('index-key-rope', 'DSA key prefix RoPE', ['index-k-normalized'], ['index-k'], vectorWork('3 * B * Q * DR'));
  graph.tensor('index-cache', extent(length, 'ID'), { category: 'state' });
  graph.node('index-write', 'Append BF16 index keys', ['index-k'], ['index-cache'], undefined,
    { accessBytes: { 'index-cache': '2 * B * Q * ID' } });
  state(graph, 'indexer', 'indexer', ['index-cache'], { kind: 'append', tokensPerRow: 1 }, 'index-write', ['index-cache'],
    [['index-score', 'index-cache']]);

  weight(graph, 'index-head-weight', ['H', 'IH']);
  graph.tensor('index-head-weights', sequence('IH'));
  graph.node('index-weight', 'Project per-head index weights', ['attn-input', 'index-head-weight'], ['index-head-weights'],
    { useful: '2 * B * Q * H * IH' });
  graph.tensor('index-head-scores', heads('IH', length), { dtype: fp32 });
  graph.node('index-score', 'BF16 index dot products with FP32 accumulation', ['index-q', 'index-cache'], ['index-head-scores'],
    { useful: '2 * B * IH * ID * ' + causalPairs, executed: '2 * B * IH * ID * ' + fullPairs });
  graph.tensor('index-scores', sequence(length), { dtype: fp32 });
  graph.node('index-reduce', 'Scale, apply ReLU and sum weighted index heads', ['index-head-scores', 'index-head-weights'], ['index-scores'],
    vectorWork('B * (Q * IH + (4 * IH - 1) * ' + causalPairs + ')', 'B * (Q * IH + (4 * IH - 1) * ' + fullPairs + ')'));
  graph.tensor('selected-rows', selectedRows, { dtype: int32 });
  graph.node('index-topk', 'Apply causal mask and select TopK token rows', ['index-scores'], ['selected-rows'],
    vectorWork('B * (3 * ' + causalPairs + ' + ' + fullPairs + ')', '4 * B * ' + fullPairs));
}

export function addGlm52Attention(graph: GraphAuthor, ownsIndex: boolean, packedKvWeight: boolean) {
  weight(graph, 'qa-weight', ['H', 'QR']); weight(graph, 'qr-norm-weight', ['QR']);
  graph.tensor('qa', sequence('QR')); graph.tensor('q-rank', sequence('QR'));
  graph.node('q-a', 'Query low-rank projection', ['attn-input', 'qa-weight'], ['qa'], { useful: '2 * B * Q * H * QR' });
  graph.node('q-rmsnorm', 'Query rank RMSNorm', ['qa', 'qr-norm-weight'], ['q-rank'], vectorWork('5 * B * Q * QR'));
  weight(graph, 'qb-weight', ['QR', 'N', 'DN + DR']);
  graph.tensor('q-content', heads('N', 'DN')); graph.tensor('q-position-raw', heads('N', 'DR'));
  graph.node('q-b', 'Query head projection', ['q-rank', 'qb-weight'], ['q-content', 'q-position-raw'],
    { useful: '2 * B * Q * QR * N * (DN + DR)' });
  weight(graph, 'kv-a-weight', ['H', 'R + DR']);
  graph.tensor('kv-raw', sequence('R')); graph.tensor('k-position-raw', sequence('DR'));
  graph.node('kv-a', 'Joint KV latent and rotary key projection', ['attn-input', 'kv-a-weight'], ['kv-raw', 'k-position-raw'],
    { useful: '2 * B * Q * H * (R + DR)' });
  weight(graph, 'kv-norm-weight', ['R']); graph.tensor('kv-latent', sequence('R'));
  graph.node('kv-rmsnorm', 'KV latent RMSNorm', ['kv-raw', 'kv-norm-weight'], ['kv-latent'], vectorWork('5 * B * Q * R'));
  graph.tensor('q-position', heads('N', 'DR')); graph.tensor('k-position', sequence('DR'));
  graph.node('qk-rope', 'Apply partial interleaved RoPE', ['q-position-raw', 'k-position-raw'], ['q-position', 'k-position'],
    vectorWork('3 * B * Q * (N + 1) * DR'));

  graph.tensor('latent-cache', extent(length, 'R'), { category: 'state' });
  graph.tensor('rotary-cache', extent(length, 'DR'), { category: 'state' });
  graph.node('cache-write', 'Append BF16 latent and shared rotary key', ['kv-latent', 'k-position'], ['latent-cache', 'rotary-cache'],
    undefined, { accessBytes: { 'latent-cache': '2 * B * Q * R', 'rotary-cache': '2 * B * Q * DR' } });
  state(graph, 'mla-cache', 'latent', ['latent-cache', 'rotary-cache'], { kind: 'append' }, 'cache-write',
    ['latent-cache', 'rotary-cache'], [['qk', 'latent-cache'], ['qk', 'rotary-cache'], ['av', 'latent-cache']]);
  if (ownsIndex) addIndexer(graph);

  const keyWeight = 'k-absorb-weight', valueWeight = 'v-up-weight';
  // Key and value rows can share a scale block. Preserve the checkpoint grid
  // and attribute a single packed-weight read between the two projections.
  if (packedKvWeight) {
    const shape: Axis[] = [['w0', 'custom', 'N * (DN + DV)'], ['w1', 'custom', 'R']];
    for (const id of [keyWeight, valueWeight]) graph.tensor(id, shape, { category: 'weight', storageId: keyWeight });
    const storage = graph.graph.storages.find(row => row.storageId === keyWeight);
    if (!storage) throw Error('Missing packed GLM-5.2 KV projection');
    storage.name = 'Packed key and value up-projection weight';
  } else weight(graph, keyWeight, ['N', 'DN', 'R']);
  graph.tensor('q-absorbed', heads('N', 'R'));
  graph.node('q-absorb', 'Absorb key up-projection into the query', ['q-content', keyWeight], ['q-absorbed'],
    { useful: '2 * B * Q * N * DN * R' }, packedKvWeight ? { allocationPasses: { [keyWeight]: 'DN / (DN + DV)' } } : {});
  const scoreTile = heads('N', 'min(IK, C + Q)');
  graph.tensor('scores', scoreTile, { dtype: fp32 });
  graph.tensor('probabilities', scoreTile);
  const read = '2 * B * min(C + Q, ' + sparsePairs + ') * ';
  graph.node('qk', 'Gather selected KV rows and compute latent plus rotary logits',
    ['q-absorbed', 'q-position', 'latent-cache', 'rotary-cache', 'selected-rows'], ['scores'], {
      useful: '2 * B * N * (R + DR) * ' + sparsePairs, executed: '2 * B * N * (R + DR) * ' + sparseTile,
    }, { accessBytes: { 'latent-cache': read + 'R', 'rotary-cache': read + 'DR' } });
  graph.node('softmax', 'Apply MLA scale and causal mask before softmax', ['scores', 'selected-rows'], ['probabilities'],
    vectorWork('6 * B * N * ' + sparsePairs, '6 * B * N * ' + sparseTile));
  graph.tensor('attended-latent', heads('N', 'R'));
  graph.node('av', 'Accumulate selected values in latent space', ['probabilities', 'selected-rows', 'latent-cache'], ['attended-latent'], {
    useful: '2 * B * N * R * ' + sparsePairs, executed: '2 * B * N * R * ' + sparseTile,
  }, { accessBytes: { 'latent-cache': read + 'R' } });
  if (!packedKvWeight) weight(graph, valueWeight, ['N', 'R', 'DV']);
  graph.tensor('attended-value', heads('N', 'DV'));
  graph.node('v-up', 'Apply value up-projection after summation', ['attended-latent', valueWeight], ['attended-value'],
    { useful: '2 * B * Q * N * R * DV' }, packedKvWeight ? { allocationPasses: { [valueWeight]: 'DV / (DN + DV)' } } : {});
  weight(graph, 'o-weight', ['N', 'DV', 'H']); graph.tensor('attention-output', sequence('H'));
  graph.node('o-proj', 'Attention output projection', ['attended-value', 'o-weight'], ['attention-output'],
    { useful: '2 * B * Q * N * DV * H' });
}
