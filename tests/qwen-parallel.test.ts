import { expect, it } from 'vitest';
import { DeviceId, NodeId, Scenario, type MetricValue } from '@model-analyser/contracts';
import { analyzeScenario, estimateKvCapacity, previewParallelPreset, replayCommunicationCostSource, resolveParallelPlan } from '@model-analyser/core';
import { currentDegrees, matchingParallelPresets, serialDegrees } from '../apps/web/src/parallel-degrees.js';
import { validateResult } from '../packages/contracts/src/result-validation.js';
import { makeModelProject } from '../scripts/model-project.js';
import { makeQwenParallelAssets } from '../scripts/qwen-parallel-assets.js';
import { addQwenPipelineAttentionParallel, addQwenPipelinePreset, addQwenPipelineRequestParallel } from '../scripts/qwen-pipeline.js';

const hidden = 2048, width = 128, queries = 16, kvHeads = 8, layers = 28, intermediate = 6144, vocab = 151936;
const attentionMatrices = hidden * width * (2 * queries + 2 * kvHeads);
const replicaParameters = 2 * hidden + 2 * width + 3 * hidden * intermediate;
const rootParameters = hidden * vocab + hidden;

function count(metric: MetricValue | undefined) {
  if (metric?.status !== 'available') throw Error('Expected known model cost');
  return metric.quantity.value;
}

function prepare(workload: Scenario['workload'], layerCount = layers, deviceCount = 2) {
  const assets = makeQwenParallelAssets().filter(asset => asset.assetId !== 'builtin:model:qwen3-0.6b');
  const project = makeModelProject(assets, workload, 'Qwen3-1.7B parallel');
  const scenario = project.scenarios[0]!, primary = scenario.deviceTopology.devices[0]!;
  const devices = Array.from({ length: deviceCount }, (_, index) => ({ ...primary, deviceId: DeviceId.parse('gpu' + index) }));
  scenario.deviceTopology = {
    devices,
    groups: [{ groupId: 'parallel', members: devices.map(device => device.deviceId) }],
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

it('reduces TP outputs independently for each DP request group and sizes growing KV', async () => {
  const input = prepare({ kind: 'decode', batchSize: 4, queryTokensPerRequest: 1, contextTokensPerRequest: 2, steps: 2 }, 2, 4);
  const presets = input.assets.find(asset => asset.assetId === input.scenario.model.assetId)?.parallelPresets ?? [];
  const degrees = { ...serialDegrees, attentionDp: 2, attentionTp: 2 };
  const [match] = matchingParallelPresets(degrees, presets, input.scenario);
  expect(match).toMatchObject({ slots: 4, requestDp: 2, preset: { presetId: 'tp-attention-heads' } });
  const request = { ...input, requestDp: 2, presetId: match!.preset.presetId, network: { bytesPerSecond: 1e11, latencySeconds: 1e-6 } };
  expect(await previewParallelPreset({ ...request, scenario: { ...input.scenario, workload: { ...input.scenario.workload, batchSize: 3 } } }))
    .toMatchObject({ status: 'unavailable', message: expect.stringContaining('Batch') });
  const attempt = await previewParallelPreset(request);
  if (attempt.status !== 'available') throw Error(attempt.message);
  const { preview } = attempt;
  const reopened = Scenario.parse(JSON.parse(JSON.stringify(preview.scenario)));
  expect(currentDegrees(reopened, presets)).toEqual(degrees);
  const weightBytes = 2 * (rootParameters + 2 * (replicaParameters + attentionMatrices / 2));
  const perLocalRequestToken = 2 * 2 * 2 * width * kvHeads / 2;
  expect(preview.allocations.map(row => [row.weightBytes, row.stateBytes])).toEqual(Array(4).fill([weightBytes, 2 * 3 * perLocalRequestToken]));
  expect(preview.communications).toHaveLength(2);

  const result = await analyzeScenario(reopened, preview.assets);
  if (result.status !== 'available') throw Error(JSON.stringify(result.diagnostics.slice(0, 5)));
  expect(validateResult(result.result)).toEqual([]);
  const steps = result.result.decode?.steps;
  expect(steps?.map(step => step.memory.map(device => count(device.categoryBreakdown.find(item => item.category === 'state')?.bytes))))
    .toEqual([Array(4).fill(2 * 3 * perLocalRequestToken), Array(4).fill(2 * 4 * perLocalRequestToken)]);
  const evaluation = steps?.[1]?.result.distributed?.layout.communications[0]?.evaluation;
  expect(evaluation?.source.placements.map(row => row.slices.find(slice => slice.axisId === 'b'))).toMatchObject([
    { start: 0, end: 2 }, { start: 0, end: 2 }, { start: 2, end: 4 }, { start: 2, end: 4 },
  ]);
  expect(evaluation?.definition.algorithm).toMatchObject({ startupRounds: 2, trafficFactor: 1 });
  expect(evaluation?.perDevice.map(device => count(device.sendBytes))).toEqual(Array(4).fill(2 * 2 * hidden));
  expect(count(evaluation?.cost.seconds)).toBeCloseTo(2e-6 + (2 * 2 * hidden) / 1e11, 12);
  expect(await estimateKvCapacity(reopened, preview.assets)).toMatchObject({ status: 'available', report: {
    requestPartitionedBytesPerToken: perLocalRequestToken, budget: { status: 'available' },
  } });

  const edited: Scenario = { ...reopened, workload: { kind: 'prefill', batchSize: 6, queryTokensPerRequest: 2, pastTokensPerRequest: 2 } };
  const changed = await resolveParallelPlan(edited, preview.assets);
  if (changed.status !== 'available') throw Error(JSON.stringify(changed.diagnostics.slice(0, 4)));
  const communication = changed.result.communications[0]!.evaluation;
  const metric = communication.cost.communications[0]!.sendBytesPerMember;
  expect(count(metric)).toBe(2 * 3 * 2 * hidden);
  const evidence = await replayCommunicationCostSource({ scenario: edited, assets: preview.assets, metric,
    inputHash: changed.result.inputHash, engineVersion: changed.result.engineVersion, proofVersion: 3,
    selector: { index: 0, scope: communication.cost.scope, field: 'sendBytesPerMember' },
  });
  expect(evidence.uniformMessages?.send.quantity.value).toBe(2 * 3 * 2 * hidden);
  expect(evidence.endpointLayouts?.source.partition).toMatchObject({ tensorAxisId: 'b' });

  const invalid = structuredClone(edited);
  const first = invalid.parallelPlan.communications[0]!;
  first.destination.distribution = { kind: 'replicated', groupId: first.groupId };
  expect(await resolveParallelPlan(invalid, preview.assets)).toMatchObject({ status: 'unavailable', diagnostics: [
    expect.objectContaining({ code: 'invalid_distribution', message: expect.stringContaining('同一请求切片') }),
  ] });
}, 90_000);

it('places three stages of the full decoder, counts tied weights at both ends and grows per-stage KV', async () => {
  const input = prepare({ kind: 'decode', batchSize: 2, queryTokensPerRequest: 1, contextTokensPerRequest: 2, steps: 2 }, layers, 3);
  const root = input.assets.find(asset => asset.definition.kind === 'model')!;
  const model = addQwenPipelinePreset(root), assets = input.assets.map(asset => asset === root ? model : asset);
  const scenario = { ...input.scenario, model: { ...input.scenario.model, revision: model.revision } };
  const degrees = { ...serialDegrees, pp: 3 }, presets = model.parallelPresets!;
  const [match] = matchingParallelPresets(degrees, presets, scenario);
  expect(match).toMatchObject({ slots: 3, preset: { presetId: 'pp-decoder' } });
  const network = { bytesPerSecond: 100e9, latencySeconds: 3e-6 };
  const attempt = await previewParallelPreset({ ...input, scenario, assets, presetId: match!.preset.presetId,
    network });
  if (attempt.status !== 'available') throw Error(attempt.message.slice(0, 5000));
  const { preview } = attempt, reopened = Scenario.parse(JSON.parse(JSON.stringify(preview.scenario)));
  expect(currentDegrees(reopened, presets)).toEqual(degrees);
  const layerBytes = 2 * (attentionMatrices + replicaParameters), tied = 2 * hidden * vocab, perLayerToken = 4 * width * kvHeads;
  const counts = [10, 9, 9];
  expect(preview.allocations.map(row => row.weightBytes)).toEqual([10 * layerBytes + tied, 9 * layerBytes, 9 * layerBytes + tied + 2 * hidden]);
  expect(preview.allocations.map(row => row.stateBytes)).toEqual(counts.map(count => count * 2 * 3 * perLayerToken));
  expect(preview.communications?.map(row => [row.operation, row.sourceDeviceId, row.destinationDeviceId])).toEqual([
    ['send_recv', 'gpu0', 'gpu1'], ['send_recv', 'gpu1', 'gpu2'],
  ]);
  const analyzed = await analyzeScenario(reopened, preview.assets);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 5)));
  expect(validateResult(analyzed.result)).toEqual([]);
  const steps = analyzed.result.decode?.steps;
  for (const [index, step] of steps!.entries()) {
    const layout = step.result.distributed!.layout;
    const sends = layout.communications.map(row => row.evaluation);
    expect(sends.map(row => count(row.cost.communications[0]?.groupSendBytes))).toEqual([4 * hidden, 4 * hidden]);
    expect(sends.map(row => count(row.cost.seconds))).toEqual(Array(2).fill(3e-6 + (4 * hidden) / 100e9));
    expect(step.memory.map(row => count(row.categoryBreakdown.find(item => item.category === 'state')?.bytes)))
      .toEqual(counts.map(count => count * 2 * (3 + index) * perLayerToken));
    const tiedAllocation = layout.storageAllocations.find(row => row.storageId === 'embedding')?.allocation;
    expect(tiedAllocation?.perDevice.map(row => row.deviceId)).toEqual(['gpu0', 'gpu2']);
    const oneRank = (id: string) => layout.localCosts.nodes.find(node => node.nodeId === id)?.placement;
    expect(oneRank('embedding')).toMatchObject({ kind: 'placed', perDevice: [{ deviceId: 'gpu0' }] });
    expect(oneRank('decoder[10]/qkv')).toMatchObject({ kind: 'placed', perDevice: [{ deviceId: 'gpu1' }] });
    expect(oneRank('lm-head')).toMatchObject({ kind: 'placed', perDevice: [{ deviceId: 'gpu2' }] });
  }
  expect(await estimateKvCapacity(reopened, preview.assets)).toMatchObject({ status: 'available', report: {
    averageBytesPerToken: layers * perLayerToken, budget: { status: 'available' },
  } });
  const shorter: Scenario = { ...scenario, bindings: [{ parameterKey: 'L', value: { kind: 'integer', value: 2 } }] };
  expect(await previewParallelPreset({ ...input, scenario: shorter, assets, presetId: 'pp-decoder', network }))
    .toMatchObject({ status: 'unavailable', message: expect.stringContaining('层链块数 2') });
}, 150_000);

it('runs independent request pipelines with paired stage transfers, local weights and growing KV', async () => {
  const input = prepare({ kind: 'decode', batchSize: 4, queryTokensPerRequest: 1, contextTokensPerRequest: 2, steps: 2 }, layers, 6);
  const root = input.assets.find(asset => asset.definition.kind === 'model')!;
  const legacy = addQwenPipelinePreset(root), model = addQwenPipelineRequestParallel(legacy);
  const assets = input.assets.map(asset => asset === root ? model : asset);
  const scenario = { ...input.scenario, model: { ...input.scenario.model, revision: model.revision } };
  const degrees = { ...serialDegrees, pp: 3, attentionDp: 2 }, presets = model.parallelPresets!;
  const [match] = matchingParallelPresets(degrees, presets, scenario);
  expect(match).toMatchObject({ slots: 6, requestDp: 2, preset: { presetId: 'pp-decoder' } });
  const network = { bytesPerSecond: 1e11, latencySeconds: 3e-6 };
  const request = { ...input, scenario, assets, presetId: 'pp-decoder', requestDp: 2, network };
  const attempt = await previewParallelPreset(request);
  if (attempt.status !== 'available') throw Error(attempt.message.slice(0, 6000));
  const { preview } = attempt, reopened = Scenario.parse(JSON.parse(JSON.stringify(preview.scenario)));
  expect(currentDegrees(reopened, presets)).toEqual(degrees);
  const layerBytes = 2 * (attentionMatrices + replicaParameters), tied = 2 * hidden * vocab;
  const perLayerToken = 4 * width * kvHeads, stageCounts = [10, 9, 9, 10, 9, 9], localBatch = 2;
  const weights = [10 * layerBytes + tied, 9 * layerBytes, 9 * layerBytes + tied + 2 * hidden];
  expect(preview.allocations.map(row => row.weightBytes)).toEqual([...weights, ...weights]);
  expect(preview.allocations.map(row => row.stateBytes)).toEqual(stageCounts.map(l => l * localBatch * 3 * perLayerToken));
  const peer = (sourceDeviceId: string, destinationDeviceId: string) => ({ sourceDeviceId, destinationDeviceId });
  expect(preview.communications?.map(row => row.peerPairs)).toEqual([
    [peer('gpu0', 'gpu1'), peer('gpu3', 'gpu4')], [peer('gpu1', 'gpu2'), peer('gpu4', 'gpu5')],
  ]);

  const analyzed = await analyzeScenario(reopened, preview.assets);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 8)));
  expect(validateResult(analyzed.result)).toEqual([]);
  const steps = analyzed.result.decode?.steps;
  for (const [index, step] of steps!.entries()) {
    expect(step.memory.map(row => count(row.categoryBreakdown.find(category => category.category === 'state')?.bytes)))
      .toEqual(stageCounts.map(l => l * localBatch * (3 + index) * perLayerToken));
    const layout = step.result.distributed!.layout;
    expect(layout.execution).toMatchObject({ status: 'available', result: { completeness: 'complete' } });
    const perMessage = 2 * localBatch * hidden;
    const localEmbedding = layout.localCosts.nodes.find(row => row.nodeId === 'embedding')?.placement;
    expect(localEmbedding).toMatchObject({ kind: 'placed', perDevice: [{ deviceId: 'gpu0' }, { deviceId: 'gpu3' }] });
    if (localEmbedding?.kind === 'placed') for (const { outcome } of localEmbedding.perDevice) {
      expect(outcome).toMatchObject({ status: 'available', cost: { logicalWriteBytes: { quantity: { value: perMessage } } } });
    }
    for (const { evaluation } of layout.communications) {
      for (const endpoint of [evaluation.source, evaluation.destination]) {
        expect(endpoint.placements.map(row => row.slices.find(slice => slice.axisId === 'b')))
          .toMatchObject([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
      }
      expect(evaluation.perDevice.map(row => [count(row.sendBytes), count(row.receiveBytes), count(row.algorithmTrafficBytes)]))
        .toEqual([[perMessage, 0, perMessage], [0, perMessage, 0], [perMessage, 0, perMessage], [0, perMessage, 0]]);
      expect(count(evaluation.cost.communications[0]?.groupSendBytes)).toBe(2 * perMessage);
      expect(count(evaluation.cost.seconds)).toBeCloseTo(network.latencySeconds + perMessage / network.bytesPerSecond, 12);
    }
  }
  const frame = steps![0]!, layout = frame.result.distributed!.layout;
  const evaluated = layout.communications[0]!.evaluation;
  const proof = await replayCommunicationCostSource({ scenario: frame.scenario, assets: preview.assets,
    metric: evaluated.cost.communications[0]!.groupSendBytes, inputHash: frame.result.inputHash, engineVersion: frame.result.engineVersion,
    ...(frame.result.stepContext ? { stepContext: frame.result.stepContext, decodeFrame: true } : {}), proofVersion: 4,
    selector: { index: 0, scope: evaluated.cost.scope, field: 'groupSendBytes' },
  });
  expect(proof.uniformMessages?.count).toBe(2);
  expect(proof.items.map(row => [row.deviceId, row.peerDeviceId])).toEqual([['gpu0', 'gpu1'], ['gpu1', 'gpu0'], ['gpu3', 'gpu4'], ['gpu4', 'gpu3']]);
  expect(proof.endpointLayouts?.devices.map(row => [row.deviceId, !!row.source, !!row.destination]))
    .toEqual([['gpu0', true, false], ['gpu1', false, true], ['gpu3', true, false], ['gpu4', false, true]]);
  expect(await estimateKvCapacity(reopened, preview.assets)).toMatchObject({ status: 'available', report: {
    averageBytesPerToken: layers * perLayerToken, budget: { status: 'available' },
  } });

  const crossed = structuredClone(reopened);
  crossed.parallelPlan.communications[0]!.peerPairs = [
    { sourceDeviceId: DeviceId.parse('gpu0'), destinationDeviceId: DeviceId.parse('gpu4') },
    { sourceDeviceId: DeviceId.parse('gpu3'), destinationDeviceId: DeviceId.parse('gpu1') },
  ];
  expect(await resolveParallelPlan({ ...crossed, workload: frame.scenario.workload }, preview.assets)).toMatchObject({
    status: 'unavailable', diagnostics: [expect.objectContaining({ code: 'invalid_distribution', message: expect.stringContaining('目标切片') })],
  });
  const old = { ...scenario, model: { ...scenario.model, revision: legacy.revision } };
  expect(await previewParallelPreset({ ...request, scenario: old, assets: [...assets, legacy] }))
    .toMatchObject({ status: 'unavailable', message: expect.stringContaining('未声明此布局可与请求 DP 组合') });
}, 150_000);

it('partitions Qwen attention inside each pipeline stage and keeps two request groups independent', async () => {
  const input = prepare({ kind: 'decode', batchSize: 4, queryTokensPerRequest: 1, contextTokensPerRequest: 2, steps: 2 }, layers, 8);
  const root = input.assets.find(asset => asset.definition.kind === 'model')!;
  const legacy = addQwenPipelineRequestParallel(addQwenPipelinePreset(root));
  const model = addQwenPipelineAttentionParallel(legacy, 'tp-attention-heads');
  const assets = input.assets.map(asset => asset === root ? model : asset);
  const scenario = { ...input.scenario, model: { ...input.scenario.model, revision: model.revision } };
  const degrees = { ...serialDegrees, pp: 2, attentionTp: 2, attentionDp: 2 };
  const presets = model.parallelPresets!;
  const [match] = matchingParallelPresets(degrees, presets, scenario);
  expect(match).toMatchObject({ slots: 8, requestDp: 2, pipelineTp: 2, preset: { presetId: 'pp-decoder' } });
  const network = { bytesPerSecond: 1e11, latencySeconds: 3e-6 };
  const pipelineTpNetwork = { bytesPerSecond: 4e11, latencySeconds: 1e-6 };
  const request = { ...input, scenario, assets, presetId: 'pp-decoder', requestDp: 2, pipelineTp: 2, network, pipelineTpNetwork };
  const attempt = await previewParallelPreset(request);
  if(attempt.status!=='available')throw Error(attempt.message.slice(0,7000));
  const { preview } = attempt, reopened = Scenario.parse(JSON.parse(JSON.stringify(preview.scenario)));
  expect(currentDegrees(reopened, presets)).toEqual(degrees);
  expect(preview.communicationCount).toBe(layers+1);
  const layerBytes = 2 * (attentionMatrices/2 + replicaParameters);
  const tied = 2 * hidden * vocab, stageWeight = 14*layerBytes+tied;
  expect(preview.allocations.map(row=>row.weightBytes)).toEqual([0,0,1,1,0,0,1,1].map(tail=>stageWeight+tail*2*hidden));
  const localBatch=2, kvPerRankAndToken=14*4*width*(kvHeads/2);
  expect(preview.allocations.map(row=>row.stateBytes)).toEqual(Array(8).fill(localBatch*3*kvPerRankAndToken));

  const result=await analyzeScenario(reopened,preview.assets);
  if(result.status!=='available'||!result.result.decode)throw Error(JSON.stringify(result).slice(0,7000));
  expect(validateResult(result.result)).toEqual([]);
  for(const [stepIndex,step] of result.result.decode.steps.entries()){
    const layout=step.result.distributed!.layout;
    expect(layout.execution).toMatchObject({status:'available',result:{completeness:'complete'}});
    expect(step.memory.map(row=>count(row.categoryBreakdown.find(category=>category.category==='state')?.bytes)))
      .toEqual(Array(8).fill(localBatch*(3+stepIndex)*kvPerRankAndToken));
    const stagePeers=[['gpu0','gpu2'],['gpu1','gpu3'],['gpu4','gpu6'],['gpu5','gpu7']];
    const stageSend=layout.communications.find(row=>row.evaluation.definition.operation==='send_recv')?.evaluation;
    const message=2*localBatch*hidden;
    expect(stageSend?.definition.peerPairs?.map(pair=>[pair.sourceDeviceId,pair.destinationDeviceId])).toEqual(stagePeers);
    expect(stageSend?.definition.timing).toMatchObject({kind:'bandwidth_latency',bytePerSecond:network.bytesPerSecond,latencySeconds:network.latencySeconds});
    expect(count(stageSend?.cost.communications[0]?.groupSendBytes)).toBe(stagePeers.length*message);
    expect(count(stageSend?.cost.seconds)).toBeCloseTo(network.latencySeconds+message/network.bytesPerSecond,12);
    const reductions=layout.communications.filter(row=>row.evaluation.definition.operation==='all_reduce');
    expect(reductions).toHaveLength(28);
    for(const [layer,{evaluation}] of reductions.entries()){
      expect(evaluation.cost.scope.deviceIds).toEqual(layer<14?['gpu0','gpu1','gpu4','gpu5']:['gpu2','gpu3','gpu6','gpu7']);
      expect(evaluation.source.placements.map(row=>row.slices.find(slice=>slice.axisId==='b')))
        .toMatchObject([{start:0,end:2},{start:0,end:2},{start:2,end:4},{start:2,end:4}]);
      expect(evaluation.perDevice.map(row=>count(row.sendBytes))).toEqual(Array(4).fill(message));
      expect(evaluation.definition.timing).toMatchObject({kind:'bandwidth_latency',bytePerSecond:pipelineTpNetwork.bytesPerSecond,latencySeconds:pipelineTpNetwork.latencySeconds});
      expect(count(evaluation.cost.seconds)).toBeCloseTo(2*pipelineTpNetwork.latencySeconds+message/pipelineTpNetwork.bytesPerSecond,12);
    }
    const oProj=layout.localCosts.nodes.find(row=>row.nodeId==='decoder[0]/o-proj')?.placement;
    if(oProj?.kind!=='placed')throw Error('Missing stage-local TP output cost');
    expect(oProj.perDevice.map(row=>row.outcome.status==='available'?count(row.outcome.cost.compute[0]?.usefulOperations):null))
      .toEqual(Array(4).fill(2*localBatch*queries*width*hidden/2));
  }
  expect(await estimateKvCapacity(reopened,preview.assets)).toMatchObject({status:'available',report:{
    averageBytesPerToken:layers*4*width*kvHeads,budget:{status:'available'},
  }});
  const quantized={...reopened,quantizationOverrides:[{
    selector:{kind:'subtree' as const,rootNodeId:NodeId.parse('$model')},
    state:{payloadBits:8,packingUnitElements:1,alignmentBytes:1,auxiliaries:[]},
  }]};
  expect(await estimateKvCapacity(quantized,preview.assets)).toMatchObject({status:'available',report:{
    averageBytesPerToken:layers*2*width*kvHeads,budget:{status:'available'},
    devices:Array(8).fill(expect.objectContaining({kvBytes:localBatch*4*kvPerRankAndToken/2})),
  }});
  const old={...scenario,model:{...scenario.model,revision:legacy.revision}};
  expect(await previewParallelPreset({...request,scenario:old,assets:[...assets,legacy]}))
    .toMatchObject({status:'unavailable',message:expect.stringContaining('未声明可用的阶段内 Attention TP')});
  expect(await previewParallelPreset({...request,pipelineTp:undefined}))
    .toMatchObject({status:'unavailable',message:expect.stringContaining('阶段内链路参数需要已声明的流水线阶段内布局')});
}, 160_000);
