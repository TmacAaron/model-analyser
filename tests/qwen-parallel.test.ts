import { expect, it } from 'vitest';
import { DeviceId, type MetricValue, type Scenario } from '@model-analyser/contracts';
import { analyzeScenario, previewParallelPreset } from '@model-analyser/core';
import { validateResult } from '../packages/contracts/src/result-validation.js';
import { makeModelProject } from '../scripts/model-project.js';
import { makeQwenParallelAssets } from '../scripts/qwen-parallel-assets.js';

const hidden = 2048, width = 128, queries = 16, kvHeads = 8, layers = 28, intermediate = 6144, vocab = 151936;
const attentionMatrices = hidden * width * (2 * queries + 2 * kvHeads);
const replicaParameters = 2 * hidden + 2 * width + 3 * hidden * intermediate;
const rootParameters = hidden * vocab + hidden;

function count(metric: MetricValue | undefined) {
  if (metric?.status !== 'available') throw Error('Expected known model cost');
  return metric.quantity.value;
}

function prepare(workload: Scenario['workload'], layerCount = layers) {
  const assets = makeQwenParallelAssets().filter(asset => asset.assetId !== 'builtin:model:qwen3-0.6b');
  const project = makeModelProject(assets, workload, 'Qwen3-1.7B parallel');
  const scenario = project.scenarios[0]!, primary = scenario.deviceTopology.devices[0]!;
  const other = { ...primary, deviceId: DeviceId.parse('gpu1') };
  scenario.deviceTopology = {
    devices: [primary, other],
    groups: [{ groupId: 'parallel', members: [primary.deviceId, other.deviceId] }],
  };
  if (layerCount !== layers) scenario.numericOverrides.push({
    target: { kind: 'scenario', scenarioId: scenario.scenarioId }, field: 'parameter', parameterKey: 'L',
    value: { value: layerCount, unit: 'count' },
  });
  return { scenario, assets: project.assetSnapshots, groupId: 'parallel', meshAxisId: 'rank' };
}

it('compiles a full 28-block TP2 plan with the correct per-rank allocations and reduction boundaries', async () => {
  const input = prepare({ kind: 'prefill', batchSize: 1, queryTokensPerRequest: 1, pastTokensPerRequest: 2 });
  const preview = await previewParallelPreset({
    ...input, presetId: 'tp-attention-heads', network: { bytesPerSecond: 1e11, latencySeconds: 1e-6 },
  });
  if (preview.status !== 'available') throw Error(preview.message);
  const { allocations, communications } = preview.preview;
  const weightBytes = 2 * (rootParameters + layers * (replicaParameters + attentionMatrices / 2));
  const stateBytes = 2 * layers * 2 * 3 * width * kvHeads / 2;
  expect(allocations.map(device => [device.weightBytes, device.stateBytes])).toEqual([[weightBytes, stateBytes], [weightBytes, stateBytes]]);
  expect(communications).toHaveLength(layers);
  for (const [index, communication] of communications!.entries()) {
    expect(communication.placement?.afterNodeIds).toEqual(['decoder[' + index + ']/o-proj']);
    expect(communication.placement?.beforeNodeIds).toEqual(['decoder[' + index + ']/attention-residual']);
  }
  const actual = await analyzeScenario(preview.preview.scenario, preview.preview.assets);
  if (actual.status !== 'available') throw Error(JSON.stringify(actual.diagnostics));
  const { result } = actual;
  expect(validateResult(result)).toEqual([]);
  const local = (nodeId: string) => result.distributed!.layout.localCosts.nodes.find(node => node.nodeId === nodeId)?.placement;
  const operations = (nodeId: string) => {
    const placement = local(nodeId);
    if (placement?.kind !== 'placed') throw Error('Missing placement for ' + nodeId);
    return placement.perDevice.map(device => {
      if (device.outcome.status !== 'available') throw Error('Missing local work for ' + nodeId);
      return count(device.outcome.cost.compute[0]?.usefulOperations);
    });
  };
  expect(operations('decoder[0]/qkv')).toEqual(Array(2).fill(hidden * width * (queries + 2 * kvHeads)));
  expect(operations('decoder[0]/down-proj')).toEqual(Array(2).fill(2 * hidden * intermediate));
  expect(operations('lm-head')).toEqual(Array(2).fill(2 * hidden * vocab));
  expect(count(result.total.seconds)).toBeGreaterThan(0);
}, 120_000);

it('validates DP divisibility, retains full replicated weights and splits the cache by requests', async () => {
  const input = prepare({ kind: 'prefill', batchSize: 3, queryTokensPerRequest: 2, pastTokensPerRequest: 0 }, 2);
  const presetId = 'dp-batch';
  expect(await previewParallelPreset({ ...input, presetId })).toMatchObject({ status: 'unavailable', message: expect.stringContaining('整除') });
  input.scenario.workload.batchSize = 2;
  const preview = await previewParallelPreset({ ...input, presetId });
  if (preview.status !== 'available') throw Error(preview.message);
  expect(preview.preview.communications).toHaveLength(0);
  expect(preview.preview.allocations.map(device => [device.weightBytes, device.stateBytes])).toEqual(
    Array(2).fill([2 * (rootParameters + 2 * (replicaParameters + attentionMatrices)), 2 * 2 * 2 * 2 * width * kvHeads]),
  );
  const tp = await previewParallelPreset({ ...input, presetId: 'tp-attention-heads', network: { bytesPerSecond: 1000, latencySeconds: 0 } });
  if (tp.status !== 'available') throw Error(tp.message);
  expect(tp.preview.communications).toHaveLength(2);
}, 45_000);

it('previews the first Decode call and keeps the applied layout for actual multi-step cache growth', async () => {
  const input = prepare({ kind: 'decode', batchSize: 1, queryTokensPerRequest: 1, contextTokensPerRequest: 2, steps: 2 }, 2);
  const preview = await previewParallelPreset({
    ...input, presetId: 'tp-attention-heads', network: { bytesPerSecond: 1e11, latencySeconds: 1e-6 },
  });
  if (preview.status !== 'available') throw Error(preview.message);
  expect(preview.preview.scenario.workload).toEqual(input.scenario.workload);
  expect(preview.preview.warnings).toContain('预览为第一个 Decode 步骤的布局和分配。正式分析按保存的步数逐步计算。');
  const kvPerCardAndToken = 2 * 2 * 2 * width * kvHeads / 2;
  expect(preview.preview.allocations.map(device => device.stateBytes)).toEqual([3 * kvPerCardAndToken, 3 * kvPerCardAndToken]);
  const actual = await analyzeScenario(preview.preview.scenario, preview.preview.assets);
  if (actual.status !== 'available') throw Error(JSON.stringify(actual.diagnostics));
  expect(validateResult(actual.result)).toEqual([]);
  expect(actual.result.decode?.steps.map(step => step.memory.map(device =>
    count(device.categoryBreakdown.find(item => item.category === 'state')?.bytes)))).toEqual([
    [3 * kvPerCardAndToken, 3 * kvPerCardAndToken], [4 * kvPerCardAndToken, 4 * kvPerCardAndToken],
  ]);
}, 60_000);
