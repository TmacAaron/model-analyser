import { GraphAuthor, fp32, int64 } from './model-authoring.js';
import { extent, sequence, state, vectorWork, weight, type Axis } from './deepseek-v4-attention.js';
import { residual, token } from './deepseek-v4-model.js';

const fp8 = { category: 'float' as const, bits: 8, format: 'e4m3' };
const e8m0 = { category: 'float' as const, bits: 8, format: 'e8m0' };
const hashCols = 'EH * (EN - 1)';
export const engramHashes = sequence(hashCols);
export type EngramLayer = 1 | 14;
export const hashesPort = (layer: EngramLayer) => 'hashes-' + layer;

export function addEngramHash(graph: GraphAuthor) {
  const map = 'compressed-token-map';
  graph.tensor(map, [['v', 'vocab', 'V']], { dtype: int64, category: 'runtime' });
  const constants = [['engram-multipliers', 'EN'], ['engram-primes', hashCols], ['engram-offsets', hashCols]] as const;
  for (const [id, width] of constants) {
    graph.tensor(id, [['l', 'custom', 'EL'], ['h', 'custom', width]], { dtype: int64, category: 'runtime' });
  }
  const runtime = [map, ...constants.map(([id]) => id)];
  graph.node('engram-runtime-data', 'Use resident token map and fixed hash constants', [], runtime,
    undefined, { accessBytes: Object.fromEntries(runtime.map(id => [id, '0'])) });
  graph.tensor('compressed-token-ids', token, { dtype: int64 });
  graph.node('engram-token-map', 'Map token IDs to the normalized vocabulary', ['tokens', 'compressed-token-map'], ['compressed-token-ids'],
    undefined, { accessBytes: { 'compressed-token-map': '8 * B * Q' } });
  graph.tensor('engram-history', extent('M', '1'), { dtype: int64, category: 'state' });
  graph.node('engram-history-write', 'Record normalized IDs for causal n-gram lookup', ['compressed-token-ids'], ['engram-history'],
    undefined, { accessBytes: { 'engram-history': '8 * B * Q' } });
  const outputs = [hashesPort(1), hashesPort(14)];
  for (const id of outputs) graph.tensor(id, engramHashes, { dtype: int64 });
  graph.node('engram-hash', 'Hash causal 2-, 3- and 4-grams into the two Engram tables',
    ['engram-history', 'engram-multipliers', 'engram-primes', 'engram-offsets'], outputs,
    vectorWork('B * Q * (4 * EN + EL * (EN + (EN - 1) * (2 * EH + 1)))'),
    { accessBytes: { 'engram-history': '8 * B * Q * EN' } });
  state(graph, 'engram-history', 'custom', ['engram-history'], { kind: 'append' }, 'engram-history-write',
    ['engram-history'], [['engram-hash', 'engram-history']]);
}

export function addEngramLookup(graph: GraphAuthor, layer: EngramLayer) {
  const rows = layer === 1 ? 'ER1' : 'ER14', hashes = hashesPort(layer);
  graph.tensor(hashes, engramHashes, { dtype: int64 }); graph.input(hashes);
  weight(graph, 'engram-rows', [rows, 'ED'], fp8);
  weight(graph, 'engram-scales', [rows, 'ED / EB'], e8m0);
  const values: Axis[] = [...token, ['n', 'custom', hashCols], ['d', 'hidden', 'ED']];
  graph.tensor('engram-values', values);
  graph.node('engram-lookup', 'Fetch and dequantize only the addressed FP8 rows',
    [hashes, 'engram-rows', 'engram-scales'], ['engram-values'], vectorWork('B * Q * (' + hashCols + ') * ED'), {
      accessBytes: { 'engram-rows': 'B * Q * (' + hashCols + ') * ED', 'engram-scales': 'B * Q * (' + hashCols + ') * ED / EB' },
    });
  weight(graph, 'engram-proj-weight', ['(' + hashCols + ') * ED', 'H * (HC + 1)']);
  graph.tensor('engram-keys-and-value', sequence('H * (HC + 1)'));
  graph.node('engram-project', 'Project an Engram key per stream and one shared value',
    ['engram-values', 'engram-proj-weight'], ['engram-keys-and-value'], { useful: '2 * B * Q * (' + hashCols + ') * ED * H * (HC + 1)' });
  weight(graph, 'engram-query-norm-weight', ['HC', 'H']); weight(graph, 'engram-key-norm-weight', ['HC', 'H']);
  const gates: Axis[] = [...token, ['r', 'custom', 'HC']];
  graph.tensor('engram-gates', gates, { dtype: fp32 });
  graph.node('engram-gate', 'Gate each stream by its normalized signed-root dot product',
    ['x', 'engram-keys-and-value', 'engram-query-norm-weight', 'engram-key-norm-weight'], ['engram-gates'],
    vectorWork('B * Q * HC * (10 * H + 10)'), { accessBytes: { 'engram-keys-and-value': '2 * B * Q * HC * H' } });
  graph.tensor('engram-residual', residual);
  graph.node('engram-inject', 'Add the gated Engram value to each residual stream',
    ['x', 'engram-keys-and-value', 'engram-gates'], ['engram-residual'],
    vectorWork('2 * B * Q * HC * H'), { accessBytes: { 'engram-keys-and-value': '2 * B * Q * H' } });
  return 'engram-residual';
}
