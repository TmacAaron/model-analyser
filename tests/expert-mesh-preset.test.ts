import { expect, it } from 'vitest';
import { ProjectDocument, type MetricValue } from '@model-analyser/contracts';
import { previewParallelPreset, resolveParallelPlan } from '@model-analyser/core';
import { bindDegreePool, currentDegrees, matchingParallelPresets, serialDegrees } from '../apps/web/src/parallel-degrees.js';
import { ref } from '../scripts/model-authoring.js';
import { makeModelProject } from '../scripts/model-project.js';
import { makeNamedParallelBase } from '../scripts/named-parallel-project.js';
import { makeQwen35FP8WeightPreset } from '../scripts/qwen35-fp8-weights.js';
import { makeQwenHybridParallelAssets } from '../scripts/qwen-hybrid-parallel.js';

const network = { bytesPerSecond: 100e9, latencySeconds: 3e-6 };
const value = (metric?: MetricValue) => {
  if (metric?.status !== 'available') throw Error('Expected an available metric');
  return metric.quantity.value;
};

it('shards Qwen experts and their FP8 weights within each owner while keeping global TopK', async () => {
  const assets = makeQwenHybridParallelAssets('qwen35', 4);
  const preset = makeQwen35FP8WeightPreset(assets);
  if (preset.definition.kind !== 'quantization') throw Error('Expected published weights');
  const project = makeModelProject([...assets, preset], { kind: 'prefill', batchSize: 1, queryTokensPerRequest: 1, pastTokensPerRequest: 3 }, 'Qwen FP8');
  const scenario = project.scenarios[0]!;
  scenario.bindings = [{ parameterKey: 'Periods', value: { kind: 'integer', value: 1 } }];
  scenario.quantizationOverrides = [{ ...preset.definition.quantization, preset: ref(preset) }];
  const degrees = { ...serialDegrees, moeEp: 4, moeTp: 2 }, presets = assets[0]!.parallelPresets!;
  const [match] = matchingParallelPresets(degrees, presets, scenario);
  expect(match).toMatchObject({ slots: 8, expertMesh: { ep: 4, tp: 2 } });
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, 8), assets: project.assetSnapshots,
    presetId: match!.preset.presetId, expertMesh: match!.expertMesh, network });
  if (attempt.status !== 'available') throw Error(attempt.message);
  const { preview } = attempt;
  expect(preview.communicationCount).toBe(4);
  expect(preview.communications?.every(row => row.operation === 'all_reduce' && row.algorithm.startupRounds === 14)).toBe(true);
  const saved = ProjectDocument.parse(JSON.parse(JSON.stringify({ ...project, scenarios: [preview.scenario] })));
  const reopened = saved.scenarios[0]!;
  expect(reopened.deviceTopology.devices).toHaveLength(8);
  expect(currentDegrees(reopened, presets)).toEqual(degrees);
  const plan = await resolveParallelPlan(reopened, saved.assetSnapshots);
  if (plan.status !== 'available') throw Error(JSON.stringify(plan.diagnostics.slice(0, 3)));
  const layout = plan.result;
  const weights = layout.storageAllocations.find(row => row.storageId === 'decoder[0]/full::expert-gate-up-weight')?.allocation;
  expect(weights?.distribution).toMatchObject({ kind: 'sharded', axes: [
    { tensorAxisId: 'expert', meshAxisId: 'expert' }, { tensorAxisId: 'i', meshAxisId: 'feature' },
  ] });
  const halfWidth = 512, hidden = 4096, localExperts = 128;
  const perExpert = 2 * hidden * halfWidth;
  const scales = perExpert / 128 ** 2 * 2;
  expect(weights?.perDevice.map(row => value(row.totalBytes))).toEqual(Array(8).fill(localExperts * (perExpert + scales)));
  const node = layout.localCosts.nodes.find(row => row.nodeId === 'decoder[0]/full/expert-gate-up')?.placement;
  if (node?.kind !== 'placed') throw Error('Expected expert gate and up placements');
  const localRoutes = [3, 3, 3, 3, 2, 2, 2, 2];
  expect(node.perDevice.map(row => {
    if (row.outcome.status !== 'available') throw Error('Expected local work');
    const cost = row.outcome.cost;
    return [value(cost.compute[0]?.usefulOperations), value(cost.compute[0]?.executedOperations)];
  })).toEqual(localRoutes.map(routes => [4 * routes * hidden * halfWidth, 4 * 3 * hidden * halfWidth]));

  const smaller = await previewParallelPreset({ ...bindDegreePool(reopened, 2), assets: saved.assetSnapshots, presetId: 'ep-routed', network });
  if (smaller.status !== 'available') throw Error(smaller.message);
  expect(smaller.preview.scenario.deviceTopology.groups).toHaveLength(1);
  expect(currentDegrees(smaller.preview.scenario, presets)).toEqual({ ...serialDegrees, moeEp: 2 });

  const invalid = await previewParallelPreset({ ...bindDegreePool(scenario, 6), assets: project.assetSnapshots,
    presetId: 'ep-routed', expertMesh: { ep: 2, tp: 3 }, network });
  expect(invalid).toMatchObject({ status: 'unavailable', message: expect.stringContaining('可整除 3') });

  const workload = { ...scenario.workload, batchSize: 2 };
  const requestReplicas = await previewParallelPreset({ ...bindDegreePool({ ...scenario, workload }, 8), assets: project.assetSnapshots,
    presetId: 'ep-routed', expertMesh: { ep: 2, tp: 2 }, requestDp: 2, network });
  if (requestReplicas.status !== 'available') throw Error(requestReplicas.message);
  const combined = requestReplicas.preview;
  expect(currentDegrees(combined.scenario, presets)).toEqual({ ...serialDegrees, attentionDp: 2, moeEp: 2, moeTp: 2 });
  expect(combined.communications?.every(row => row.algorithm.startupRounds === 6)).toBe(true);
  expect(combined.allocations.map(row => row.stateBytes)).toEqual(preview.allocations.map(row => row.stateBytes));
  const elements = 4 * 3 * hidden * 1024 * (512 / 8);
  const extraWeights = elements + elements / 128 ** 2 * 2;
  expect(combined.allocations.map((row, index) => row.weightBytes - preview.allocations[index]!.weightBytes)).toEqual(Array(8).fill(extraWeights));
}, 120_000);

it('still matches the fixed native EP2 × TP2 reference layout', () => {
  const project = makeNamedParallelBase('ep2-tp2');
  const model = project.assetSnapshots.find(asset => asset.definition.kind === 'model');
  expect(matchingParallelPresets({ ...serialDegrees, moeEp: 2, moeTp: 2 }, model?.parallelPresets ?? [], project.scenarios[0]!))
    .toMatchObject([{ preset: { presetId: 'ep2-tp2' }, slots: 4 }]);
});
