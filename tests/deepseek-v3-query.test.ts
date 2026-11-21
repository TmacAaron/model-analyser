import { expect, it } from 'vitest';
import { AssetDocument, Scenario, type MetricValue } from '@model-analyser/contracts';
import { estimateKvCapacity, previewParallelPreset, resolveParallelPlan } from '@model-analyser/core';
import { bindDegreePool, currentDegrees, matchingParallelPresets, serialDegrees } from '../apps/web/src/parallel-degrees.js';
import { makeDeepSeekV3ParallelAssets } from '../scripts/deepseek-v3-parallel.js';
import { makeDeepSeekV3FP8WeightPreset } from '../scripts/deepseek-v3-fp8-weights.js';
import { makeModelProject, referenceHardware } from '../scripts/model-project.js';
import { ref } from '../scripts/model-authoring.js';

const network = { bytesPerSecond: 100e9, latencySeconds: 3e-6 };
const amount = (metric?: MetricValue) => {
  if (metric?.status !== 'available') throw Error('Expected a DeepSeek PCP metric');
  return metric.quantity.value;
};

it('uses the original query positions and gathers only the current compressed KV tile in each request group', async () => {
  const model = makeDeepSeekV3ParallelAssets('r1'), fp8 = makeDeepSeekV3FP8WeightPreset(model, 'r1');
  if (fp8.definition.kind !== 'quantization') throw Error('Missing FP8 weights');
  const project = makeModelProject([...model, fp8], { kind: 'prefill', batchSize: 4, queryTokensPerRequest: 4, pastTokensPerRequest: 3 }, 'R1 PCP');
  const scenario = project.scenarios[0]!, presets = model[0]!.parallelPresets!;
  scenario.bindings = ['Ldense', 'Lmoe'].map(parameterKey => ({ parameterKey, value: { kind: 'integer', value: 1 } }));
  scenario.quantizationOverrides = [{ ...fp8.definition.quantization, preset: ref(fp8) }];
  const degrees = { ...serialDegrees, pcp: 2, attentionDp: 2 };
  const [match] = matchingParallelPresets(degrees, presets, scenario);
  expect(match).toMatchObject({ slots: 4, requestDp: 2, preset: { presetId: 'pcp-queries' } });
  if (!match) throw Error('Missing PCP layout');
  const request = { ...bindDegreePool(scenario, match.slots), assets: project.assetSnapshots, presetId: match.preset.presetId,
    requestDp: match.requestDp, network };
  const attempt = await previewParallelPreset(request);
  if (attempt.status !== 'available') throw Error(attempt.message);
  const { preview } = attempt, reopened = Scenario.parse(JSON.parse(JSON.stringify(preview.scenario)));
  expect(currentDegrees(reopened, presets)).toEqual(degrees);
  expect(preview.communicationCount).toBe(4);
  expect(preview.allocations.map(row => row.stateBytes)).toEqual(Array(4).fill(2 * 7 * 2304));
  const resolved = await resolveParallelPlan(reopened, preview.assets);
  if (resolved.status !== 'available') throw Error(JSON.stringify(resolved.diagnostics.slice(0, 6)));
  const local = (name: string) => {
    const placed = resolved.result.localCosts.nodes.find(row => row.nodeId === name)?.placement;
    if (placed?.kind !== 'placed') throw Error('Missing local PCP cost for ' + name);
    return placed.perDevice.map(rank => {
      if (rank.outcome.status !== 'available') throw Error('Missing local PCP rank ' + rank.deviceId);
      return rank.outcome;
    });
  };
  for (const block of ['dense[0]', 'moe[0]']) {
    const qk = local(block + '/qk');
    expect(qk.map(rank => rank.bindings.find(row => row.symbol === 'queryStart')?.quantity.value)).toEqual([0, 2, 0, 2]);
    for (const [id, operationsPerPair] of [['qk', 2 * 2 * 128 * 576], ['softmax', 5 * 2 * 128], ['av', 2 * 2 * 128 * 512]] as const) {
      const costs = local(block + '/' + id).map(row => row.cost.compute[0]);
      expect(costs.map(row => amount(row?.usefulOperations))).toEqual([9, 13, 9, 13].map(pairs => pairs * operationsPerPair));
      expect(costs.map(row => amount(row?.executedOperations))).toEqual(Array(4).fill(14 * operationsPerPair));
    }
    expect(local(block + '/kv-a-norm').map(rank => amount(rank.cost.logicalWriteBytes))).toEqual(Array(4).fill(2 * 2 * 2 * 512));
    expect(local(block + '/rope').map(rank => amount(rank.cost.logicalWriteBytes))).toEqual(Array(4).fill(2 * 2 * 2 * (128 * 192 + 64)));
    expect(local(block + '/cache-update').map(rank => amount(rank.cost.logicalWriteBytes))).toEqual(Array(4).fill(2 * 2 * 4 * 576));
  }
  for (const { evaluation } of resolved.result.communications) {
    expect(evaluation.definition.operation).toBe('all_gather');
    expect(evaluation.definition.placement?.beforeNodeIds[0]).toMatch(/\/cache-update$/);
    const width = evaluation.definition.source.tensorId.endsWith('latent-new') ? 512 : 64;
    const tile = 2 * 2 * 2 * width;
    expect(evaluation.perDevice.map(row => [amount(row.sendBytes), amount(row.receiveBytes), amount(row.algorithmTrafficBytes)]))
      .toEqual(Array(4).fill([tile, 2 * tile, tile]));
  }
  const gate = local('moe[0]/expert-gate-up');
  const matrixBytes = 2048 * 7168 + 4 * (2048 / 128) * (7168 / 128);
  expect(gate.map(rank => amount(rank.cost.compute[0]?.usefulOperations))).toEqual(Array(4).fill(4 * 32 * 7168 * 2048));
  expect(gate.map(rank => amount(rank.cost.logicalReadBytes))).toEqual(Array(4).fill(32 * (2 * matrixBytes + 2 * 7168 + 8)));
  expect(await estimateKvCapacity(reopened, preview.assets)).toMatchObject({ status: 'available', report: {
    currentKvBytes: 4 * 2 * 7 * 2304, averageBytesPerToken: 4608, requestPartitionedBytesPerToken: 2304,
    budget: { status: 'available' },
  } });
  expect(await previewParallelPreset({ ...request, scenario: { ...request.scenario, workload: {
    kind: 'prefill', batchSize: 4, queryTokensPerRequest: 3, pastTokensPerRequest: 3,
  } } })).toMatchObject({ status: 'unavailable', message: expect.stringContaining('须能被 PCP 整除') });
});

it('checks all 61 V3 layers gather latent and rotary tiles and retain their FP8 weight residency', async () => {
  const model = makeDeepSeekV3ParallelAssets('v3'), preset = makeDeepSeekV3FP8WeightPreset(model, 'v3');
  const reference = referenceHardware();
  if (preset.definition.kind !== 'quantization' || reference.definition.kind !== 'hardware') throw Error('Missing storage preset');
  const hardware = AssetDocument.parse({ ...reference, assetId: 'example:hardware:v3-pcp-large',
    definition: { ...reference.definition, hardware: { ...reference.definition.hardware, capacityBytes: 800_000_000_000 } } });
  const project = makeModelProject([...model, preset, hardware], { kind: 'prefill', batchSize: 1, queryTokensPerRequest: 2, pastTokensPerRequest: 2 }, 'V3 PCP');
  const scenario = project.scenarios[0]!;
  scenario.deviceTopology.devices[0]!.hardware = ref(hardware);
  scenario.quantizationOverrides = [{ ...preset.definition.quantization, preset: ref(preset) }];
  const result = await previewParallelPreset({ ...bindDegreePool(scenario, 2), assets: project.assetSnapshots, presetId: 'pcp-queries', network });
  if (result.status !== 'available') throw Error(result.message);
  const { preview } = result;
  expect(preview.communicationCount).toBe(122);
  const matrix = (rows: number, cols: number) => rows * cols + 4 * Math.ceil(rows / 128) * Math.ceil(cols / 128);
  const H = 7168, V = 129280;
  const ffn = (width: number) => 2 * matrix(width, H) + matrix(H, width);
  const attention = matrix(1536, H) + matrix(128 * 192, 1536) + matrix(576, H) + 2 * matrix(128 * 128, 512) +
    matrix(H, 128 * 128) + 2 * (2 * H + 1536 + 512);
  const weight = 4 * H * V + 2 * H + 61 * attention + 3 * ffn(18432) + 58 * (257 * ffn(2048) + 256 * (2 * H + 4));
  expect(preview.allocations.map(row => [row.weightBytes, row.stateBytes])).toEqual(Array(2).fill([weight, 4 * 70_272]));
  expect(await estimateKvCapacity(preview.scenario, preview.assets)).toMatchObject({ status: 'available', report: {
    replicatedBytesPerToken: 70_272, modelContextLimit: { tokensPerRequest: 163840 }, budget: { status: 'available' },
  } });
}, 150_000);
