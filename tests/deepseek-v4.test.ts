import { expect, it } from 'vitest';
import { analyzeScenario, estimateKvCapacity } from '@model-analyser/core';
import type { MetricValue } from '@model-analyser/contracts';
import { makeDeepSeekV4Assets } from '../scripts/deepseek-v4-model.js';
import { makeModelProject } from '../scripts/model-project.js';

function known(metric: MetricValue | undefined) {
  if (metric?.status !== 'available') throw Error('Expected available metric');
  return metric.quantity.value;
}

// Independent ledger for the published 43-layer text backbone and reference FP32 weights.
const windowLayers = 43, csaLayers = 21, hcaLayers = 20;
const h = 4096, d = 512, v = 129280, rank = 1024, heads = 64, indexHeads = 64, indexWidth = 128;
const links = 4, mixing = links * (links + 2), groups = 8, experts = 256, intermediate = 2048;
const mainAttention = 2 * (h * rank + rank * heads * d + h * d + heads * d * rank + groups * rank * h) + 4 * (rank + d + heads);
const hyperConnections = 8 * (mixing * links * h + mixing + 3 + h);
const moe = 2 * (h * experts + 3 * (experts + 1) * h * intermediate);
const compressor = (ratio: number, width: number, overlap: number) => 4 * ((2 * h + ratio) * overlap * width + width);
const weightBytes = 6 * v * h + 4 * (links * links * h + links + 1 + h)
  + windowLayers * (mainAttention + hyperConnections + moe) + 3 * 4 * v * 6 + (windowLayers - 3) * 4 * experts
  + csaLayers * (compressor(4, d, 2) + compressor(4, indexWidth, 2) + 2 * (rank * indexHeads * indexWidth + h * indexHeads))
  + hcaLayers * compressor(128, d, 1);
const recurrentBytes = 8 * (csaLayers * 8 * 2 * (d + indexWidth) + hcaLayers * 128 * d);
const kvBytes = (tokens: number) => 2 * (
  windowLayers * 128 * d + csaLayers * Math.floor(tokens / 4) * (d + indexWidth) + hcaLayers * Math.floor(tokens / 128) * d
);

it('accounts for all 43 layers, mixed precision weights and physical KV allocations', async () => {
  const project = makeModelProject(makeDeepSeekV4Assets(), {
    kind: 'prefill', batchSize: 1, queryTokensPerRequest: 4, pastTokensPerRequest: 0,
  }, 'V4 release ledger');
  const scenario = project.scenarios[0]!;
  const result = await analyzeScenario(scenario, project.assetSnapshots);
  if (result.status !== 'available') throw Error(JSON.stringify(result.diagnostics.slice(0, 4)));
  const memory = result.result.memory[0]!.categoryBreakdown;
  expect(known(memory.find(row => row.category === 'weight')?.bytes)).toBe(weightBytes);
  expect(known(memory.find(row => row.category === 'state')?.bytes)).toBe(kvBytes(4) + recurrentBytes);
  expect(known(result.result.total.seconds)).toBeGreaterThan(0);
  expect(result.result.modules.filter(row => row.nodeId.endsWith('/csa'))).toHaveLength(20);
  const work = result.result.nodes.find(row => row.nodeId === 'csa-hash/sparse-qk')!.cost.compute[0]!;
  expect(known(work.usefulOperations)).toBe(2 * heads * d * (1 + 2 + 3 + 5));
  expect(known(work.executedOperations)).toBe(2 * 4 * heads * d * 5);

  const capacity = await estimateKvCapacity(scenario, project.assetSnapshots);
  if (capacity.status !== 'available') throw Error(capacity.message);
  expect(capacity.report).toMatchObject({
    stateCount: windowLayers + csaLayers * 2 + hcaLayers,
    referenceTokensPerRequest: 4, currentKvBytes: kvBytes(4), averageBytesPerToken: kvBytes(4) / 4,
    devices: [{ otherStateBytes: recurrentBytes }],
    rowProfile: { groupSizes: [4, 128], fixedWindows: [128], includesIndexer: true },
    budget: { status: 'no_room', reason: 'non_kv' },
  });
}, 120_000);

it('retains fixed FP32 buffers and adds R4 and R128 cache rows at completed Decode groups', async () => {
  const project = makeModelProject(makeDeepSeekV4Assets(), {
    kind: 'decode', batchSize: 1, queryTokensPerRequest: 1, contextTokensPerRequest: 126, steps: 3,
  }, 'V4 compression boundary ledger');
  const scenario = project.scenarios[0]!;
  scenario.numericOverrides.push({ target: { kind: 'scenario', scenarioId: scenario.scenarioId },
    field: 'parameter', parameterKey: 'Periods', value: { value: 1, unit: 'count' } });
  const attempt = await analyzeScenario(scenario, project.assetSnapshots);
  if (attempt.status !== 'available') throw Error(JSON.stringify(attempt.diagnostics.slice(0, 4)));
  const steps = attempt.result.decode!.steps;
  for (const [index, step] of steps.entries()) {
    const length = 127 + index, transitions = step.stateTransitions;
    const bytes = (suffix: string, path: string) =>
      known(transitions.find(state => state.stateId === path + '::' + suffix)?.storages[0]?.afterBytes);
    expect(bytes('main-completed', 'decoder[0]/hca')).toBe(2 * d * Math.floor(length / 128));
    expect(bytes('main-completed', 'csa-hash')).toBe(2 * d * Math.floor(length / 4));
    expect(bytes('index-completed', 'csa-hash')).toBe(2 * indexWidth * Math.floor(length / 4));
    expect(bytes('window', 'csa-hash')).toBe(2 * d * 128);
    expect(bytes('main-compressor-history', 'csa-hash')).toBe(4 * 8 * 2 * d);
    expect(transitions.find(state => state.stateId === 'decoder[0]/hca::main-completed')?.afterTokenRange)
      .toEqual({ start: 0, end: 128 * Math.floor(length / 128) });
  }
}, 90_000);
