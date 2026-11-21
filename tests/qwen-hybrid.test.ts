import { expect, it } from 'vitest';
import { analyzeScenario, estimateKvCapacity, previewParallelPreset } from '@model-analyser/core';
import type { MetricValue } from '@model-analyser/contracts';
import { validateResult } from '../packages/contracts/src/result-validation.js';
import { validateProject } from '../packages/contracts/src/validation.js';
import { makeModelProject } from '../scripts/model-project.js';
import { makeQwenHybridAssets } from '../scripts/qwen-hybrid-model.js';
import { makeQwenHybridParallelAssets } from '../scripts/qwen-hybrid-parallel.js';
import { addQwenPipelineAttentionParallel, addQwenPipelinePreset, addQwenPipelineRequestParallel } from '../scripts/qwen-pipeline.js';
import { bindDegreePool, currentDegrees, matchingParallelPresets, serialDegrees } from '../apps/web/src/parallel-degrees.js';

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

it('shards both GQA cache and DeltaNet state within the two Qwen3.8 pipeline stages', async () => {
  const [root,...dependencies]=makeQwenHybridParallelAssets('qwen38');
  const model=addQwenPipelineAttentionParallel(addQwenPipelineRequestParallel(addQwenPipelinePreset(root!)),'tp-hybrid-attention');
  const project=makeModelProject([model,...dependencies],{kind:'prefill',batchSize:2,queryTokensPerRequest:2,pastTokensPerRequest:3},model.name);
  const scenario=project.scenarios[0]!,presets=model.parallelPresets!,dimensions={...serialDegrees,pp:2,attentionTp:2};
  expect(matchingParallelPresets(dimensions,presets,scenario)).toMatchObject([{slots:4,pipelineTp:2}]);
  const result=await previewParallelPreset({...bindDegreePool(scenario,4),assets:project.assetSnapshots,presetId:'pp-decoder',pipelineTp:2,
    network:{bytesPerSecond:100e9,latencySeconds:3e-6}});
  if(result.status!=='available')throw Error(result.message.slice(0,7000));
  const preview=result.preview, full=ledger(cases[1]), kv=2*5*full.kvPerToken/4,recurrent=2*full.recurrentBytes/4;
  expect(preview.allocations.map(row=>row.stateBytes)).toEqual(Array(4).fill(kv+recurrent));
  expect(preview.communications?.filter(row=>row.operation==='all_reduce')).toHaveLength(64);
  expect(preview.communications?.find(row=>row.operation==='send_recv')?.peerPairs).toHaveLength(2);
  expect(preview.communications?.every(row=>row.timing.kind==='bandwidth_latency'&&row.timing.bytePerSecond===100e9&&row.timing.latencySeconds===3e-6)).toBe(true);
  expect(await estimateKvCapacity(preview.scenario,preview.assets)).toMatchObject({status:'available',report:{
    averageBytesPerToken:full.kvPerToken,budget:{status:'available'},
    devices:Array(4).fill(expect.objectContaining({kvBytes:kv,otherStateBytes:recurrent})),
  }});
}, 140_000);

it.each([1, 2])('shards the owning-stage experts independently of global TopK with DP × PP × EP and expert TP %i', async moeTp => {
  const [root, ...dependencies] = makeQwenHybridParallelAssets('qwen35', 4);
  const model = addQwenPipelinePreset(root!, { requestBatchSharding: true, attentionPresetId: 'tp-hybrid-attention' });
  const project = makeModelProject([model, ...dependencies], {
    kind: 'prefill', batchSize: 4, queryTokensPerRequest: 1, pastTokensPerRequest: 2,
  }, model.name);
  const scenario = project.scenarios[0]!, presets = model.parallelPresets!;
  scenario.bindings = [{ parameterKey: 'Periods', value: { kind: 'integer', value: 3 } }];
  const dimensions = { ...serialDegrees, attentionDp: 2, pp: 2, moeEp: 4, moeTp };
  const stageWidth = 4 * moeTp, slots = 4 * stageWidth;
  const [match] = matchingParallelPresets(dimensions, presets, scenario);
  expect(match).toMatchObject({ slots, requestDp: 2, pipelineStage: { presetId: 'ep-routed', degree: stageWidth } });
  if (moeTp > 1) expect(match?.expertMesh).toEqual({ ep: 4, tp: moeTp });
  expect(matchingParallelPresets({ ...dimensions, moeTp: 2, attentionTp: 2 }, presets, scenario)).toEqual([]);
  const input = { ...bindDegreePool(scenario, slots), assets: project.assetSnapshots, presetId: match!.preset.presetId,
    requestDp: match!.requestDp, pipelineStage: match!.pipelineStage, expertMesh: match!.expertMesh, network: { bytesPerSecond: 20e9, latencySeconds: 5e-6 },
    pipelineTpNetwork: { bytesPerSecond: 100e9, latencySeconds: 3e-6 } };
  const attempt = await previewParallelPreset(input);
  if (attempt.status !== 'available') throw Error(attempt.message);
  const { preview } = attempt;
  expect(currentDegrees(preview.scenario, presets)).toEqual(dimensions);
  expect(preview.communicationCount).toBe(13);
  expect(preview.communications?.find(row => row.operation === 'send_recv')).toMatchObject({
    peerPairs: Array(2 * stageWidth).fill(expect.any(Object)), timing: { bytePerSecond: 20e9, latencySeconds: 5e-6 },
  });
  expect(preview.communications?.filter(row => row.operation === 'all_reduce').every(row =>
    row.timing.kind === 'bandwidth_latency' && row.timing.bytePerSecond === 100e9)).toBe(true);
  const fixture = cases[0], period = ledger(fixture, 1), base = ledger(fixture, 0);
  const expertBytes = 2 * 4 * 3 * fixture.hidden * fixture.ffn * fixture.experts;
  const localPeriodWeight = period.weightBytes - base.weightBytes - expertBytes * (1 - 1 / stageWidth);
  const embedding = 2 * 248320 * fixture.hidden;
  const periods = [2, 1, 2, 1].flatMap(count => Array(stageWidth).fill(count));
  expect(preview.allocations.map(row => row.weightBytes)).toEqual(periods.map(count =>
    count * localPeriodWeight + embedding + (count === 1 ? 2 * fixture.hidden : 0)));
  const kvBytes = 2 * 3 * period.kvPerToken, recurrentBytes = 2 * period.recurrentBytes;
  expect(preview.allocations.map(row => row.stateBytes)).toEqual(periods.map(count => count * (kvBytes + recurrentBytes)));

  const result = await analyzeScenario(preview.scenario, preview.assets);
  if (result.status !== 'available') throw Error(JSON.stringify(result.diagnostics.slice(0, 6)));
  expect(amount(result.result.total.seconds)).toBeGreaterThan(0);
  const layout = result.result.distributed?.layout, nodes = layout?.localCosts.nodes;
  const weights = layout?.storageAllocations.find(row => row.storageId === 'decoder[2]/full::expert-gate-up-weight');
  expect(weights?.allocation.distribution).toMatchObject({ kind: 'sharded', axes: [{ tensorAxisId: 'expert' },
    ...(moeTp > 1 ? [{ tensorAxisId: 'i', meshAxisId: 'rank:feature' }] : [])] });
  if (moeTp > 1) {
    const owner = preview.scenario.parallelPlan.generatedFrom?.expertMesh?.groupId;
    expect(preview.scenario.deviceTopology.groups.find(group => group.groupId === owner)?.mesh?.axes.slice(-2))
      .toEqual([{ axisId: 'expert', size: 4 }, { axisId: 'feature', size: moeTp }]);
    const reducedToSerialStages = await previewParallelPreset({ ...bindDegreePool(preview.scenario, 2), assets: preview.assets,
      presetId: match!.preset.presetId, network: input.network });
    if (reducedToSerialStages.status !== 'available') throw Error(reducedToSerialStages.message);
    expect(currentDegrees(reducedToSerialStages.preview.scenario, presets)).toEqual({ ...serialDegrees, pp: 2 });
  }
  const expert = nodes?.find(row => row.nodeId === 'decoder[2]/full/expert-gate-up')?.placement;
  if (expert?.kind !== 'placed') throw Error('Missing last-stage experts');
  expect(expert.perDevice.map(row => row.deviceId)).toEqual(preview.allocations.filter((_, index) => periods[index] === 1).map(row => row.deviceId));
  const operationsPerSlot = 4 * 2 * fixture.hidden * fixture.ffn / moeTp;
  expect(expert.perDevice.map(({ outcome }) => outcome.status === 'available' ? [
    amount(outcome.cost.compute[0]?.usefulOperations), amount(outcome.cost.compute[0]?.executedOperations),
  ] : null)).toEqual([3, 3, 2, 2, 3, 3, 2, 2].flatMap(routes =>
    Array(moeTp).fill([routes * operationsPerSlot, 3 * operationsPerSlot])));
  expect(await estimateKvCapacity(preview.scenario, preview.assets)).toMatchObject({ status: 'available', report: {
    averageBytesPerToken: stageWidth * 3 * period.kvPerToken, budget: { status: 'available' },
    devices: periods.map(count => ({ kvBytes: count * kvBytes, otherStateBytes: count * recurrentBytes })),
  } });
  expect(await previewParallelPreset({ ...input, ...bindDegreePool(scenario, 6 * moeTp), requestDp: undefined,
    expertMesh: moeTp > 1 ? { ep: 3, tp: moeTp } : undefined,
    pipelineStage: { presetId: 'ep-routed', degree: 3 * moeTp } })).toMatchObject({ status: 'unavailable', message: expect.stringContaining('可均分到 3') });
}, 120_000);

it('reuses the expert grid for flattened Attention TP only when the stage dimensions fit', async () => {
  const [root, ...dependencies] = makeQwenHybridParallelAssets('qwen35', 4);
  const model = addQwenPipelinePreset(root!, { requestBatchSharding: true, attentionPresetId: 'tp-hybrid-attention' });
  const project = makeModelProject([model, ...dependencies], {
    kind: 'prefill', batchSize: 1, pastTokensPerRequest: 2, queryTokensPerRequest: 1,
  }, model.name);
  const scenario = project.scenarios[0]!;
  scenario.bindings = [{ parameterKey: 'Periods', value: { kind: 'integer', value: 2 } }];
  const degrees = { ...serialDegrees, pp: 2, moeEp: 2, moeTp: 2, attentionTp: 4 };
  const [match] = matchingParallelPresets(degrees, model.parallelPresets!, scenario);
  expect(match).toMatchObject({ slots: 8, pipelineStage: { presetId: 'tp-hybrid-attention-ep-routed', degree: 4 } });
  const input = { ...bindDegreePool(scenario, 8), assets: project.assetSnapshots, presetId: 'pp-decoder',
    pipelineStage: match!.pipelineStage, expertMesh: match!.expertMesh, network: { bytesPerSecond: 100e9, latencySeconds: 3e-6 } };
  expect(await previewParallelPreset(input)).toMatchObject({ status: 'unavailable', message: expect.stringContaining('可均分到 4') });
  input.scenario.bindings = [...scenario.bindings, { parameterKey: 'NK', value: { kind: 'integer', value: 4 } }];
  const attempt = await previewParallelPreset(input);
  if (attempt.status !== 'available') throw Error(attempt.message);
  expect(currentDegrees(attempt.preview.scenario, model.parallelPresets!)).toEqual(degrees);
  expect(attempt.preview.communicationCount).toBe(17);
  const perStageState = 3 * 2 * 2 * 256 + ledger(cases[0], 1).recurrentBytes / 4;
  expect(attempt.preview.allocations.map(row => row.stateBytes)).toEqual(Array(8).fill(perStageState));
}, 120_000);

it.each([
  [1, 'ep-routed', 'moeEp', 9], [2, 'tp-hybrid-attention-ep-routed', 'moeEp', 17],
  [1, 'tp-routed-expert', 'moeTp', 9], [2, 'tp-hybrid-attention-routed-expert', 'moeTp', 17],
] as const)('reuses the stage pool with Attention TP %i and %s', async (attentionTp, presetId, axis, communicationCount) => {
  const [root, ...dependencies] = makeQwenHybridParallelAssets('qwen35', 4);
  const model = addQwenPipelinePreset(root!, { requestBatchSharding: true, attentionPresetId: 'tp-hybrid-attention' });
  const project = makeModelProject([model, ...dependencies], {
    kind: 'decode', batchSize: 1, contextTokensPerRequest: 2, queryTokensPerRequest: 1, steps: 2,
  }, model.name);
  const scenario = project.scenarios[0]!;
  scenario.bindings = [{ parameterKey: 'Periods', value: { kind: 'integer', value: 2 } }];
  const degrees = { ...serialDegrees, pp: 2, attentionTp, [axis]: 2 };
  const [match] = matchingParallelPresets(degrees, model.parallelPresets!, scenario);
  expect(match).toMatchObject({ slots: 4, pipelineStage: { presetId, degree: 2 } });
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, 4), assets: project.assetSnapshots,
    presetId: 'pp-decoder', pipelineStage: match!.pipelineStage, network: { bytesPerSecond: 100e9, latencySeconds: 3e-6 } });
  if (attempt.status !== 'available') throw Error(attempt.message);
  expect(attempt.preview.communicationCount).toBe(communicationCount);
  expect(currentDegrees(attempt.preview.scenario, model.parallelPresets!)).toEqual(degrees);
  expect(attempt.preview.communications?.find(row => row.operation === 'send_recv')?.peerPairs).toHaveLength(2);
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
