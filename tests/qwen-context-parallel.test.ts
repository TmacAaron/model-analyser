import { expect, it } from 'vitest';
import { NodeId, Scenario, type MetricValue, type QuantizedStorageSpec } from '@model-analyser/contracts';
import { analyzeScenario, estimateKvCapacity, previewParallelPreset } from '@model-analyser/core';
import { bindDegreePool, currentDegrees, matchingParallelPresets, serialDegrees } from '../apps/web/src/parallel-degrees.js';
import { validateResult } from '../packages/contracts/src/result-validation.js';
import { makeModelProject } from '../scripts/model-project.js';
import { addQwenContextPreset } from '../scripts/qwen-context-parallel.js';
import { makeQwenParallelAssets } from '../scripts/qwen-parallel-assets.js';
import { addQwenPipelinePreset } from '../scripts/qwen-pipeline.js';

const network = { bytesPerSecond: 100e9, latencySeconds: 3e-6 };
const amount = (metric?: MetricValue) => {
  if (metric?.status !== 'available') throw Error('Expected an available cost');
  return metric.quantity.value;
};

function fixture(size: '0.6b' | '1.7b', workload: Scenario['workload']) {
  const base = makeQwenParallelAssets();
  const root = base.find(asset => asset.assetId === 'builtin:model:qwen3-' + size)!;
  const layer = base.find(asset => asset.definition.kind === 'module')!;
  const [model, ...assets] = addQwenContextPreset(layer, [addQwenPipelinePreset(root)]);
  const project = makeModelProject([model!, ...assets, ...base.filter(asset => asset.definition.kind === 'formula')], workload, 'Qwen PCP');
  return { scenario: project.scenarios[0]!, assets: project.assetSnapshots, presets: model!.parallelPresets! };
}

it('accounts for all dense Qwen layers, causal offsets, local projection writes and full cache appends', async () => {
  const { scenario, assets, presets } = fixture('1.7b', { kind: 'prefill', batchSize: 2, queryTokensPerRequest: 4, pastTokensPerRequest: 3 });
  const degrees = { ...serialDegrees, pcp: 2 };
  const [match] = matchingParallelPresets(degrees, presets, scenario);
  expect(match).toMatchObject({ slots: 2, preset: { presetId: 'pcp-queries' } });
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, 2), assets, presetId: match!.preset.presetId, network });
  if (attempt.status !== 'available') throw Error(attempt.message.slice(0, 7000));
  const { preview } = attempt;
  const reopened = Scenario.parse(JSON.parse(JSON.stringify(preview.scenario)));
  expect(currentDegrees(reopened, presets)).toEqual(degrees);
  const hidden = 2048, intermediate = 6144, width = 128, heads = 16, kvHeads = 8, layers = 28;
  const weight = 2 * (hidden * 151936 + hidden + layers * (hidden * width * (2 * heads + 2 * kvHeads) + 2 * hidden + 2 * width + 3 * hidden * intermediate));
  const perToken = 4 * layers * width * kvHeads;
  expect(preview.allocations.map(row => [row.weightBytes, row.stateBytes])).toEqual(Array(2).fill([weight, 2 * 7 * perToken]));
  expect(preview.communicationCount).toBe(2 * layers);

  const attemptResult = await analyzeScenario(reopened, preview.assets);
  if (attemptResult.status !== 'available') throw Error(JSON.stringify(attemptResult.diagnostics.slice(0, 6)));
  const result = attemptResult.result, layout = result.distributed!.layout;
  expect(validateResult(result)).toEqual([]);
  const nodeCosts = (id: string) => {
    const placement = layout.localCosts.nodes.find(row => row.nodeId === 'decoder[0]/'+id)?.placement;
    if (placement?.kind !== 'placed') throw Error('Missing local costs '+id);
    return placement.perDevice.map(rank => {
      if (rank.outcome.status !== 'available') throw Error('Missing rank '+rank.deviceId);
      return rank.outcome;
    });
  };
  const attention = nodeCosts('qk');
  expect(attention.map(row => row.bindings.find(binding => binding.symbol === 'queryStart')?.quantity.value)).toEqual([0, 2]);
  expect(attention.map(row => amount(row.cost.compute[0]?.usefulOperations))).toEqual([9, 13].map(pairs => 2 * 2 * heads * width * pairs));
  expect(attention.map(row => amount(row.cost.compute[0]?.executedOperations))).toEqual(Array(2).fill(2 * 2 * heads * width * (2 * 7)));
  const localTile = 2 * 2 * 2 * kvHeads * width;
  expect(nodeCosts('qkv').map(row => amount(row.cost.logicalWriteBytes))).toEqual(Array(2).fill(2 * 2 * 2 * width * (heads + 2 * kvHeads)));
  expect(nodeCosts('cache-update').map(row => amount(row.cost.logicalWriteBytes))).toEqual(Array(2).fill(4 * localTile));
  for (const { evaluation } of layout.communications) {
    expect(evaluation.definition.operation).toBe('all_gather');
    expect(evaluation.definition.placement?.beforeNodeIds[0]).toMatch(/\/cache-update$/);
    expect(evaluation.perDevice.map(row => [amount(row.sendBytes), amount(row.receiveBytes), amount(row.algorithmTrafficBytes)]))
      .toEqual(Array(2).fill([localTile, 2 * localTile, localTile]));
  }
  expect(await estimateKvCapacity(reopened, preview.assets)).toMatchObject({ status: 'available', report: {
    replicatedBytesPerToken: perToken, budget: { status: 'available' },
  } });
  const storage8: QuantizedStorageSpec = { payloadBits: 8, packingUnitElements: 1, alignmentBytes: 1, auxiliaries: [] };
  const selector = { kind: 'subtree' as const, rootNodeId: NodeId.parse('$model') };
  expect(await estimateKvCapacity({ ...reopened, quantizationOverrides: [{ selector, state: storage8 }] }, preview.assets))
    .toMatchObject({ status: 'available', report: { replicatedBytesPerToken: perToken / 2, budget: { status: 'available' } } });
  expect(await estimateKvCapacity({ ...reopened, quantizationOverrides: [{ selector, activation: storage8 }] }, preview.assets))
    .toMatchObject({ status: 'unavailable', message: expect.stringContaining('量化传输需要独立的转换') });
}, 130_000);

it('checks query alignment, keeps PCP in Prefill and returns to single-device execution', async () => {
  const { scenario, assets } = fixture('0.6b', { kind: 'prefill', batchSize: 1, queryTokensPerRequest: 7, pastTokensPerRequest: 0 });
  scenario.bindings = [{ parameterKey: 'L', value: { kind: 'integer', value: 2 } }];
  const presetId = 'pcp-queries';
  expect(await previewParallelPreset({ ...bindDegreePool(scenario, 4), assets, presetId, network }))
    .toMatchObject({ status: 'unavailable', message: expect.stringContaining('须能被 PCP 整除') });
  scenario.workload.queryTokensPerRequest = 8;
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, 4), assets, presetId, network });
  if (attempt.status !== 'available') throw Error(attempt.message.slice(0, 7000));
  expect(attempt.preview.deviceIds).toHaveLength(4);
  expect(attempt.preview.communications?.map(row => row.algorithm)).toEqual(Array(4).fill(expect.objectContaining({ trafficFactor: 3, startupRounds: 3 })));
  const decode: Scenario = { ...attempt.preview.scenario, workload: { kind: 'decode', batchSize: 1, contextTokensPerRequest: 8, queryTokensPerRequest: 1, steps: 2 } };
  expect(await previewParallelPreset({ ...bindDegreePool(decode, 4), assets, presetId, network }))
    .toMatchObject({ status: 'unavailable', message: expect.stringContaining('阶段') });
  const single = await previewParallelPreset({ ...bindDegreePool(decode, 1), assets: attempt.preview.assets, presetId: 'replicated' });
  if (single.status !== 'available') throw Error(single.message.slice(0, 7000));
  expect(single.preview.deviceIds).toHaveLength(1);
  expect(single.preview.communicationCount).toBe(0);
}, 90_000);
