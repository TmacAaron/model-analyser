import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AssetDocument, type MetricValue } from '@model-analyser/contracts';
import { analyzeScenario, estimateKvCapacity, previewParallelPreset } from '@model-analyser/core';
import { bindDegreePool, currentDegrees, matchingParallelPresets, serialDegrees } from '../apps/web/src/parallel-degrees.js';
import { makeDeepSeekFlashParallelAssets } from '../scripts/deepseek-v4-parallel.js';
import { makeDeepSeekFlashPublishedWeightPreset } from '../scripts/deepseek-flash-published-weights.js';
import { ref } from '../scripts/model-authoring.js';
import { makeModelProject } from '../scripts/model-project.js';

const network = { bytesPerSecond: 100e9, latencySeconds: 3e-6 };
const mi300x = AssetDocument.parse(JSON.parse(readFileSync('assets/builtin/hardware/builtin%3Ahardware%3Aamd-mi300x-192gb-r1.json', 'utf8')));
function amount(metric: MetricValue | undefined) {
  if (metric?.status !== 'available') throw Error('Expected an available metric ' + JSON.stringify(metric));
  return metric.quantity.value;
}
const releases = [
  { v41: false, hidden: 4096, rank: 1024, width: 2048, experts: 256, layers: 43, indexHeads: 64, indexLayers: 21,
    baselineWeight: 570_412_548_444, engramRows: [], kv: 2 * (43 * 128 * 512 + 21 * (512 + 128)), state: 12_206_080 },
  { v41: true, hidden: 5120, rank: 1280, width: 2304, experts: 384, layers: 40, indexHeads: 32, indexLayers: 8,
    baselineWeight: 1_307_953_639_888, engramRows: [384006168, 384016682], kv: 2 * (40 * 128 * 512 + (3 * 2 + 4) * (512 + 128)), state: 8_413_184 },
];

function setup(v41: boolean, batchSize = 1, revision: 3 | 4 = 3) {
  const hardware = mi300x, model = makeDeepSeekFlashParallelAssets(v41, revision);
  const project = makeModelProject([...model, hardware], { kind: 'prefill', batchSize, queryTokensPerRequest: 1,
    pastTokensPerRequest: 3 }, v41 ? 'DeepSeek V4.1 Flash' : 'DeepSeek V4 Flash');
  const scenario = project.scenarios[0]!;
  scenario.deviceTopology.devices = scenario.deviceTopology.devices.map(device => ({ ...device, hardware: ref(hardware) }));
  return { scenario, assets: project.assetSnapshots, presets: model[0]?.parallelPresets ?? [] };
}

it.each(releases)('accounts for V4.1=$v41 on one pool with Attention TP8 and expert EP4 × TP2', async spec => {
  const { scenario, assets, presets } = setup(spec.v41), degree = 8;
  const degrees = { ...serialDegrees, attentionTp: degree, moeEp: 4, moeTp: 2 };
  const [match] = matchingParallelPresets(degrees, presets, scenario);
  expect(match).toMatchObject({ preset: { presetId: 'tp-flash-attention-ep' }, slots: degree, expertMesh: { ep: 4, tp: 2 } });
  const attempted = await previewParallelPreset({ ...bindDegreePool(scenario, degree), assets, presetId: match!.preset.presetId,
    expertMesh: match!.expertMesh, network });
  if (attempted.status !== 'available') throw Error(attempted.message.slice(0, 5000));
  const { preview } = attempted;
  expect(currentDegrees(preview.scenario, presets)).toEqual(degrees);
  const { hidden: H, rank: QR, width: I, experts: E, layers, indexHeads: IH, indexLayers, engramRows } = spec;
  const attentionWeights = layers * (2 * (QR * 64 * 512 + 64 * 512 * 1024 + 8 * 1024 * H) + 4 * 64);
  const indexWeights = 2 * indexLayers * (QR * IH * 128 + H * IH);
  const expertWeights = layers * 3 * 2 * E * H * I;
  const tables = engramRows.reduce((sum, rows) => sum + rows * 264, 0);
  const localTables = engramRows.reduce((sum, rows) => sum + Math.ceil(rows / degree) * 264, 0);
  const sharded = attentionWeights + indexWeights + expertWeights;
  const localWeight = spec.baselineWeight - sharded - tables + sharded / degree + localTables;
  expect(preview.allocations.map(row => [row.weightBytes, row.stateBytes])).toEqual(Array(degree).fill([localWeight, spec.kv + spec.state]));
  expect(preview.communications).toHaveLength(2 * layers + indexLayers + engramRows.length);
  const before = (producer: string, consumer: string) => preview.communications?.filter(row =>
    row.placement?.afterNodeIds[0]?.endsWith('/' + producer) && row.placement?.beforeNodeIds[0]?.endsWith('/' + consumer)) ?? [];
  expect(before('route-combine', 'shared-add')).toHaveLength(layers);
  expect(before('route-combine', 'shared-add').every(row => row.payloadDtype.format === 'fp32')).toBe(true);
  expect(before('output-proj', 'attn-output-cast')).toHaveLength(layers);
  expect(before('index-reduce', 'index-topk')).toHaveLength(spec.v41 ? 3 : indexLayers);
  if (spec.v41) {
    expect(before('index-reduce', 'candidate-mask-apply')).toHaveLength(4);
    expect(before('index-reduce', 'candidate-block-scores')).toHaveLength(1);
    expect(before('engram-lookup', 'engram-project').map(row => row.payloadDtype.format)).toEqual(['bf16', 'bf16']);
  }

}, 120_000);

it('uses six valid expert slots, tracks empty ranks and reports the compressed KV budget', async () => {
  const { scenario, assets } = setup(false), degree = 8;
  scenario.bindings = [{ parameterKey: 'Periods', value: { kind: 'integer', value: 1 } }];
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, degree), assets, presetId: 'tp-flash-attention-ep', network });
  if (attempt.status !== 'available') throw Error(attempt.message.slice(0, 5000));
  const { preview } = attempt;
  const analyzed = await analyzeScenario(preview.scenario, preview.assets);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 5)));
  const report = analyzed.result, layout = report.distributed?.layout;
  expect(amount(report.total.seconds)).toBeGreaterThan(0);
  const block = 'window-hash[0]';
  const placement = layout?.localCosts.nodes.find(node => node.nodeId === block + '/routed-gate-proj')?.placement;
  if (placement?.kind !== 'placed') throw Error('Missing routed expert placement');
  const H = 4096, I = 2048, perRoute = 2 * H * I;
  expect(placement.perDevice.map(rank => rank.outcome.status === 'available' ? [
    amount(rank.outcome.cost.compute[0]?.usefulOperations), amount(rank.outcome.cost.compute[0]?.executedOperations), amount(rank.outcome.cost.logicalReadBytes),
  ] : null)).toEqual([...Array(6).fill([perRoute, perRoute, perRoute + 2 * H]), ...Array(2).fill([0, perRoute, 2 * H])]);
  const kvLayout = layout?.storageAllocations.find(row => row.storageId === block + '::window-cache')?.allocation;
  expect(kvLayout?.distribution.kind).toBe('replicated');
  const capacity = await estimateKvCapacity(preview.scenario, preview.assets);
  if (capacity.status !== 'available') throw Error(capacity.message);
  const kv = 2 * (5 * 128 * 512 + 2 * (512 + 128));
  const state = 8 * (2 * 8 * 2 * (512 + 128) + 128 * 512);
  expect(capacity.report).toMatchObject({ currentKvBytes: degree * kv, replicatedBytesPerToken: kv / 4,
    budget: { status: 'available' }, rowProfile: { includesIndexer: true, fixedWindows: [128] } });
  expect(capacity.report.devices.map(row => [row.kvBytes, row.otherStateBytes])).toEqual(Array(degree).fill([kv, state]));
}, 90_000);

it.each(releases)('accounts for the V4.1=$v41 published mixed weight formats on eight shared ranks', async spec => {
  const { scenario, assets } = setup(spec.v41, 1, 4), degree = 8;
  const preset = makeDeepSeekFlashPublishedWeightPreset(assets, spec.v41);
  if (preset.definition.kind !== 'quantization') throw Error('Missing Flash weight profile');
  scenario.quantizationOverrides = [{ ...preset.definition.quantization, preset: ref(preset) }];
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, degree), assets: [...assets, preset],
    presetId: 'tp-flash-attention-ep', expertMesh: { ep: 4, tp: 2 }, network });
  if (attempt.status !== 'available') throw Error(attempt.message);
  const { v41, hidden: H, rank: QR, width: I, experts: E, layers, indexLayers, indexHeads, engramRows } = spec;
  const tile = v41 ? 32 : 128;
  const fp8 = (rows: number, columns: number) => rows * columns + Math.ceil(rows / tile) * Math.ceil(columns / tile);
  const fp4 = (rows: number, columns: number) => rows * columns / 2 + rows * Math.ceil(columns / 32);
  const perLayer = fp8(QR, H) + fp8(4096, QR) + fp8(512, H) + fp8(1024, 4096) + fp8(H, 1024) +
    2 * fp8(I, H) + fp8(H, I) + E / 4 * (2 * fp4(I / 2, H) + fp4(H, I / 2)) +
    4 * (2 * (24 + 24 * 4 * H + 3)) + 4 * H + 2 * (QR + 512) + 4 * (64 / degree) + 2 * H * E;
  const denseTail = 4 * 129280 * H + 2 * H + (v41 ? 0 : 4 * (4 + 4 * 4 * H + 1));
  const routing = 40 * E * 4 + (v41 ? 0 : 3 * 129280 * 6 * 8);
  const index = indexLayers * (fp8(indexHeads / 8 * 128, QR) + 2 * H * indexHeads / 8);
  const compressor = (width: number, channels: number, ratio: number) => 4 * H * channels + 4 * ratio * channels + 2 * width;
  const compression = v41 ? 2 * H * 512 * 7 + 2 * 512 * 4 + 2 * 128 * 512 * 4 + 2 * 128 * 4 :
    21 * (compressor(512, 1024, 4) + compressor(128, 256, 4)) + 20 * compressor(512, 512, 128);
  const engram = engramRows.reduce((sum, rows) => sum + Math.ceil(rows / 8) * 264 + fp8(H * 5, 6144) + 4 * 4 * H, 0);
  const weight = denseTail + layers * perLayer + routing + index + compression + engram;
  expect(attempt.preview.allocations.map(row => [row.weightBytes, row.stateBytes]))
    .toEqual(Array(degree).fill([weight, spec.kv + spec.state]));
  expect(attempt.preview.communicationCount).toBe(2 * layers + indexLayers + engramRows.length);
}, 120_000);

it('reads FP4 weights and scales only for valid expert slots', async () => {
  const { scenario, assets } = setup(false, 1, 4);
  scenario.bindings = [{ parameterKey: 'Periods', value: { kind: 'integer', value: 1 } }];
  const preset = makeDeepSeekFlashPublishedWeightPreset(assets, false);
  if (preset.definition.kind !== 'quantization') throw Error('Missing Flash weight profile');
  scenario.quantizationOverrides = [{ ...preset.definition.quantization, preset: ref(preset) }];
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, 16), assets: [...assets, preset],
    presetId: 'ep-flash-routed', expertMesh: { ep: 8, tp: 2 }, network });
  if (attempt.status !== 'available') throw Error(attempt.message);
  const analyzed = await analyzeScenario(attempt.preview.scenario, attempt.preview.assets);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 5)));
  const layout = analyzed.result.distributed?.layout, block = 'window-hash[0]', H = 4096, width = 1024;
  const matrixBytes = width * (H / 2 + H / 32);
  const gate = layout?.localCosts.nodes.find(row => row.nodeId === block + '/routed-gate-proj')?.placement;
  if (gate?.kind !== 'placed') throw Error('Missing FP4 gate placement');
  expect(gate.perDevice.map(({ outcome }) => outcome.status === 'available' ? amount(outcome.cost.logicalReadBytes) : null))
    .toEqual([...Array(12).fill(2 * H + matrixBytes), ...Array(4).fill(2 * H)]);
  const weight = layout?.storageAllocations.find(row => row.storageId === block + '::routed-gate-weight')?.allocation;
  expect(weight?.perDevice.map(row => amount(row.totalBytes))).toEqual(Array(16).fill(32 * matrixBytes));
}, 90_000);

it('keeps the six global routes across eight owner groups and shards each expert across two feature ranks', async () => {
  const { scenario, assets, presets } = setup(false), degree = 16;
  scenario.bindings = [{ parameterKey: 'Periods', value: { kind: 'integer', value: 1 } }];
  expect(matchingParallelPresets({ ...serialDegrees, moeTp: 2 }, presets, scenario)).toMatchObject([
    { preset: { presetId: 'tp-flash-routed' }, slots: 2 },
  ]);
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, degree), assets, presetId: 'ep-flash-routed',
    expertMesh: { ep: 8, tp: 2 }, network });
  if (attempt.status !== 'available') throw Error(attempt.message.slice(0, 5000));
  const analyzed = await analyzeScenario(attempt.preview.scenario, attempt.preview.assets);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 5)));
  const layout = analyzed.result.distributed?.layout;
  const block = 'window-hash[0]', hidden = 4096, localWidth = 1024, localExperts = 32;
  for (const id of ['gate', 'up', 'down']) {
    const allocation = layout?.storageAllocations.find(row => row.storageId === `${block}::routed-${id}-weight`)?.allocation;
    expect(allocation?.distribution).toMatchObject({ kind: 'sharded', axes: [
      { tensorAxisId: 'w0', meshAxisId: 'expert' }, { tensorAxisId: 'w2', meshAxisId: 'feature' },
    ] });
    expect(allocation?.perDevice.map(row => amount(row.totalBytes))).toEqual(Array(degree).fill(2 * localExperts * hidden * localWidth));
  }
  for (const [id, work] of [['gate-proj', 2 * hidden * localWidth], ['up-proj', 2 * hidden * localWidth],
    ['swiglu', 8 * localWidth], ['down-proj', 2 * hidden * localWidth]] as const) {
    const placement = layout?.localCosts.nodes.find(node => node.nodeId === `${block}/routed-${id}`)?.placement;
    if (placement?.kind !== 'placed') throw Error('Missing ' + id + ' placement');
    expect(placement.perDevice.map(rank => rank.outcome.status === 'available' ? [
      amount(rank.outcome.cost.compute[0]?.usefulOperations), amount(rank.outcome.cost.compute[0]?.executedOperations),
    ] : null)).toEqual([...Array(12).fill([work, work]), ...Array(4).fill([0, work])]);
  }
  expect(layout?.storageAllocations.find(row => row.storageId === block + '::shared-gate-weight')?.allocation.distribution.kind)
    .toBe('replicated');
}, 90_000);

it.each(releases)('splits request lanes for V4.1=$v41 while preserving each request’s compressed cache', async spec => {
  const { scenario, assets, presets } = setup(spec.v41, 2);
  expect(matchingParallelPresets({ ...serialDegrees, attentionDp: 2 }, presets, scenario).map(row => row.preset.presetId)).toEqual(['dp-batch']);
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, 2), assets, presetId: 'dp-batch' });
  if (attempt.status !== 'available') throw Error(attempt.message.slice(0, 5000));
  expect(attempt.preview.communicationCount).toBe(0);
  expect(attempt.preview.allocations.map(row => [row.weightBytes, row.stateBytes]))
    .toEqual(Array(2).fill([spec.baselineWeight, spec.kv + spec.state]));
}, 90_000);
