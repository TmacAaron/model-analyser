import { expect, it } from 'vitest';
import { NodeId, Scenario, type MetricValue, type QuantizedStorageSpec } from '@model-analyser/contracts';
import { analyzeScenario, estimateKvCapacity, evaluateCommunication, instantiateModel, previewParallelPreset, requestReplicaMeshAxis } from '@model-analyser/core';
import { bindDegreePool, currentDegrees, matchingParallelPresets, serialDegrees } from '../apps/web/src/parallel-degrees.js';
import { validateResult } from '../packages/contracts/src/result-validation.js';
import { makeModelProject } from '../scripts/model-project.js';
import { addQwenContextPreset, addQwenPrefillRequestParallel } from '../scripts/qwen-context-parallel.js';
import { addQwenDecodeContextPreset, addQwenDecodeRequestParallel } from '../scripts/qwen-decode-context.js';
import { makeQwenParallelAssets } from '../scripts/qwen-parallel-assets.js';
import { addQwenPipelinePreset } from '../scripts/qwen-pipeline.js';

const network = { bytesPerSecond: 100e9, latencySeconds: 3e-6 };
const amount = (metric?: MetricValue) => {
  if (metric?.status !== 'available') throw Error('Expected an available cost');
  return metric.quantity.value;
};

function fixture(size: '0.6b' | '1.7b', workload: Scenario['workload'], withRequestGroups = false) {
  const base = makeQwenParallelAssets();
  const root = base.find(asset => asset.assetId === 'builtin:model:qwen3-' + size)!;
  const layer = base.find(asset => asset.definition.kind === 'module')!;
  const [legacy, ...assets] = addQwenContextPreset(layer, [addQwenPipelinePreset(root)]);
  let model = legacy!;
  if (withRequestGroups) {
    const [decode, decodeLayer, ...formulas] = addQwenDecodeContextPreset(assets[0]!, [model]);
    const [decodeRequest, requestLayer] = addQwenDecodeRequestParallel(decodeLayer!, [decode!]);
    model = addQwenPrefillRequestParallel([decodeRequest!])[0]!;
    assets.push(requestLayer!, ...formulas);
  }
  const project = makeModelProject([model, ...assets, ...base.filter(asset => asset.definition.kind === 'formula')], workload, 'Qwen PCP');
  return { scenario: project.scenarios[0]!, assets: project.assetSnapshots, presets: model.parallelPresets!, legacy: legacy! };
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

it('gathers current Qwen K/V only inside each PCP request group and preserves the batch slice', async () => {
  const { scenario, assets, presets, legacy } = fixture('0.6b',
    { kind: 'prefill', batchSize: 6, queryTokensPerRequest: 4, pastTokensPerRequest: 3 }, true);
  const degrees = { ...serialDegrees, pcp: 2, attentionDp: 3 };
  const [match] = matchingParallelPresets(degrees, presets, scenario);
  expect(match).toMatchObject({ slots: 6, requestDp: 3, preset: { presetId: 'pcp-queries' } });
  const request = { ...bindDegreePool(scenario, 6), assets, presetId: 'pcp-queries', requestDp: 3, network };
  const attempt = await previewParallelPreset(request);
  if (attempt.status !== 'available') throw Error(attempt.message.slice(0, 7000));
  const { preview } = attempt, reopened = Scenario.parse(JSON.parse(JSON.stringify(preview.scenario)));
  expect(currentDegrees(reopened, presets)).toEqual(degrees);
  const layers = 28, heads = 16, width = 128, kvHeads = 8, groupBatch = 2, localQuery = 2;
  const perToken = 4 * layers * width * kvHeads, tile = 2 * groupBatch * localQuery * width * kvHeads;
  expect(preview.allocations.map(row => row.stateBytes)).toEqual(Array(6).fill(groupBatch * 7 * perToken));
  expect(preview.communicationCount).toBe(layers * 2);

  const analyzed = await analyzeScenario(reopened, preview.assets);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics).slice(0, 7000));
  expect(validateResult(analyzed.result)).toEqual([]);
  const layout = analyzed.result.distributed!.layout;
  const costs = (id: string) => {
    const row = layout.localCosts.nodes.find(node => node.nodeId === 'decoder[0]/'+id)?.placement;
    if (row?.kind !== 'placed') throw Error('Missing PCP local costs '+id);
    return row.perDevice.map(device => {
      if (device.outcome.status !== 'available') throw Error('Missing '+device.deviceId+' costs');
      return device.outcome.cost;
    });
  };
  expect(costs('qk').map(row => amount(row.compute[0]?.usefulOperations))).toEqual([9, 13, 9, 13, 9, 13]
    .map(pairs => 2 * groupBatch * heads * width * pairs));
  expect(costs('qkv').map(row => amount(row.logicalWriteBytes))).toEqual(Array(6).fill(2 * groupBatch * localQuery * width * (heads+2*kvHeads)));
  expect(costs('cache-update').map(row => amount(row.logicalWriteBytes))).toEqual(Array(6).fill(4 * tile));
  expect(layout.tensorLayouts.find(row => row.nodeId === 'lm-head' && row.tensorId === 'logits')?.partition.distribution)
    .toMatchObject({ kind: 'sharded', axes: [
      { tensorAxisId: 'b', meshAxisId: requestReplicaMeshAxis }, { tensorAxisId: 'q', meshAxisId: request.meshAxisId },
    ] });

  for (const { evaluation } of layout.communications) {
    const slice = (placement: typeof evaluation.source.placements[number], axisId: string) => {
      const row = placement.slices.find(axis => axis.axisId === axisId);
      return [row?.start, row?.end];
    };
    expect(evaluation.definition.operation).toBe('all_gather');
    expect(evaluation.definition.algorithm.startupRounds).toBe(1);
    expect(evaluation.source.placements.map(row => slice(row, 'b'))).toEqual([[0, 2], [0, 2], [2, 4], [2, 4], [4, 6], [4, 6]]);
    expect(evaluation.destination.placements.map(row => slice(row, 'b'))).toEqual(evaluation.source.placements.map(row => slice(row, 'b')));
    expect(evaluation.source.placements.map(row => slice(row, 'q'))).toEqual([[0, 2], [2, 4], [0, 2], [2, 4], [0, 2], [2, 4]]);
    expect(evaluation.destination.placements.map(row => slice(row, 'q'))).toEqual(Array(6).fill([0, 4]));
    expect(evaluation.perDevice.map(row => [amount(row.sendBytes), amount(row.receiveBytes), amount(row.algorithmTrafficBytes)]))
      .toEqual(Array(6).fill([tile, 2 * tile, tile]));
    expect(amount(evaluation.cost.seconds)).toBeCloseTo(network.latencySeconds + tile / network.bytesPerSecond, 12);
  }
  expect(await estimateKvCapacity(reopened, preview.assets)).toMatchObject({ status: 'available', report: {
    averageBytesPerToken: 2 * perToken, requestPartitionedBytesPerToken: perToken, budget: { status: 'available' },
  } });
  const int8 = { ...reopened, quantizationOverrides: [{
    selector: { kind: 'subtree' as const, rootNodeId: NodeId.parse('$model') },
    state: { payloadBits: 8, packingUnitElements: 1, alignmentBytes: 1, auxiliaries: [] },
  }] };
  expect(await estimateKvCapacity(int8, preview.assets)).toMatchObject({ status: 'available', report: {
    averageBytesPerToken: perToken, requestPartitionedBytesPerToken: perToken / 2, budget: { status: 'available' },
    devices: Array(6).fill(expect.objectContaining({ kvBytes: groupBatch * 7 * perToken / 2 })),
  } });
  const structure = instantiateModel(reopened, preview.assets);
  if (structure.status !== 'available') throw Error('Missing PCP communication operands');
  const evaluation = layout.communications[0]!.evaluation;
  // Keep a valid tensor division while moving batch ownership to the gathered mesh axis.
  const changed = { ...evaluation.definition, destination: { ...evaluation.definition.destination, distribution: {
    kind: 'sharded' as const, groupId: request.groupId, policy: { kind: 'even' as const },
    axes: [{ tensorAxisId: 'b', meshAxisId: 'rank' }],
  } } };
  expect(evaluateCommunication(changed, evaluation.cost.scope, structure.resolved.graph.tensors, reopened.deviceTopology,
    { assets: preview.assets, symbols: {} })).toMatchObject({ status: 'unavailable', diagnostics: [{ code: 'invalid_distribution' }] });

  const old = { ...request.scenario, model: { ...request.scenario.model, revision: legacy.revision } };
  expect(await previewParallelPreset({ ...request, scenario: old, assets: [...assets, legacy] }))
    .toMatchObject({ status: 'unavailable', message: expect.stringContaining('未声明此布局可与请求 DP 组合') });
  const uneven = { ...request.scenario, workload: { ...request.scenario.workload, batchSize: 5 } };
  expect(await previewParallelPreset({ ...request, scenario: uneven }))
    .toMatchObject({ status: 'unavailable', message: expect.stringContaining('Batch 必须能被请求 DP 3 整除') });
}, 130_000);
