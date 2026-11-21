import { expect, it } from 'vitest';
import { analyzeScenario, estimateKvCapacity, previewParallelPreset } from '@model-analyser/core';
import type { MetricValue } from '@model-analyser/contracts';
import { validateResult } from '../packages/contracts/src/result-validation.js';
import { validateProject } from '../packages/contracts/src/validation.js';
import { makeModelProject } from '../scripts/model-project.js';
import { makeQwenHybridAssets } from '../scripts/qwen-hybrid-model.js';
import { makeQwenHybridParallelAssets } from '../scripts/qwen-hybrid-parallel.js';
import { addQwenPipelinePreset, addQwenPipelineRequestParallel } from '../scripts/qwen-pipeline.js';
import { bindDegreePool, matchingParallelPresets, serialDegrees } from '../apps/web/src/parallel-degrees.js';

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

it.each([1, 2])('keeps whole GQA and DeltaNet periods in Qwen3.8 stages for %i request groups', async replicas => {
  const [root, ...dependencies] = makeQwenHybridParallelAssets('qwen38');
  const pipeline = addQwenPipelinePreset(root!);
  const model = replicas > 1 ? addQwenPipelineRequestParallel(pipeline) : pipeline;
  const groupBatch = replicas > 1 ? 2 : 1;
  const project = makeModelProject([model, ...dependencies], {
    kind: 'prefill', batchSize: replicas * groupBatch, queryTokensPerRequest: 1, pastTokensPerRequest: 2,
  }, model.name);
  const attempt = await previewParallelPreset({ ...bindDegreePool(project.scenarios[0]!, 2 * replicas), assets: project.assetSnapshots,
    presetId: 'pp-decoder', ...(replicas > 1 ? { requestDp: replicas } : {}), network: { bytesPerSecond: 100e9, latencySeconds: 3e-6 } });
  if (attempt.status !== 'available') throw Error(attempt.message.slice(0, 5000));
  const { preview } = attempt;
  const full = ledger(cases[1]), base = ledger(cases[1], 0), embedding = 2 * 248320 * 5120;
  const stageWeight = embedding + (full.weightBytes - base.weightBytes) / 2;
  expect(preview.allocations.map(row => row.weightBytes)).toEqual(Array.from({ length: replicas }, () => [stageWeight, stageWeight + 2 * 5120]).flat());
  expect(preview.allocations.map(row => row.stateBytes)).toEqual(Array(2 * replicas).fill(groupBatch * (full.recurrentBytes + 3 * full.kvPerToken) / 2));
  expect(preview.communications).toHaveLength(1);
  expect(await estimateKvCapacity(preview.scenario, preview.assets)).toMatchObject({ status: 'available', report: {
    averageBytesPerToken: full.kvPerToken, budget: { status: 'available' },
    devices: Array(2 * replicas).fill(expect.objectContaining({ otherStateBytes: groupBatch * full.recurrentBytes / 2 })),
  } });
  const single = await previewParallelPreset({ ...bindDegreePool(preview.scenario, 1), assets: preview.assets, presetId: 'replicated' });
  if (single.status !== 'available') throw Error(single.message);
  expect(single.preview.scenario.deviceTopology.groups).toHaveLength(1);
  expect(single.preview.allocations.map(row => row.weightBytes)).toEqual([full.weightBytes]);
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

function hybridCase(release: 'qwen35' | 'qwen38', revision: 2 | 3 = 2) {
  const project = makeModelProject(makeQwenHybridParallelAssets(release, revision), {
    kind: 'prefill', batchSize: 2, queryTokensPerRequest: 1, pastTokensPerRequest: 2,
  }, release);
  const scenario = project.scenarios[0]!;
  scenario.bindings = [{ parameterKey: 'Periods', value: { kind: 'integer', value: 1 } }];
  return { scenario, assets: project.assetSnapshots };
}

async function previewHybrid(release: 'qwen35' | 'qwen38', degree: number, presetId: string, revision: 2 | 3 = 2) {
  const { scenario, assets } = hybridCase(release, revision);
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, degree), assets, presetId,
    network: { bytesPerSecond: 100e9, latencySeconds: 3e-6 } });
  if (attempt.status !== 'available') throw Error(attempt.message);
  return attempt.preview;
}

it('shards Qwen3.8 KV and all DeltaNet state channels on the same four attention ranks', async () => {
  const fixture = cases[1], expected = ledger(fixture, 1);
  const preview = await previewHybrid('qwen38', 4, 'tp-hybrid-attention');
  const { scenario, assets } = preview;
  expect(preview.communicationCount).toBe(4);
  expect(preview.communications?.map(row => row.placement?.beforeNodeIds[0])).toEqual([
    'decoder[0]/linear[0]/attention-residual', 'decoder[0]/linear[1]/attention-residual',
    'decoder[0]/linear[2]/attention-residual', 'decoder[0]/full/attention-residual',
  ]);
  const { hidden, queryHeads, keyHeads, linearValueHeads } = fixture;
  const value = linearValueHeads * 128, channels = 2 * 16 * 128 + value;
  const shardedWeights = 2 * (3 * (hidden * (channels + 2 * value + 2 * linearValueHeads) + 4 * channels + 2 * linearValueHeads) +
    hidden * 256 * (3 * queryHeads + 2 * keyHeads));
  expect(preview.allocations.map(row => [row.weightBytes, row.stateBytes])).toEqual(Array(4).fill([
    expected.weightBytes - 3 * shardedWeights / 4, (2 * expected.recurrentBytes + 6 * expected.kvPerToken) / 4,
  ]));
  const analyzed = await analyzeScenario(scenario, assets);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 4)));
  expect(amount(analyzed.result.total.seconds)).toBeGreaterThan(0);
  const layout = analyzed.result.distributed!.layout;
  const local = (suffix: string) => layout.localCosts.nodes.find(row => row.nodeId.endsWith(suffix))?.placement;
  const mixed = local('/linear[0]/delta-qkv'), conv = local('/linear[0]/convolve');
  if (mixed?.kind !== 'placed' || conv?.kind !== 'placed') throw Error('Missing DeltaNet placement');
  expect(mixed.perDevice.map(row => row.outcome.status === 'available' ? amount(row.outcome.cost.compute[0]?.usefulOperations) : -1))
    .toEqual(Array(4).fill(2 * 2 * hidden * (channels / 4)));
  expect(conv.perDevice.map(row => row.outcome.status === 'available' ? amount(row.outcome.cost.compute[0]?.usefulOperations) : -1))
    .toEqual(Array(4).fill(2 * (channels / 4) * 13));
  const capacity = await estimateKvCapacity(scenario, assets);
  expect(capacity).toMatchObject({ status: 'available', report: { averageBytesPerToken: expected.kvPerToken,
    shardedBytesPerToken: expected.kvPerToken / 4,
    devices: Array(4).fill({ otherStateBytes: expected.recurrentBytes / 2 }),
    budget: { status: 'available', more: Array(4).fill({ bytes: expected.kvPerToken / 2 }) },
  } });
  const decode = await analyzeScenario({ ...scenario, workload: {
    kind: 'decode', batchSize: 2, queryTokensPerRequest: 1, contextTokensPerRequest: 2, steps: 2,
  } }, assets);
  if (decode.status !== 'available' || !decode.result.decode) throw Error('Missing distributed Decode result');
  const steps = decode.result.decode.steps;
  expect(steps.map(step => step.contextAfter)).toEqual([3, 4]);
  for (const [index, step] of steps.entries()) {
    const bytes = (kind: 'replace' | 'append') => step.stateTransitions.filter(state => state.policy.kind === kind)
      .flatMap(state => state.storages).reduce((total, storage) => total + amount(storage.afterBytes), 0);
    expect(bytes('replace')).toBe(2 * expected.recurrentBytes);
    expect(bytes('append')).toBe(2 * (3 + index) * expected.kvPerToken);
  }
  const baseline = hybridCase('qwen38');
  const unsupported = await previewParallelPreset({ ...bindDegreePool(baseline.scenario, 8), assets: baseline.assets,
    presetId: 'tp-hybrid-attention', network: { bytesPerSecond: 100e9, latencySeconds: 3e-6 } });
  expect(unsupported).toMatchObject({ status: 'unavailable' });
}, 120_000);

it.each([8, 16])('retains ten logical routes with independently sharded expert weights at EP %i', async degree => {
  const fixture = cases[0], expected = ledger(fixture, 1);
  const preview = await previewHybrid('qwen35', degree, 'ep-routed', 3);
  expect(preview.communicationCount).toBe(4);
  expect(preview.communications?.every(row => row.placement?.beforeNodeIds[0]?.endsWith('/shared-add'))).toBe(true);
  const expertWeightBytes = 2 * 4 * 3 * fixture.hidden * fixture.ffn * fixture.experts;
  expect(preview.allocations.map(row => [row.weightBytes, row.stateBytes])).toEqual(Array(degree).fill([
    expected.weightBytes - expertWeightBytes + expertWeightBytes / degree, 2 * expected.recurrentBytes + 6 * expected.kvPerToken,
  ]));
  const analyzed = await analyzeScenario(preview.scenario, preview.assets);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 4)));
  expect(amount(analyzed.result.total.seconds)).toBeGreaterThan(0);
  expect(validateResult(analyzed.result)).toEqual([]);
  const { localCosts, tensorLayouts } = analyzed.result.distributed!.layout;
  const layer = 'decoder[0]/full/';
  const local = localCosts.nodes.find(node => node.nodeId === layer + 'expert-gate-up')?.placement;
  if (local?.kind !== 'placed') throw Error('Missing EP local cost');
  const routes = degree === 8 ? [2,2,1,1,1,1,1,1] : [...Array(10).fill(1), ...Array(6).fill(0)];
  const slots = Math.ceil(10 / degree), perRoute = 4 * 2 * fixture.hidden * fixture.ffn;
  const outcomes = local.perDevice.map(row => {
    if (row.outcome.status !== 'available') throw Error('Missing EP rank cost');
    return row.outcome.cost;
  });
  expect(outcomes.map(cost => amount(cost.compute[0]?.usefulOperations))).toEqual(routes.map(count => count * perRoute));
  expect(outcomes.map(cost => amount(cost.compute[0]?.executedOperations))).toEqual(Array(degree).fill(slots * perRoute));
  const reservedInputs = 2 * slots * (2 * fixture.hidden + 8);
  expect(outcomes.map(cost => amount(cost.logicalReadBytes))).toEqual(routes.map(count => reservedInputs + count * perRoute));
  const ids = tensorLayouts.find(row => row.nodeId === layer + 'expert-gate-up' && row.tensorId.endsWith('owner-route-ids'))?.partition;
  expect(ids?.placements.map(rank => [rank.logicalElements, rank.allocatedElements])).toEqual(routes.map(count => [2 * count, 2 * slots]));
  const weights = tensorLayouts.find(row => row.nodeId === layer + 'expert-gate-up' && row.tensorId.endsWith('expert-gate-up-weight'))?.partition;
  expect(weights?.placements.at(-1)?.slices.find(slice => slice.axisId === 'expert')).toMatchObject({
    start: fixture.experts - fixture.experts / degree, end: fixture.experts,
  });
  if (degree === 8) {
    const budget = await estimateKvCapacity(preview.scenario, preview.assets);
    expect(budget).toMatchObject({ status: 'available', report: {
      averageBytesPerToken: 8 * expected.kvPerToken, replicatedBytesPerToken: expected.kvPerToken,
    } });
  }
}, 120_000);

it('uses two cards when Attention TP and MoE EP share the same two slots', async () => {
  const { scenario, assets } = hybridCase('qwen35', 3);
  const presets = assets[0]?.parallelPresets ?? [];
  expect(matchingParallelPresets({ ...serialDegrees, moeEp: 8 }, presets, scenario).map(row => row.slots)).toEqual([8]);
  expect(matchingParallelPresets({ ...serialDegrees, moeEp: 2, attentionTp: 2 }, presets, scenario).map(row => row.slots)).toEqual([2]);
  const preview = await previewHybrid('qwen35', 2, 'tp-hybrid-attention-ep-routed', 3);
  expect(preview.deviceIds).toHaveLength(2);
  expect(preview.communicationCount).toBe(8);
  expect(preview.communications?.filter(row => row.placement?.beforeNodeIds[0]?.endsWith('/attention-residual'))).toHaveLength(4);
}, 120_000);

it('executes Qwen3.5 router selections on every expert TP rank but shards each expert intermediate', async () => {
  const fixture = cases[0], expected = ledger(fixture, 1);
  const preview = await previewHybrid('qwen35', 8, 'tp-routed-expert');
  expect(preview.communicationCount).toBe(4);
  expect(preview.communications?.every(row => row.placement?.beforeNodeIds[0]?.endsWith('/shared-add'))).toBe(true);
  const expertWeights = 2 * 4 * 3 * fixture.hidden * fixture.ffn * fixture.experts;
  expect(preview.allocations.map(row => row.weightBytes)).toEqual(Array(8).fill(expected.weightBytes - 7 * expertWeights / 8));
  const analyzed = await analyzeScenario(preview.scenario, preview.assets);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 4)));
  expect(amount(analyzed.result.total.seconds)).toBeGreaterThan(0);
  const costs = analyzed.result.distributed!.layout.localCosts;
  const work = (suffix: string) => {
    const placement = costs.nodes.find(row => row.nodeId.endsWith(suffix))?.placement;
    if (placement?.kind !== 'placed') throw Error('Missing MoE placement');
    return placement.perDevice.map(row => row.outcome.status === 'available' ? amount(row.outcome.cost.compute[0]?.usefulOperations) : -1);
  };
  expect(work('/full/topk')).toEqual(Array(8).fill(2 * fixture.experts * 10));
  expect(work('/full/expert-gate-up')).toEqual(Array(8).fill(4 * 2 * 10 * fixture.hidden * fixture.ffn / 8));
  expect(work('/full/combine')).toEqual(Array(8).fill(2 * 2 * 10 * fixture.hidden));
  const budget = await estimateKvCapacity(preview.scenario, preview.assets);
  expect(budget).toMatchObject({ status: 'available', report: {
    averageBytesPerToken: 8 * expected.kvPerToken, replicatedBytesPerToken: expected.kvPerToken,
  } });
}, 120_000);

it('matches whole-request DP and the shared-pool hybrid TP when degrees agree', async () => {
  const { scenario, assets } = hybridCase('qwen35');
  const presets = assets.find(asset => asset.assetId === scenario.model.assetId)?.parallelPresets ?? [];
  expect(matchingParallelPresets({ ...serialDegrees, attentionDp: 2 }, presets, scenario).map(row => row.preset.presetId))
    .toEqual(['dp-batch']);
  expect(matchingParallelPresets({ ...serialDegrees, attentionTp: 2, moeTp: 2 }, presets, scenario).map(row => row.slots)).toEqual([2]);
  expect(matchingParallelPresets({ ...serialDegrees, attentionTp: 2, moeTp: 4 }, presets, scenario)).toEqual([]);
  const shared = await previewHybrid('qwen35', 2, 'tp-hybrid-attention-routed-expert');
  expect(shared.communicationCount).toBe(8);
  const dp = await previewHybrid('qwen38', 2, 'dp-batch');
  expect(dp.communicationCount).toBe(0);
  expect(dp.allocations.map(row => [row.weightBytes, row.stateBytes]))
    .toEqual(Array(2).fill([ledger(cases[1], 1).weightBytes, ledger(cases[1], 1).recurrentBytes + 3 * ledger(cases[1], 1).kvPerToken]));
}, 120_000);
