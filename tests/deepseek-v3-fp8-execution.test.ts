import { expect, it } from 'vitest';
import { NodeId, type MetricValue, type Scenario } from '@model-analyser/contracts';
import { analyzeScenario, estimateKvCapacity, instantiateModel, previewParallelPreset, replayLocalCostSource } from '@model-analyser/core';
import { bindDegreePool } from '../apps/web/src/parallel-degrees.js';
import { makeDeepSeekV3ParallelAssets } from '../scripts/deepseek-v3-parallel.js';
import { makeDeepSeekV3FP8WeightPreset } from '../scripts/deepseek-v3-fp8-weights.js';
import { makeDeepSeekV3FP8ExecutionAssets } from '../scripts/deepseek-v3-fp8-execution.js';
import { makeH100FP8HardwareAsset } from '../scripts/hardware-assets.js';
import { literal, ref } from '../scripts/model-authoring.js';
import { makeModelProject } from '../scripts/model-project.js';

const network = { bytesPerSecond: 100e9, latencySeconds: 3e-6 };
const amount = (metric?: MetricValue) => {
  if (metric?.status !== 'available') throw Error('Expected an available FP8 metric');
  return metric.quantity.value;
};

function projectFor(release: 'v3' | 'r1', workload: Scenario['workload']) {
  const assets = makeDeepSeekV3ParallelAssets(release), storage = makeDeepSeekV3FP8WeightPreset(assets, release);
  const [native, ...formulas] = makeDeepSeekV3FP8ExecutionAssets(assets, storage, release);
  if (storage.definition.kind !== 'quantization' || native?.definition.kind !== 'quantization') throw Error('Missing published FP8 formats');
  const hardware = makeH100FP8HardwareAsset();
  const project = makeModelProject([...assets, storage, native, ...formulas, hardware], workload, native.name);
  const scenario = project.scenarios[0]!;
  scenario.bindings = ['Ldense', 'Lmoe'].map(parameterKey => ({ parameterKey, value: { kind: 'integer', value: 1 } }));
  scenario.deviceTopology.devices[0]!.hardware = ref(hardware);
  return { assets: project.assetSnapshots, scenario,
    storageOnly: [{ ...storage.definition.quantization, preset: ref(storage) }],
    execution: [{ ...native.definition.quantization, preset: ref(native) }] };
}

it('uses two activation quantizations for the routed gate and up while preserving MLA contractions', async () => {
  const { assets, scenario, execution, storageOnly } = projectFor('v3', {
    kind: 'prefill', batchSize: 1, pastTokensPerRequest: 2, queryTokensPerRequest: 1,
  });
  const preview = async (quantizationOverrides: Scenario['quantizationOverrides']) => {
    const result = await previewParallelPreset({ ...bindDegreePool({ ...scenario, quantizationOverrides }, 8), assets,
      presetId: 'tp-mla-ep-routed', expertMesh: { ep: 4, tp: 2 }, network });
    if (result.status !== 'available') throw Error(result.message);
    return result.preview;
  };
  const native = await preview(execution), baseline = await preview(storageOnly);
  expect(native.allocations).toEqual(baseline.allocations);
  expect(native.communications).toEqual(baseline.communications);
  const analyzed = await analyzeScenario(native.scenario, native.assets);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 6)));
  const result = analyzed.result;
  expect(amount(result.total.seconds)).toBeGreaterThan(0);
  const rank = (nodeId: string) => {
    const node = result.distributed?.layout.localCosts.nodes.find(row => row.nodeId === nodeId)?.placement;
    const rank = node?.kind === 'placed' && node.perDevice[0];
    if (!rank || rank.outcome.status !== 'available') throw Error('Missing FP8 placement ' + nodeId);
    return { cost: rank.outcome.cost, deviceId: rank.deviceId };
  };
  const work = (nodeId: string) => rank(nodeId).cost.compute.map(row =>
    [row.computeClass.multiplyDtype.format, amount(row.usefulOperations), amount(row.executedOperations)]);
  const hidden = 7168, routes = 2, width = 1024, groups = hidden / 128;
  const gateWork = 4 * routes * hidden * width;
  const gate = NodeId.parse('moe[0]/expert-gate-up');
  expect(work(gate)).toEqual([
    ['fp32', 0, 2 * routes * (5 * hidden + groups)],
    ['fp8_e4m3fn', gateWork, gateWork],
    ['fp32', 0, 2 * routes * width * (3 * groups + 1)],
  ]);
  expect(work('dense[0]/o-proj')).toEqual([
    ['fp32', 0, 5 * 2048 + 16],
    ['fp8_e4m3fn', 2 * hidden * 2048, 2 * hidden * 2048],
    ['fp32', 0, hidden * (3 * 16 + 1)],
  ]);
  for (const name of ['q-absorb', 'qk', 'av', 'v-up']) {
    expect(work('dense[0]/' + name).map(([format]) => format)).toEqual(['bf16']);
  }
  const { cost, deviceId } = rank(gate);
  const conversion = cost.compute[0]!;
  const proof = await replayLocalCostSource({ scenario: native.scenario, assets: native.assets, inputHash: result.inputHash,
    engineVersion: result.engineVersion, proofVersion: 3, metric: conversion.executedOperations,
    selector: { nodeId: gate, deviceId, scope: cost.scope, field: 'executedOperations', computeIndex: 0, computeClass: conversion.computeClass } });
  expect(proof.items).toContainEqual(expect.objectContaining({ kind: 'compute', segmentId: 'dynamic-fp8-activation' }));
  const nativeCapacity = await estimateKvCapacity(native.scenario, native.assets);
  const baselineCapacity = await estimateKvCapacity(baseline.scenario, baseline.assets);
  if (nativeCapacity.status !== 'available' || baselineCapacity.status !== 'available') throw Error('Missing KV budgets');
  expect(nativeCapacity.report.replicatedBytesPerToken).toBe(2304);
  expect(nativeCapacity.report.budget).toEqual(baselineCapacity.report.budget);
}, 120_000);

it('keeps the same FP8 linear operators inside R1 DCP and rejects a changed substitute', async () => {
  const { assets, scenario, execution } = projectFor('r1', {
    kind: 'decode', batchSize: 1, contextTokensPerRequest: 3, queryTokensPerRequest: 1, steps: 1,
  });
  scenario.bindings.push({ parameterKey: 'M', value: { kind: 'integer', value: 8 } });
  scenario.quantizationOverrides = execution;
  const preview = await previewParallelPreset({ ...bindDegreePool(scenario, 2), assets, presetId: 'dcp-kv', network });
  if (preview.status !== 'available') throw Error(preview.message);
  const configuration = preview.preview.scenario, snapshot = preview.preview.assets;
  const resolved = instantiateModel(configuration, snapshot);
  if (resolved.status !== 'available') throw Error(JSON.stringify(resolved.diagnostics.slice(0, 6)));
  const nodes = resolved.resolved.graph.nodes;
  const matrix = (id: string) => {
    const body = nodes.find(row => row.nodeId === id)?.body;
    return body?.kind === 'opaque' ? body.cost.compute.map(row => row.computeClass.multiplyDtype.format) : [];
  };
  expect(matrix('dense[0]/q-proj')).toEqual(['fp32', 'fp8_e4m3fn', 'fp32']);
  expect(matrix('moe[0]/expert-down')).toEqual(['fp32', 'fp8_e4m3fn', 'fp32']);
  expect(matrix('moe[0]/weighted-values')).toEqual(['bf16']);
  expect(preview.preview.communicationCount).toBe(6);
  const changed = structuredClone(snapshot);
  const replacement = changed.find(asset => asset.assetId === 'builtin:module:deepseek-v3-dcp-moe');
  if (replacement?.definition.kind !== 'module') throw Error('Missing DCP module');
  const body = replacement.definition.graph.nodes.find(node => node.nodeId === 'expert-down')?.body;
  if (body?.kind !== 'opaque' || !body.cost.compute[0]) throw Error('Missing DCP expert matrix');
  body.cost.compute[0].executedOperations = literal(0, 'operation');
  expect(instantiateModel(configuration, changed)).toMatchObject({ status: 'unavailable', diagnostics: [
    expect.objectContaining({ code: 'incompatible_model_weight_profile', message: expect.stringContaining('expert-down') }),
  ] });
}, 120_000);
