import { expect, it } from 'vitest';
import { AssetDocument, type MetricValue } from '@model-analyser/contracts';
import { estimateKvCapacity, previewParallelPreset, resolveParallelPlan } from '@model-analyser/core';
import { bindDegreePool } from '../apps/web/src/parallel-degrees.js';
import { makeGlm52FP8WeightPreset } from '../scripts/glm52-fp8-weights.js';
import { makeGlm52ParallelAssets } from '../scripts/glm52-parallel.js';
import { ref } from '../scripts/model-authoring.js';
import { makeModelProject, referenceHardware } from '../scripts/model-project.js';

const fp8 = (rows: number, columns: number) => rows * columns + 4 * Math.ceil(rows / 128) * Math.ceil(columns / 128);
const value = (metric?: MetricValue) => {
  if (metric?.status !== 'available') throw Error('Expected an available GLM-5.2 metric');
  return metric.quantity.value;
};

it('counts published FP8 matrices and shared KV up-projection scales on all eight ranks', async () => {
  const assets = makeGlm52ParallelAssets(), preset = makeGlm52FP8WeightPreset(assets);
  const reference = referenceHardware();
  if (preset.definition.kind !== 'quantization' || reference.definition.kind !== 'hardware') throw Error('Missing format or device');
  const hardware = AssetDocument.parse({ ...reference, assetId: 'example:hardware:glm-5.2-fp8-test',
    definition: { ...reference.definition, hardware: { ...reference.definition.hardware, capacityBytes: 120_000_000_000 } } });
  const project = makeModelProject([...assets, preset, hardware], { kind: 'decode', batchSize: 1,
    contextTokensPerRequest: 3, queryTokensPerRequest: 1, steps: 1 }, 'GLM-5.2 published FP8');
  const scenario = project.scenarios[0]!;
  scenario.deviceTopology.devices[0]!.hardware = ref(hardware);
  scenario.quantizationOverrides = [{ ...preset.definition.quantization, preset: ref(preset) }];
  const degree = 8, heads = 8, hidden = 6144, rank = 2048, expertRank = 1024, latent = 512;
  const localExperts = 64, localRoutes = 2, rowsPerHead = 192 + 256;
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, degree), assets: project.assetSnapshots,
    presetId: 'tp-glm-attention-ep', expertMesh: { ep: 4, tp: 2 }, network: { bytesPerSecond: 100e9, latencySeconds: 3e-6 } });
  if (attempt.status !== 'available') throw Error(attempt.message);
  const { preview } = attempt;
  const projection = fp8(heads * rowsPerHead, latent);
  const attention = fp8(rank, hidden) + fp8(heads * 256, rank) + fp8(576, hidden) + projection + fp8(hidden, heads * 256);
  const norm = 2 * (2 * hidden + rank + latent);
  const indexer = fp8(4096, rank) + fp8(128, hidden) + 2 * (32 * hidden + 2 * 128);
  const ffn = (width: number) => 2 * fp8(width, hidden) + fp8(hidden, width);
  const localWeight = 4 * 154880 * hidden + 2 * hidden + 78 * (attention + norm) + 21 * indexer + 3 * ffn(12288) +
    75 * (256 * (2 * hidden + 4) + ffn(2048) + localExperts * ffn(expertRank));
  const perToken = 95_232;
  expect(preview.allocations.map(row => [row.weightBytes, row.stateBytes])).toEqual(Array(degree).fill([localWeight, 4 * perToken]));
  expect(preview.communicationCount).toBe(153);
  const result = await resolveParallelPlan(preview.scenario, preview.assets);
  if (result.status !== 'available') throw Error(JSON.stringify(result.diagnostics.slice(0, 5)));
  const layout = result.result;
  const packed = layout.storageAllocations.find(row => row.storageId === 'dense[0]::k-absorb-weight');
  expect(packed?.allocation.perDevice.map(row => [
    value(row.allocation.payloadBytes), value(row.allocation.auxiliaryBytes[0]?.bytes),
  ])).toEqual(Array(degree).fill([heads * rowsPerHead * latent, 448]));
  expect(layout.storageAllocations.some(row => row.storageId === 'dense[0]::v-up-weight')).toBe(false);
  const local = (id: string) => {
    const node = layout.localCosts.nodes.find(row => row.nodeId === id)?.placement;
    if (node?.kind !== 'placed') throw Error('Missing GLM-5.2 node ' + id);
    return node.perDevice.map(({ outcome }) => {
      if (outcome.status !== 'available') throw Error('Missing GLM-5.2 rank');
      return outcome.cost;
    });
  };
  const keyReads = local('dense[0]/q-absorb');
  const valueReads = local('dense[0]/v-up');
  for (const [index, key] of keyReads.entries()) {
    expect(value(key.logicalReadBytes) + value(valueReads[index]?.logicalReadBytes) - 2 * heads * (192 + latent)).toBeCloseTo(projection, 6);
  }
  for (const gate of local('decoder[0]/source/expert-gate-up')) {
    expect(value(gate.logicalReadBytes)).toBe(localRoutes * (2 * fp8(expertRank, hidden) + 2 * hidden + 4));
    expect(value(gate.compute[0]?.usefulOperations)).toBe(4 * localRoutes * hidden * expertRank);
    expect(gate.compute[0]?.computeClass.multiplyDtype.format).toBe('bf16');
  }
  const capacity = await estimateKvCapacity(preview.scenario, preview.assets);
  expect(capacity).toMatchObject({ status: 'available', report: { averageBytesPerToken: degree * perToken,
    replicatedBytesPerToken: perToken, modelContextLimit: { tokensPerRequest: 1_048_576 },
    budget: { status: 'available' } } });
}, 150_000);
