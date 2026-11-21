import { expect, it } from 'vitest';
import type { MetricValue } from '@model-analyser/contracts';
import { analyzeScenario, estimateKvCapacity, previewParallelPreset } from '@model-analyser/core';
import { bindDegreePool } from '../apps/web/src/parallel-degrees.js';
import { makeDeepSeekV3ParallelAssets } from '../scripts/deepseek-v3-parallel.js';
import { makeDeepSeekV3FP8WeightPreset } from '../scripts/deepseek-v3-fp8-weights.js';
import { makeModelProject } from '../scripts/model-project.js';
import { ref } from '../scripts/model-authoring.js';

const amount = (metric?: MetricValue) => {
  if (metric?.status !== 'available') throw Error('Missing FP8 accounting metric');
  return metric.quantity.value;
};
const fp8 = (rows: number, columns: number) => rows * columns + 4 * Math.ceil(rows / 128) * Math.ceil(columns / 128);

it.each(['v3', 'r1'] as const)('counts %s local FP8 weight blocks and sparse reads in an expert grid', async release => {
  const model = makeDeepSeekV3ParallelAssets(release), preset = makeDeepSeekV3FP8WeightPreset(model, release);
  if (preset.definition.kind !== 'quantization') throw Error('Missing published weight profile');
  const project = makeModelProject([...model, preset], {
    kind: 'prefill', batchSize: 1, pastTokensPerRequest: 2, queryTokensPerRequest: 1,
  }, release);
  const scenario = project.scenarios[0]!;
  scenario.bindings = ['Ldense', 'Lmoe'].map(parameterKey => ({ parameterKey, value: { kind: 'integer', value: 1 } }));
  scenario.quantizationOverrides = [{ ...preset.definition.quantization, preset: ref(preset) }];
  const degree = 8, H = 7168, width = 1024, experts = 64, routes = 2;
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, degree), assets: project.assetSnapshots,
    presetId: 'tp-mla-ep-routed', expertMesh: { ep: 4, tp: 2 }, network: { bytesPerSecond: 100e9, latencySeconds: 3e-6 } });
  if (attempt.status !== 'available') throw Error(attempt.message);
  const { preview } = attempt;
  const attention = fp8(1536, H) + fp8(3072, 1536) + fp8(576, H) + 2 * fp8(2048, 512) + fp8(H, 2048);
  const ffn = (channels: number) => 2 * fp8(channels, H) + fp8(H, channels);
  const norm = 2 * (2 * H + 1536 + 512);
  const localWeight = 4 * 129280 * H + 2 * H + 2 * (attention + norm) + ffn(18432) + ffn(2048) +
    256 * (2 * H + 4) + experts * ffn(width);
  expect(preview.allocations.map(row => [row.weightBytes, row.stateBytes])).toEqual(Array(degree).fill([localWeight, 6912]));
  const analyzed = await analyzeScenario(preview.scenario, preview.assets);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 3)));
  const layout = analyzed.result.distributed!.layout;
  const weight = layout.storageAllocations.find(row => row.storageId === 'moe[0]::expert-gate-weight')?.allocation;
  expect(weight?.perDevice.map(row => amount(row.totalBytes))).toEqual(Array(degree).fill(experts * fp8(width, H)));
  const gate = layout.localCosts.nodes.find(node => node.nodeId === 'moe[0]/expert-gate-up')?.placement;
  if (gate?.kind !== 'placed') throw Error('Missing routed gate and up');
  for (const { outcome } of gate.perDevice) {
    if (outcome.status !== 'available') throw Error('Missing expert feature rank');
    const cost = outcome.cost;
    expect(amount(cost.logicalReadBytes)).toBe(routes * (2 * fp8(width, H) + 2 * H + 8));
    expect(amount(cost.compute[0]?.usefulOperations)).toBe(4 * routes * H * width);
    expect(cost.compute[0]?.computeClass.multiplyDtype.format).toBe('bf16');
  }
  const capacity = await estimateKvCapacity(preview.scenario, preview.assets);
  expect(capacity).toMatchObject({ status: 'available', report: { replicatedBytesPerToken: 2304, budget: { status: 'available' } } });
}, 90_000);
