import { expect, it } from 'vitest';
import { NodeId, StorageId, type MetricValue, type Scenario } from '@model-analyser/contracts';
import { analyzeScenario, estimateKvCapacity, instantiateModel, previewParallelPreset, replayLocalCostSource } from '@model-analyser/core';
import { bindDegreePool, matchingParallelPresets, serialDegrees } from '../apps/web/src/parallel-degrees.js';
import { validateProject } from '../packages/contracts/src/validation.js';
import { validateResult } from '../packages/contracts/src/result-validation.js';
import { makeH100FP8HardwareAsset, makeHardwareAssets } from '../scripts/hardware-assets.js';
import { ref } from '../scripts/model-authoring.js';
import { makeModelProject } from '../scripts/model-project.js';
import { makeQwen35FP8ExecutionAssets } from '../scripts/qwen35-fp8-execution.js';
import { makeQwen35FP8WeightPreset } from '../scripts/qwen35-fp8-weights.js';
import { makeQwenHybridParallelAssets } from '../scripts/qwen-hybrid-parallel.js';
import { addQwenPipelinePreset } from '../scripts/qwen-pipeline.js';

function amount(metric: MetricValue | undefined) {
  if (metric?.status !== 'available') throw Error('Expected a known metric ' + JSON.stringify(metric));
  return metric.quantity.value;
}

function fixture(modelRevision: 4 | 5 = 4) {
  const [model, ...dependencies] = makeQwenHybridParallelAssets('qwen35', 4);
  const decoder = [modelRevision === 5 ? addQwenPipelinePreset(model!, { requestBatchSharding: true, attentionPresetId: 'tp-hybrid-attention' }) : model!,
    ...dependencies];
  const weight = makeQwen35FP8WeightPreset(decoder, modelRevision);
  const [native, ...formulas] = makeQwen35FP8ExecutionAssets(decoder, weight);
  const h100 = makeH100FP8HardwareAsset(), a100 = makeHardwareAssets().find(asset => asset.assetId.includes('a100-sxm'));
  if (native?.definition.kind !== 'quantization' || weight.definition.kind !== 'quantization' || !a100) throw Error('Incomplete FP8 fixture');
  const project = makeModelProject([...decoder, weight, native, ...formulas, h100, a100], {
    kind: 'prefill', batchSize: 1, queryTokensPerRequest: 1, pastTokensPerRequest: 2,
  }, native.name);
  const h100Device = { ...project.scenarios[0]!.deviceTopology.devices[0]!, hardware: ref(h100) };
  const baseline: Scenario = { ...project.scenarios[0]!, bindings: [{ parameterKey: 'Periods', value: { kind: 'integer', value: 1 } }],
    deviceTopology: { devices: [h100Device], groups: [] } };
  const quantizationOverrides = [{ ...native.definition.quantization, preset: ref(native) }];
  const execution = { ...baseline, quantizationOverrides };
  const weightOnly = { ...baseline, quantizationOverrides: [{ ...weight.definition.quantization, preset: ref(weight) }] };
  return { project, execution, weightOnly, a100 };
}

it('adds FP8 matrix and scaling work on local tiles without changing the checkpoint or KV budget', async () => {
  const { project, execution, weightOnly } = fixture(), assets = project.assetSnapshots;
  expect(validateProject({ ...project, scenarios: [execution] })).toEqual([]);
  const preview = async (scenario: Scenario) => {
    const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, 8), assets, presetId: 'ep-routed',
      network: { bytesPerSecond: 100e9, latencySeconds: 3e-6 } });
    if (attempt.status !== 'available') throw Error(attempt.message);
    return attempt.preview;
  };
  const native = await preview(execution), storage = await preview(weightOnly);
  expect(native.allocations).toEqual(storage.allocations);
  expect(native.communications).toEqual(storage.communications);
  const [analyzed, reference] = await Promise.all([analyzeScenario(native.scenario, native.assets), analyzeScenario(storage.scenario, storage.assets)]);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 5)));
  if (reference.status !== 'available') throw Error(JSON.stringify(reference.diagnostics.slice(0, 5)));
  const { result } = analyzed;
  expect(validateResult(result)).toEqual([]);
  expect(amount(result.total.seconds)).toBeGreaterThan(0);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'quantization_execution_applied' }));
  const local = (report: typeof result, nodeId: string, rank = 0) => {
    const placement = report.distributed?.layout.localCosts.nodes.find(row => row.nodeId === nodeId)?.placement;
    const row = placement?.kind === 'placed' && placement.perDevice[rank];
    if (!row || row.outcome.status !== 'available') throw Error('Missing local cost ' + nodeId);
    return { cost: row.outcome.cost, deviceId: row.deviceId };
  };
  const id = NodeId.parse('decoder[0]/full/expert-gate-up');
  const { cost, deviceId } = local(result, id), prior = local(reference.result, id).cost;
  const work = (value: typeof cost) => value.compute.map(segment => [segment.computeClass.multiplyDtype.format,
    amount(segment.usefulOperations), amount(segment.executedOperations)]);
  const slots = 2, width = 4096, intermediate = 1024, features = slots * width;
  const matmul = 4 * slots * width * intermediate, scale = 3 * (2 * slots * intermediate) * (width / 128);
  expect(work(cost)).toEqual([['fp32', 0, 6 * features + features / 128], ['fp8_e4m3fn', matmul, matmul], ['fp32', 0, scale]]);
  expect(work(prior)).toEqual([['bf16', matmul, matmul]]);
  expect(work(local(result, id, 7).cost)).toEqual([['fp32', 0, 6 * features + features / 128], ['fp8_e4m3fn', matmul / 2, matmul], ['fp32', 0, scale]]);
  expect(amount(cost.logicalReadBytes)).toBe(amount(prior.logicalReadBytes));
  expect(amount(cost.logicalWriteBytes)).toBe(amount(prior.logicalWriteBytes));
  expect(amount(cost.hbmBytes)).toBe(amount(prior.hbmBytes));
  expect(work(local(result, 'decoder[0]/full/qk').cost)).toEqual(work(local(reference.result, 'decoder[0]/full/qk').cost));
  const projection = local(result, 'decoder[0]/full/o-proj').cost;
  expect(amount(projection.compute[0]?.executedOperations)).toBe(6 * (32 * 256) + (32 * 256) / 128);
  expect(amount(projection.compute[2]?.executedOperations)).toBe(3 * 4096 * (32 * 256 / 128));
  const conversion = cost.compute[0]!;
  const proof = await replayLocalCostSource({ scenario: native.scenario, assets: native.assets, inputHash: result.inputHash,
    engineVersion: result.engineVersion, metric: conversion.executedOperations, proofVersion: 3,
    selector: { nodeId: id, deviceId, scope: cost.scope, field: 'executedOperations', computeIndex: 0, computeClass: conversion.computeClass },
  });
  expect(proof.items).toContainEqual(expect.objectContaining({ kind: 'compute', segmentId: 'dynamic-fp8-activation' }));
  const [nativeBudget, storageBudget] = await Promise.all([native, storage].map(item => estimateKvCapacity(item.scenario, item.assets)));
  expect(nativeBudget).toMatchObject({ status: 'available', report: { replicatedBytesPerToken: 2048, budget: { status: 'available' } } });
  if (nativeBudget?.status !== 'available' || storageBudget?.status !== 'available') throw Error('Expected two KV budgets');
  expect(nativeBudget.report.budget).toEqual(storageBudget.report.budget);
}, 120_000);

it('keeps memory and work available on hardware without an FP8 compute rate', async () => {
  const { project, execution, a100 } = fixture();
  const scenario = { ...execution, deviceTopology: { ...execution.deviceTopology,
    devices: execution.deviceTopology.devices.map(device => ({ ...device, hardware: ref(a100) })) } };
  const analyzed = await analyzeScenario(scenario, project.assetSnapshots);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 5)));
  const { result } = analyzed;
  expect(result.total.seconds.status).toBe('unavailable');
  expect(result.memory[0]?.peakBytes.status).toBe('available');
  expect(amount(result.total.compute.find(row => row.computeClass.multiplyDtype.format === 'fp8_e4m3fn')?.executedOperations)).toBeGreaterThan(0);
});

it('keeps FP8 work and cache in the owning stage with DP × PP × Attention TP', async () => {
  const { project, execution } = fixture(5);
  const scenario: Scenario = { ...execution, workload: { ...execution.workload, batchSize: 4 },
    bindings: [{ parameterKey: 'Periods', value: { kind: 'integer', value: 3 } }] };
  const assets = project.assetSnapshots;
  const dimensions = { ...serialDegrees, attentionDp: 2, pp: 2, attentionTp: 2 };
  expect(matchingParallelPresets(dimensions, assets[0]!.parallelPresets!, scenario)).toMatchObject([{ slots: 8, requestDp: 2, pipelineTp: 2 }]);
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, 8), assets, presetId: 'pp-decoder', requestDp: 2, pipelineTp: 2,
    network: { bytesPerSecond: 20e9, latencySeconds: 5e-6 }, pipelineTpNetwork: { bytesPerSecond: 100e9, latencySeconds: 2e-6 } });
  if (attempt.status !== 'available') throw Error(attempt.message);
  const { preview } = attempt;
  const periods = [2, 2, 1, 1, 2, 2, 1, 1];
  const kvBytesPerPeriod = 2 * 3 * 2 * 256 * 2;
  const recurrentBytesPerPeriod = 2 * 3 * (2 * 4 * 6144 + 4 * 32 * 128 ** 2);
  expect(preview.allocations.map(row => row.stateBytes)).toEqual(periods.map(count => count * (kvBytesPerPeriod + recurrentBytesPerPeriod)));
  const weights = preview.allocations.map(row => row.weightBytes);
  expect(weights).toEqual([weights[0], weights[0], weights[2], weights[2], weights[0], weights[0], weights[2], weights[2]]);
  expect(weights[0]!).toBeGreaterThan(weights[2]!);
  expect(preview.communications?.filter(row => row.operation === 'all_reduce')).toHaveLength(12);
  expect(preview.communications?.find(row => row.operation === 'send_recv')?.peerPairs).toHaveLength(4);
  const analyzed = await analyzeScenario(preview.scenario, preview.assets);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 5)));
  expect(amount(analyzed.result.total.seconds)).toBeGreaterThan(0);
  expect(validateResult(analyzed.result)).toEqual([]);
  const placements = analyzed.result.distributed?.layout.localCosts.nodes;
  const output = placements?.find(row => row.nodeId === 'decoder[2]/full/o-proj')?.placement;
  if (output?.kind !== 'placed') throw Error('Missing last-stage output projection');
  expect(output.perDevice.map(row => row.deviceId)).toEqual(preview.allocations.filter((_, index) => periods[index] === 1).map(row => row.deviceId));
  expect(output.perDevice.map(rank => rank.outcome.status === 'available' ? rank.outcome.cost.compute[1]?.computeClass.multiplyDtype.format : null))
    .toEqual(Array(4).fill('fp8_e4m3fn'));
  expect(await estimateKvCapacity(preview.scenario, preview.assets)).toMatchObject({ status: 'available', report: {
    averageBytesPerToken: 6144, budget: { status: 'available' },
    devices: periods.map(count => ({ kvBytes: count * kvBytesPerPeriod, otherStateBytes: count * recurrentBytesPerPeriod })),
  } });
}, 120_000);

it('uses the local contraction width when Attention TP and MoE EP share a pool', async () => {
  const { project, execution } = fixture();
  const attempt = await previewParallelPreset({ ...bindDegreePool(execution, 2), assets: project.assetSnapshots,
    presetId: 'tp-hybrid-attention-ep-routed', network: { bytesPerSecond: 100e9, latencySeconds: 3e-6 } });
  if (attempt.status !== 'available') throw Error(attempt.message);
  expect(attempt.preview.communicationCount).toBe(8);
  const result = await analyzeScenario(attempt.preview.scenario, attempt.preview.assets);
  if (result.status !== 'available') throw Error(JSON.stringify(result.diagnostics.slice(0, 5)));
  const output = result.result.distributed?.layout.localCosts.nodes.find(row => row.nodeId === 'decoder[0]/full/o-proj')?.placement;
  if (output?.kind !== 'placed') throw Error('Missing sharded output projection');
  const localWidth = 16 * 256, outputSize = 4096;
  expect(output.perDevice.map(rank => rank.outcome.status === 'available' ? rank.outcome.cost.compute.map(stage => amount(stage.executedOperations)) : null))
    .toEqual(Array(2).fill([6 * localWidth + localWidth / 128, 2 * localWidth * outputSize, 3 * outputSize * localWidth / 128]));
}, 90_000);

it('rejects native execution when an explicit override changes a required weight format', () => {
  const { project, execution } = fixture();
  const override: Scenario['quantizationOverrides'][number] = { selector: { kind: 'subtree', rootNodeId: NodeId.parse('$model') },
    storageIds: [StorageId.parse('decoder[0]/full::expert-down-weight')],
    weight: { payloadBits: 4, packingUnitElements: 2, alignmentBytes: 1, auxiliaries: [] } };
  const attempted = instantiateModel({ ...execution, quantizationOverrides: [...execution.quantizationOverrides, override] }, project.assetSnapshots);
  expect(attempted).toMatchObject({ status: 'unavailable', diagnostics: expect.arrayContaining([
    expect.objectContaining({ code: 'incompatible_quantized_execution' }),
  ]) });
});
