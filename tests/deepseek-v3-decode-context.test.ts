import { expect, it } from 'vitest';
import { Scenario, type MetricValue } from '@model-analyser/contracts';
import { analyzeScenario, estimateKvCapacity, previewParallelPreset } from '@model-analyser/core';
import { bindDegreePool, currentDegrees, matchingParallelPresets, serialDegrees } from '../apps/web/src/parallel-degrees.js';
import { makeDeepSeekV3ParallelAssets } from '../scripts/deepseek-v3-parallel.js';
import { makeDeepSeekV3FP8WeightPreset } from '../scripts/deepseek-v3-fp8-weights.js';
import { ref } from '../scripts/model-authoring.js';
import { makeModelProject } from '../scripts/model-project.js';

const amount = (metric?: MetricValue) => {
  if (metric?.status !== 'available') throw Error('Expected an available DeepSeek DCP metric');
  return metric.quantity.value;
};

it('shards both decoder block types and crosses slot ownership under FP8 and request DP', async () => {
  const assets = makeDeepSeekV3ParallelAssets('r1'), format = makeDeepSeekV3FP8WeightPreset(assets, 'r1');
  if (format.definition.kind !== 'quantization') throw Error('Missing R1 weight preset');
  const project = makeModelProject([...assets, format], {
    kind: 'decode', batchSize: 4, contextTokensPerRequest: 3, queryTokensPerRequest: 1, steps: 2,
  }, 'R1 MLA DCP');
  const scenario = project.scenarios[0]!, presets = assets[0]!.parallelPresets!;
  scenario.bindings = ([['M', 8], ['Ldense', 1], ['Lmoe', 1]] as const).map(([key, value]) =>
    ({ parameterKey: key, value: { kind: 'integer', value } }));
  scenario.quantizationOverrides = [{ ...format.definition.quantization, preset: ref(format) }];
  const degrees = { ...serialDegrees, dcp: 2, attentionDp: 2 };
  const [match] = matchingParallelPresets(degrees, presets, scenario);
  expect(match).toMatchObject({ slots: 4, requestDp: 2, preset: { presetId: 'dcp-kv' } });
  if (!match) throw Error('Missing DeepSeek DCP layout');
  const network = { bytesPerSecond: 100e9, latencySeconds: 3e-6 };
  const request = { ...bindDegreePool(scenario, match.slots), assets: project.assetSnapshots, presetId: match.preset.presetId,
    requestDp: match.requestDp, network };
  const attempt = await previewParallelPreset(request);
  if (attempt.status !== 'available') throw Error(attempt.message);
  const { preview } = attempt, reopened = Scenario.parse(JSON.parse(JSON.stringify(preview.scenario)));
  expect(currentDegrees(reopened, presets)).toEqual(degrees);
  expect(preview.communicationCount).toBe(6);
  expect(preview.allocations.map(row => row.stateBytes)).toEqual(Array(4).fill(2 * 4 * 2 * 1152));
  const result = await analyzeScenario(reopened, preview.assets);
  if (result.status !== 'available' || !result.result.decode) throw Error(JSON.stringify(result).slice(0, 4000));
  for (const [stepIndex, step] of result.result.decode.steps.entries()) {
    const layout = step.result.distributed?.layout;
    if (!layout) throw Error('Missing DeepSeek step layout');
    const local = (id: string) => {
      const node = layout.localCosts.nodes.find(row => row.nodeId === id)?.placement;
      if (node?.kind !== 'placed') throw Error('Missing MLA placement ' + id);
      return node.perDevice.map(row => {
        if (row.outcome.status !== 'available') throw Error('Missing MLA rank cost');
        return row.outcome.cost;
      });
    };
    for (const scope of ['dense[0]', 'moe[0]']) {
      const writes = local(scope + '/cache-update').map(cost => amount(cost.logicalWriteBytes));
      const bytes = 2 * 2 * (512 + 64);
      expect(writes).toEqual(stepIndex === 0 ? [bytes, 0, bytes, 0] : [0, bytes, 0, bytes]);
      const qk = local(scope + '/qk').map(cost => cost.compute[0]);
      expect(qk.map(row => amount(row?.usefulOperations))).toEqual([4, stepIndex, 4, stepIndex].map(keys => 2 * 2 * 128 * 576 * keys));
      expect(qk.map(row => amount(row?.executedOperations))).toEqual(Array(4).fill(2 * 2 * 128 * 576 * 4));
    }
    for (const { evaluation } of layout.communications) {
      const id = evaluation.definition.source.tensorId;
      expect(evaluation.definition.source.distribution).toMatchObject({ kind: 'partial', reduceOperation: id.endsWith('dcp-max') ? 'max' : 'sum' });
      const bytes = 4 * 2 * 128 * (id.endsWith('dcp-numerator') ? 512 : 1);
      expect(evaluation.perDevice.map(rank => amount(rank.sendBytes))).toEqual(Array(4).fill(bytes));
      expect(evaluation.definition.algorithm.startupRounds).toBe(2);
    }
    const weight = step.result.quantizationApplications?.find(row => row.storageId === 'moe[0]::expert-gate-weight');
    expect(weight?.specification.payloadBits).toBe(8);
    expect(step.stateTransitions).toHaveLength(2);
    for (const state of step.stateTransitions) for (const storage of state.storages) {
      expect(amount(storage.afterBytes)).toBe(amount(storage.beforeBytes));
    }
  }
  expect(await estimateKvCapacity(reopened, preview.assets)).toMatchObject({ status: 'available', report: {
    fixedSlotsPerRequest: 8, averageBytesPerToken: 2304, usableTokensPerRequest: 8, budget: { status: 'fixed' },
  } });
  expect(await previewParallelPreset({ ...request, scenario: { ...request.scenario, bindings: scenario.bindings.map(binding =>
    binding.parameterKey === 'M' ? { ...binding, value: { kind: 'integer', value: 4 } } : binding) } }))
    .toMatchObject({ status: 'unavailable' });
}, 120_000);
