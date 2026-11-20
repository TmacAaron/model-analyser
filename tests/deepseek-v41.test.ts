import { expect, it } from 'vitest';
import { analyzeScenario, estimateKvCapacity, instantiateModel } from '@model-analyser/core';
import type { MetricValue } from '@model-analyser/contracts';
import { makeDeepSeekV41Assets } from '../scripts/deepseek-v41-model.js';
import { makeModelProject } from '../scripts/model-project.js';

function known(metric: MetricValue | undefined) {
  if (metric?.status !== 'available') throw Error('Expected available metric');
  return metric.quantity.value;
}

// Independent reference ledger from the 40-layer release and its text-forward parameter shapes.
const LAYERS = 40, W = 128, D = 512, J = 128, H = 5120, V = 129280, N = 64, R = 1280, G = 8, O = 1024;
const HC = 4, P = HC * (HC + 2), E = 384, I = 2304, IH = 32;
const attention = 2 * (H * R + R * N * D + H * D + N * D * O + G * O * H + R + D) + 4 * N;
const hyper = 8 * (P * HC * H + P + 3) + 4 * H;
const moe = 2 * (H * E + 3 * (E + 1) * H * I) + 4 * E;
const engramTables = (384006168 + 384016682) * (256 + 8);
const engramProjection = 4 * (3 * 8 * 256 * H * (HC + 1) + 2 * HC * H);
const releasedWeightBytes = LAYERS * (attention + hyper + moe) + 6 * H * V + 2 * H
  + 3 * (8 * H * D + 2 * D) + 2 * (H * D + D) + 8 * (D * J + J)
  + 16 * (R * IH * J + H * IH) + engramTables + engramProjection;
const fixedStateBytes = 3 * 2 * 2 * D * 4 + 1_048_576 * 8;
function kv(tokens: number) {
  return 2 * (LAYERS * W * D + (3 * Math.floor(tokens / 2) + tokens) * (D + J));
}

it('has forty real block calls with four cache owners and carries coefficients, selected rows and Engram hashes to their exact consumers', () => {
  const p = makeModelProject(makeDeepSeekV41Assets(), {
    kind: 'prefill', batchSize: 1, queryTokensPerRequest: 4, pastTokensPerRequest: 0,
  }, 'V4.1 structure');
  const attempt = instantiateModel(p.scenarios[0]!, p.assetSnapshots);
  if (attempt.status !== 'available') throw Error(JSON.stringify(attempt.diagnostics.slice(0, 6)));
  const { nodes, edges, states } = attempt.resolved.graph;
  const count = (id: string) => nodes.filter(node => node.nodeId.endsWith('/' + id)).length;
  expect(count('kv-project')).toBe(40);
  expect(count('main-write')).toBe(4);
  expect(count('index-write')).toBe(4);
  expect(count('index-score')).toBe(8);
  expect(count('candidate-mask-apply')).toBe(4);
  expect(count('engram-lookup')).toBe(2);
  expect(states.filter(s => s.stateKind === 'latent').map(s => s.readers.length)).toEqual([12, 12, 12, 40]);
  expect(states.filter(s => s.stateKind === 'indexer').map(s => s.readers.length)).toEqual([1, 1, 1, 5]);
  function wire(from: string, to: string, portId: string) {
    expect(edges.some(edge => edge.from.kind === 'node' && edge.from.nodeId === from &&
      edge.to.kind === 'node' && edge.to.nodeId === to && edge.to.portId === portId),
    from + ' → ' + to + ' · ' + portId).toBe(true);
  }
  wire('engram-hash', 'window-engram/engram-lookup', 'hashes-1');
  wire('engram-hash', 'r2-engram/source/engram-lookup', 'hashes-14');
  wire('window/ffn-hc-sinkhorn', 'window-engram/attn-hc-reduce', 'pre');
  wire('r2[0]/reuse[4]/ffn-hc-sinkhorn', 'r2[1]/source/attn-hc-reduce', 'pre');
  wire('r1/candidate-source/main-write', 'r1/reindex[3]/reuse[2]/sparse-qk', 'main-cache');
  wire('r1/candidate-source/index-write', 'r1/reindex[3]/source/index-score', 'index-cache');
  wire('r1/candidate-source/candidate-blocks', 'r1/reindex[0]/source/candidate-mask-apply', 'candidate-mask');
  wire('r1/reindex[3]/source/index-topk', 'r1/reindex[3]/reuse[2]/sparse-qk', 'selected-rows');
});

it('charges shared caches once and includes the FP8 Engram tables, scales and fixed history', async () => {
  const p = makeModelProject(makeDeepSeekV41Assets(), {
    kind: 'prefill', batchSize: 1, queryTokensPerRequest: 4, pastTokensPerRequest: 0,
  }, 'V4.1 reference ledger');
  const scenario = p.scenarios[0]!;
  const result = await analyzeScenario(scenario, p.assetSnapshots);
  if (result.status !== 'available') throw Error(JSON.stringify(result.diagnostics.slice(0, 6)));
  const memory = result.result.memory[0]!.categoryBreakdown;
  expect(known(memory.find(row => row.category === 'weight')?.bytes)).toBe(releasedWeightBytes);
  expect(known(memory.find(row => row.category === 'state')?.bytes)).toBe(kv(4) + fixedStateBytes);
  expect(known(result.result.total.seconds)).toBeGreaterThan(0);
  const lookup = result.result.nodes.find(node => node.nodeId === 'window-engram/engram-lookup')!;
  expect(known(lookup.cost.logicalReadBytes)).toBe(4 * 24 * (8 + 256 + 8));
  const estimate = await estimateKvCapacity(scenario, p.assetSnapshots);
  if (estimate.status !== 'available') throw Error(estimate.message);
  expect(estimate.report).toMatchObject({
    currentKvBytes: kv(4), averageBytesPerToken: kv(4) / 4, stateCount: 48,
    devices: [{ otherStateBytes: fixedStateBytes }],
    rowProfile: { fixedWindows: [128], groupSizes: [2], includesIndexer: true },
    budget: { status: 'no_room', reason: 'non_kv' },
  });
}, 120_000);

it('preserves the four shared backings through Decode when only the linear stage grows', async () => {
  const p = makeModelProject(makeDeepSeekV41Assets(), {
    kind: 'decode', batchSize: 1, contextTokensPerRequest: 2, queryTokensPerRequest: 1, steps: 2,
  }, 'V4.1 decode carry');
  const result = await analyzeScenario(p.scenarios[0]!, p.assetSnapshots);
  if (result.status !== 'available') throw Error(JSON.stringify(result.diagnostics.slice(0, 6)));
  const steps = result.result.decode!.steps;
  expect(steps).toHaveLength(2);
  for (const [i, step] of steps.entries()) {
    const after = 3 + i;
    const rows = new Map(step.stateTransitions.map(state => [String(state.stateId), state]));
    for (const id of ['r2[0]', 'r2[1]', 'r2-engram', 'r1']) {
      const expectedRows = id === 'r1' ? after : Math.floor(after / 2);
      expect(known(rows.get(id + '::main-cache')?.storages[0]?.afterBytes)).toBe(2 * expectedRows * D);
      expect(known(rows.get(id + '::index-cache')?.storages[0]?.afterBytes)).toBe(2 * expectedRows * J);
    }
    expect(known(rows.get('engram-history')?.storages[0]?.afterBytes)).toBe(1_048_576 * 8);
    expect(known(step.memory[0]?.categoryBreakdown.find(row => row.category === 'state')?.bytes)).toBe(kv(after) + fixedStateBytes);
  }
}, 150_000);
