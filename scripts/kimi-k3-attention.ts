import { GraphAuthor, fp32 } from './model-authoring.js';
import { extent, heads, sequence, state, vectorWork, weight, type Axis } from './deepseek-v4-attention.js';

const parts = ['q', 'k', 'v'] as const;
const hidden = sequence('H');

export function addKimiKda(graph: GraphAuthor) {
  const tile = heads('N', 'D');
  for (const part of parts) {
    weight(graph, 'kda-' + part + '-weight', ['H', 'N', 'D']);
    graph.tensor(part + '-raw', tile);
  }
  graph.node('kda-qkv', 'KDA query, key and value projections', ['attn-input', ...parts.map(part => 'kda-' + part + '-weight')],
    parts.map(part => part + '-raw'), { useful: '6 * B * Q * H * N * D' });
  const initialTaps = 'min(Q, max(0, W - C - 1))';
  const taps = '(' + initialTaps + ' * (2 * C + ' + initialTaps + ' + 1) / 2 + (Q - ' + initialTaps + ') * W)';
  const conv: Axis[] = [['b', 'batch', 'B'], ['n', 'head', 'N'], ['d', 'hidden', 'D'], ['window', 'custom', 'W']];
  for (const part of parts) {
    const history = part + '-history', after = part + '-history-next', node = part + '-conv';
    weight(graph, part + '-conv-weight', ['N', 'D', 'W']);
    graph.tensor(history, conv, { category: 'state' }); graph.tensor(after, conv, { storageId: history });
    graph.tensor(part + '-filtered', tile);
    graph.node(node, part.toUpperCase() + ' causal short convolution and SiLU',
      [part + '-raw', part + '-conv-weight', history], [part + '-filtered', after],
      vectorWork('B * N * D * (2 * ' + taps + ' + 5 * Q)', 'B * Q * N * D * (2 * W + 5)'), {
        accessBytes: { [history]: '2 * B * N * D * min(C, W - 1)' },
      });
    state(graph, history, 'recurrent', [history], { kind: 'replace' }, node, [after], [[node, history]]);
  }
  graph.tensor('q-unit', tile, { dtype: fp32 }); graph.tensor('k-unit', tile, { dtype: fp32 });
  graph.node('qk-normalize', 'L2 normalize Q/K and scale Q', ['q-filtered', 'k-filtered'], ['q-unit', 'k-unit'],
    vectorWork('B * Q * N * (7 * D + 2)'));

  weight(graph, 'decay-a-weight', ['H', 'D']); weight(graph, 'decay-b-weight', ['D', 'N', 'D']);
  graph.tensor('decay-low-rank', sequence('D')); graph.tensor('decay-logits', tile);
  graph.node('decay-a', 'Low-rank decay projection', ['attn-input', 'decay-a-weight'], ['decay-low-rank'],
    { useful: '2 * B * Q * H * D' });
  graph.node('decay-b', 'Expand decay logits per key channel', ['decay-low-rank', 'decay-b-weight'], ['decay-logits'],
    { useful: '2 * B * Q * N * D * D' });
  weight(graph, 'decay-log-scale', ['N'], fp32); weight(graph, 'decay-bias', ['N', 'D'], fp32);
  graph.tensor('decay', tile, { dtype: fp32 });
  graph.node('bounded-decay', 'Apply the −5 lower-bound decay gate and exponentiate', ['decay-logits', 'decay-log-scale', 'decay-bias'],
    ['decay'], vectorWork('B * Q * N * D * 8 + N'));
  weight(graph, 'beta-weight', ['H', 'N']); graph.tensor('beta-logits', sequence('N')); graph.tensor('beta', sequence('N'), { dtype: fp32 });
  graph.node('beta-proj', 'Per-head delta coefficient projection', ['attn-input', 'beta-weight'], ['beta-logits'],
    { useful: '2 * B * Q * H * N' });
  graph.node('beta-sigmoid', 'Sigmoid delta coefficient', ['beta-logits'], ['beta'], vectorWork('4 * B * Q * N'));

  const memory: Axis[] = [['b', 'batch', 'B'], ['n', 'head', 'N'], ['v', 'hidden', 'D'], ['k', 'hidden', 'D']];
  graph.tensor('matrix-state', memory, { dtype: fp32, category: 'state' });
  graph.tensor('matrix-next', memory, { dtype: fp32, storageId: 'matrix-state' });
  graph.tensor('matrix-work', memory, { dtype: fp32, category: 'workspace' });
  graph.tensor('recurrent-out', tile);
  graph.node('recurrent', 'KDA row decay, delta update and query readout', ['q-unit', 'k-unit', 'v-filtered', 'decay', 'beta', 'matrix-state'],
    ['recurrent-out', 'matrix-next'], vectorWork('7 * B * Q * N * D * D'), {
      accessBytes: { 'matrix-state': 'if(C > 0, 4 * B * N * D * D, 0)' }, temporaries: ['matrix-work'],
    });
  state(graph, 'matrix', 'recurrent', ['matrix-state'], { kind: 'replace' }, 'recurrent', ['matrix-next'], [['recurrent', 'matrix-state']]);

  weight(graph, 'gate-weight', ['H', 'N', 'D']); graph.tensor('gate-logits', tile);
  graph.node('kda-gate-proj', 'Full-rank KDA output gate projection', ['attn-input', 'gate-weight'], ['gate-logits'],
    { useful: '2 * B * Q * H * N * D' });
  weight(graph, 'head-norm-weight', ['D']); graph.tensor('gated-values', tile);
  graph.node('kda-norm-gate', 'Head RMSNorm and sigmoid output gate', ['recurrent-out', 'head-norm-weight', 'gate-logits'], ['gated-values'],
    vectorWork('10 * B * Q * N * D'));
  weight(graph, 'attention-output-weight', ['N', 'D', 'H']); graph.tensor('attention-output', hidden);
  graph.node('kda-o-proj', 'KDA output projection', ['gated-values', 'attention-output-weight'], ['attention-output'],
    { useful: '2 * B * Q * N * D * H' });
}

export function addKimiMla(graph: GraphAuthor) {
  const length = 'C + Q', logical = '(Q * C + Q * (Q + 1) / 2)', rectangular = '(Q * (C + Q))';
  weight(graph, 'qa-weight', ['H', 'QR']); weight(graph, 'q-norm-weight', ['QR']);
  graph.tensor('q-low-raw', sequence('QR')); graph.tensor('q-low', sequence('QR'));
  graph.node('q-a', 'Low-rank query projection', ['attn-input', 'qa-weight'], ['q-low-raw'], { useful: '2 * B * Q * H * QR' });
  graph.node('q-rmsnorm', 'Query rank RMSNorm', ['q-low-raw', 'q-norm-weight'], ['q-low'], vectorWork('5 * B * Q * QR'));
  weight(graph, 'qb-weight', ['QR', 'N', 'DN + DX']);
  graph.tensor('q-main', heads('N', 'DN')); graph.tensor('q-extra', heads('N', 'DX'));
  graph.node('q-b', 'Query head projection and NoPE split', ['q-low', 'qb-weight'], ['q-main', 'q-extra'],
    { useful: '2 * B * Q * QR * N * (DN + DX)' });
  weight(graph, 'kv-weight', ['H', 'R + DX']); weight(graph, 'kv-norm-weight', ['R']);
  graph.tensor('kv-low-raw', sequence('R')); graph.tensor('kv-low', sequence('R')); graph.tensor('k-extra', sequence('DX'));
  graph.node('kv-a', 'Joint KV latent and shared NoPE key projection', ['attn-input', 'kv-weight'], ['kv-low-raw', 'k-extra'],
    { useful: '2 * B * Q * H * (R + DX)' });
  graph.node('kv-rmsnorm', 'KV latent RMSNorm', ['kv-low-raw', 'kv-norm-weight'], ['kv-low'], vectorWork('5 * B * Q * R'));
  graph.tensor('latent-cache', extent(length, 'R'), { category: 'state' });
  graph.tensor('extra-cache', extent(length, 'DX'), { category: 'state' });
  graph.node('cache-write', 'Append latent and shared NoPE key channels', ['kv-low', 'k-extra'], ['latent-cache', 'extra-cache'],
    undefined, { accessBytes: { 'latent-cache': '2 * B * Q * R', 'extra-cache': '2 * B * Q * DX' } });
  state(graph, 'mla-cache', 'latent', ['latent-cache', 'extra-cache'], { kind: 'append' }, 'cache-write', ['latent-cache', 'extra-cache'],
    [['qk', 'latent-cache'], ['qk', 'extra-cache'], ['av', 'latent-cache']]);
  weight(graph, 'k-absorb-weight', ['N', 'DN', 'R']); graph.tensor('q-absorbed', heads('N', 'R'));
  graph.node('q-absorb', 'Absorb key expansion into Q', ['q-main', 'k-absorb-weight'], ['q-absorbed'],
    { useful: '2 * B * Q * N * DN * R' });
  graph.tensor('attention-score', heads('N', length), { dtype: fp32 });
  graph.node('qk', 'Full causal NoPE MLA logits', ['q-absorbed', 'q-extra', 'latent-cache', 'extra-cache'], ['attention-score'],
    { useful: '2 * B * N * (R + DX) * ' + logical, executed: '2 * B * N * (R + DX) * ' + rectangular });
  graph.tensor('attention-probability', heads('N', length));
  graph.node('softmax', 'Scale and apply causal softmax', ['attention-score'], ['attention-probability'],
    vectorWork('6 * B * N * ' + logical, '6 * B * N * ' + rectangular));
  graph.tensor('attended-latent', heads('N', 'R'));
  graph.node('av', 'Accumulate values in latent space', ['attention-probability', 'latent-cache'], ['attended-latent'],
    { useful: '2 * B * N * R * ' + logical, executed: '2 * B * N * R * ' + rectangular });
  weight(graph, 'v-up-weight', ['N', 'R', 'DV']); graph.tensor('attended-value', heads('N', 'DV'));
  graph.node('v-up', 'Expand the combined value latent', ['attended-latent', 'v-up-weight'], ['attended-value'],
    { useful: '2 * B * Q * N * R * DV' });
  weight(graph, 'gate-weight', ['H', 'N', 'DV']); graph.tensor('gate-logits', heads('N', 'DV'));
  graph.node('mla-gate-proj', 'MLA output gate projection', ['attn-input', 'gate-weight'], ['gate-logits'],
    { useful: '2 * B * Q * H * N * DV' });
  graph.tensor('gated-values', heads('N', 'DV'));
  graph.node('mla-gate', 'Apply sigmoid gate to MLA head outputs', ['gate-logits', 'attended-value'], ['gated-values'],
    vectorWork('5 * B * Q * N * DV'));
  weight(graph, 'attention-output-weight', ['N', 'DV', 'H']); graph.tensor('attention-output', hidden);
  graph.node('mla-o-proj', 'MLA output projection', ['gated-values', 'attention-output-weight'], ['attention-output'],
    { useful: '2 * B * Q * N * DV * H' });
}
