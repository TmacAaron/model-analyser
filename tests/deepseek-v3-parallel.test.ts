import { expect, it } from 'vitest';
import { AnalysisResult, ParallelResolutionAttempt, type MetricValue } from '@model-analyser/contracts';
import { analyzeScenario, estimateKvCapacity, previewParallelPreset } from '@model-analyser/core';
import { makeModelProject } from '../scripts/model-project.js';
import { makeDeepSeekV3ParallelAssets } from '../scripts/deepseek-v3-parallel.js';
import { bindDegreePool, matchingParallelPresets, serialDegrees } from '../apps/web/src/parallel-degrees.js';
import { encodeAnalysisCompletion, readAnalysisCompletion } from '../apps/web/src/analysis-result-transport.js';

function amount(value: MetricValue | undefined) {
  if (value?.status !== 'available') throw Error('Expected known metric ' + JSON.stringify(value));
  return value.quantity.value;
}

function setup(release: 'v3' | 'r1') {
  const p = makeModelProject(makeDeepSeekV3ParallelAssets(release), {
    kind: 'prefill', batchSize: 1, pastTokensPerRequest: 2, queryTokensPerRequest: 1,
  }, release);
  const scenario = p.scenarios[0]!;
  scenario.bindings = ['Ldense', 'Lmoe'].map(parameterKey => ({ parameterKey, value: { kind: 'integer', value: 1 } }));
  return { scenario, assets: p.assetSnapshots };
}

it.each(['v3', 'r1'] as const)('runs %s attention and striped expert sharding on the same two cards', async release => {
  const { scenario, assets } = setup(release);
  const model = assets.find(asset => asset.assetId === scenario.model.assetId)!;
  const modes = model.parallelPresets!;
  expect(matchingParallelPresets({ ...serialDegrees, attentionDp: 2 }, modes, scenario).map(match => match.preset.presetId)).toEqual(['dp-batch']);
  expect(matchingParallelPresets({ ...serialDegrees, attentionTp: 2, moeEp: 2 }, modes, scenario).map(match => match.slots)).toEqual([2]);
  expect(matchingParallelPresets({ ...serialDegrees, attentionTp: 2, moeEp: 4 }, modes, scenario)).toEqual([]);
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, 2), assets, presetId: 'tp-mla-ep-routed',
    network: { bytesPerSecond: 100e9, latencySeconds: 3e-6 } });
  if (attempt.status !== 'available') throw Error(attempt.message);
  const { preview } = attempt;
  const { communications, allocations } = preview;
  expect(allocations.map(row => [row.weightBytes, row.stateBytes])).toEqual([[16_270_048_256, 6912], [16_270_048_256, 6912]]);
  expect(communications?.map(row => row.placement?.beforeNodeIds[0])).toEqual(['dense[0]/attention-residual', 'moe[0]/attention-residual', 'moe[0]/shared-add']);
  const analyzed = await analyzeScenario(preview.scenario, preview.assets);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 3)));
  const result = analyzed.result, layout = result.distributed!.layout;
  expect(AnalysisResult.safeParse(result).success).toBe(true);
  expect(ParallelResolutionAttempt.safeParse({ status: 'available', result: layout }).success).toBe(true);
  const local = (id: string) => layout.localCosts.nodes.find(node => node.nodeId === id)?.placement;
  const work = (id: string) => {
    const placement = local(id);
    if (placement?.kind !== 'placed') throw Error('Missing placement ' + id);
    return placement.perDevice.map(row => row.outcome.status === 'available' ? amount(row.outcome.cost.compute[0]?.usefulOperations) : -1);
  };
  expect(work('dense[0]/q-proj')).toEqual(Array(2).fill(2 * 1536 * 64 * 192));
  expect(work('moe[0]/route-weights')).toEqual([24, 24]);
  expect(work('moe[0]/expert-gate-up')).toEqual(Array(2).fill(4 * 4 * 7168 * 2048));
  expect(layout.storageAllocations.find(row => row.storageId === 'moe[0]::expert-up-weight')?.allocation.distribution)
    .toMatchObject({ kind: 'sharded', axes: [{ tensorAxisId: 'owner-expert' }] });
  expect(layout.storageAllocations.find(row => row.storageId === 'moe[0]::cache-latent')?.allocation.distribution.kind).toBe('replicated');
  expect(amount(result.total.seconds)).toBeGreaterThan(0);
  const packet = encodeAnalysisCompletion(analyzed, 1);
  expect(packet).toMatchObject({ encoding: 'decode-provenance.1' });
  expect(readAnalysisCompletion(packet, 1)).toEqual(analyzed);
  const budget = await estimateKvCapacity(preview.scenario, preview.assets);
  expect(budget).toMatchObject({ status: 'available', report: { averageBytesPerToken: 4608, replicatedBytesPerToken: 2304,
    budget: { status: 'available', more: [{ bytes: 2304 }, { bytes: 2304 }] } } });
}, 90_000);

it.each(['v3', 'r1'] as const)('balances eight global routes over sixteen expert ranks for %s', async release => {
  const { scenario, assets } = setup(release);
  const degree = 16;
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, degree), assets, presetId: 'tp-mla-ep-routed',
    network: { bytesPerSecond: 100e9, latencySeconds: 3e-6 } });
  if (attempt.status !== 'available') throw Error(attempt.message);
  const { preview } = attempt;
  expect(preview.allocations).toHaveLength(degree);
  expect(new Set(preview.allocations.map(row => row.weightBytes)).size).toBe(1);
  expect(preview.communicationCount).toBe(3);
  const analyzed = await analyzeScenario(preview.scenario, preview.assets);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 3)));
  const layout = analyzed.result.distributed!.layout;
  const placement = layout.localCosts.nodes.find(node => node.nodeId === 'moe[0]/expert-gate-up')?.placement;
  if (placement?.kind !== 'placed') throw Error('Missing MoE placement');
  const costs = placement.perDevice.map(({ outcome }) => {
    if (outcome.status !== 'available') throw Error('Missing expert rank cost');
    return outcome.cost;
  });
  const validSlots = [...Array(8).fill(1), ...Array(8).fill(0)];
  const perSlot = 4 * 7168 * 2048;
  expect(costs.map(cost => amount(cost.compute[0]?.usefulOperations))).toEqual(validSlots.map(count => count * perSlot));
  expect(costs.map(cost => amount(cost.compute[0]?.executedOperations))).toEqual(Array(degree).fill(perSlot));
  expect(costs.map(cost => amount(cost.logicalReadBytes))).toEqual(validSlots.map(count => 2 * 7168 + 8 + count * perSlot));
  const partition = (name: string) => layout.tensorLayouts.find(row =>
    row.nodeId === 'moe[0]/expert-gate-up' && row.tensorId === 'moe[0]::' + name)?.partition;
  expect(partition('expert-route-ids')?.placements.map(rank => [rank.logicalElements, rank.allocatedElements]))
    .toEqual(validSlots.map(count => [count, 1]));
  expect(partition('expert-gate-weight')?.placements.map(rank => rank.slices.find(slice => slice.axisId === 'owner-expert')))
    .toEqual(Array.from({ length: degree }, (_, index) => expect.objectContaining({ start: index * 16, end: (index + 1) * 16 })));
  expect(amount(analyzed.result.total.seconds)).toBeGreaterThan(0);
  const capacity = await estimateKvCapacity(preview.scenario, preview.assets);
  expect(capacity).toMatchObject({ status: 'available', report: { averageBytesPerToken: degree * 2304,
    replicatedBytesPerToken: 2304, budget: { status: 'available' } } });
}, 90_000);

it('still rejects a degree that cannot split the total expert weights evenly', async () => {
  const { scenario, assets } = setup('v3');
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, 3), assets, presetId: 'ep-routed',
    network: { bytesPerSecond: 100e9, latencySeconds: 3e-6 } });
  expect(attempt.status).toBe('unavailable');
});
