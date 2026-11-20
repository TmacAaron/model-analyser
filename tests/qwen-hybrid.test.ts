import { expect, it } from 'vitest';
import { analyzeScenario, estimateKvCapacity } from '@model-analyser/core';
import type { MetricValue } from '@model-analyser/contracts';
import { validateResult } from '../packages/contracts/src/result-validation.js';
import { validateProject } from '../packages/contracts/src/validation.js';
import { makeModelProject } from '../scripts/model-project.js';
import { makeQwenHybridAssets } from '../scripts/qwen-hybrid-model.js';

const cases = [
  { release: 'qwen35', name: 'Qwen3.5-397B-A17B', periods: 15, hidden: 4096, keyHeads: 2, queryHeads: 32, linearValueHeads: 64, experts: 512, ffn: 1024 },
  { release: 'qwen38', name: 'Qwen3.8-27B', periods: 16, hidden: 5120, keyHeads: 4, queryHeads: 24, linearValueHeads: 48, experts: 0, ffn: 17408 },
] as const;
function amount(metric: MetricValue | undefined) {
  if (metric?.status !== 'available') throw Error('Expected a known metric');
  return metric.quantity.value;
}

// Independent main-text parameter and persistent-state ledger.
function ledger(fixture: typeof cases[number], periods: number = fixture.periods) {
  const { hidden, keyHeads, queryHeads, linearValueHeads, experts, ffn } = fixture;
  const valueChannels = linearValueHeads * 128, convChannels = 2 * 16 * 128 + valueChannels;
  const delta = hidden * (convChannels + 2 * valueChannels + 2 * linearValueHeads) + 4 * convChannels + 2 * linearValueHeads + 128;
  const gqa = hidden * 256 * (3 * queryHeads + 2 * keyHeads) + 2 * 256;
  const ff = 3 * hidden * ffn * (1 + experts) + (experts ? hidden * (experts + 1) : 0);
  return {
    weightBytes: 2 * (2 * 248320 * hidden + hidden + periods * (3 * delta + gqa + 4 * (2 * hidden + ff))),
    kvPerToken: 2 * 2 * 256 * keyHeads * periods,
    recurrentBytes: 3 * periods * (2 * 4 * convChannels + 4 * linearValueHeads * 128 * 128),
  };
}

it.each(cases)('reproduces the full text decoder weights and separates persistent states of $name', async fixture => {
  const project = makeModelProject(makeQwenHybridAssets(fixture.release), {
    kind: 'prefill', batchSize: 1, queryTokensPerRequest: 3, pastTokensPerRequest: 0,
  }, fixture.name);
  const expected = ledger(fixture), scenario = project.scenarios[0]!;
  expect(validateProject(project)).toEqual([]);
  const result = await analyzeScenario(scenario, project.assetSnapshots);
  if (result.status !== 'available') throw Error(JSON.stringify(result.diagnostics.slice(0, 4)));
  expect(validateResult(result.result)).toEqual([]);
  const memory = result.result.memory[0]?.categoryBreakdown;
  expect(amount(memory?.find(item => item.category === 'weight')?.bytes)).toBe(expected.weightBytes);
  expect(amount(memory?.find(item => item.category === 'state')?.bytes)).toBe(expected.recurrentBytes + 3 * expected.kvPerToken);
  expect(amount(result.result.total.seconds)).toBeGreaterThan(0);
  const capacity = await estimateKvCapacity(scenario, project.assetSnapshots);
  if (capacity.status !== 'available') throw Error(capacity.message);
  expect(capacity.report).toMatchObject({
    stateCount: fixture.periods, storageCount: 2 * fixture.periods, currentKvBytes: 3 * expected.kvPerToken,
    averageBytesPerToken: expected.kvPerToken, devices: [{ otherStateBytes: expected.recurrentBytes }],
    budget: { status: fixture.experts ? 'no_room' : 'available' },
  });
}, 120_000);

it('grows only GQA storage across Decode calls while replacing the two fixed DeltaNet states', async () => {
  const project = makeModelProject(makeQwenHybridAssets('qwen38'), {
    kind: 'decode', batchSize: 2, contextTokensPerRequest: 2, queryTokensPerRequest: 1, steps: 2,
  }, 'Hybrid decoder step ledger');
  const scenario = project.scenarios[0]!;
  scenario.numericOverrides.push({
    target: { kind: 'scenario', scenarioId: scenario.scenarioId }, field: 'parameter', parameterKey: 'Periods',
    value: { value: 1, unit: 'count' },
  });
  const expected = ledger(cases[1], 1);
  const result = await analyzeScenario(scenario, project.assetSnapshots);
  if (result.status !== 'available') throw Error(JSON.stringify(result.diagnostics.slice(0, 4)));
  const steps = result.result.decode?.steps;
  expect(steps).toHaveLength(2);
  for (const [index, step] of steps!.entries()) {
    const transitions = step.stateTransitions;
    const fixedStates = transitions.filter(state => state.policy.kind === 'replace');
    const cache = transitions.filter(state => state.policy.kind === 'append');
    expect(fixedStates).toHaveLength(6);
    expect(cache).toHaveLength(1);
    const after = (states: typeof transitions) => states.flatMap(state => state.storages)
      .reduce((bytes, storage) => bytes + amount(storage.afterBytes), 0);
    expect(after(fixedStates)).toBe(2 * expected.recurrentBytes);
    expect(after(cache)).toBe(2 * (3 + index) * expected.kvPerToken);
  }
}, 45_000);
