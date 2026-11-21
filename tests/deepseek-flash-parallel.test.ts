import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AssetDocument, type MetricValue } from '@model-analyser/contracts';
import { analyzeScenario, estimateKvCapacity, previewParallelPreset } from '@model-analyser/core';
import { bindDegreePool, matchingParallelPresets, serialDegrees } from '../apps/web/src/parallel-degrees.js';
import { makeDeepSeekFlashParallelAssets } from '../scripts/deepseek-v4-parallel.js';
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

function setup(v41: boolean, batchSize = 1) {
  const hardware = mi300x, model = makeDeepSeekFlashParallelAssets(v41);
  const project = makeModelProject([...model, hardware], { kind: 'prefill', batchSize, queryTokensPerRequest: 1,
    pastTokensPerRequest: 3 }, v41 ? 'DeepSeek V4.1 Flash' : 'DeepSeek V4 Flash');
  const scenario = project.scenarios[0]!;
  scenario.deviceTopology.devices = scenario.deviceTopology.devices.map(device => ({ ...device, hardware: ref(hardware) }));
  return { scenario, assets: project.assetSnapshots, presets: model[0]?.parallelPresets ?? [] };
}

it.each(releases)('accounts for V4.1=$v41 on one TP8/EP8 pool and preserves cache ownership', async spec => {
  const { scenario, assets, presets } = setup(spec.v41), degree = 8;
  expect(matchingParallelPresets({ ...serialDegrees, attentionTp: degree, moeEp: degree }, presets, scenario).map(row => row.slots)).toEqual([degree]);
  const attempted = await previewParallelPreset({ ...bindDegreePool(scenario, degree), assets, presetId: 'tp-flash-attention-ep', network });
  if (attempted.status !== 'available') throw Error(attempted.message.slice(0, 5000));
  const { preview } = attempted;
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

it.each(releases)('splits request lanes for V4.1=$v41 while preserving each request’s compressed cache', async spec => {
  const { scenario, assets, presets } = setup(spec.v41, 2);
  expect(matchingParallelPresets({ ...serialDegrees, attentionDp: 2 }, presets, scenario).map(row => row.preset.presetId)).toEqual(['dp-batch']);
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, 2), assets, presetId: 'dp-batch' });
  if (attempt.status !== 'available') throw Error(attempt.message.slice(0, 5000));
  expect(attempt.preview.communicationCount).toBe(0);
  expect(attempt.preview.allocations.map(row => [row.weightBytes, row.stateBytes]))
    .toEqual(Array(2).fill([spec.baselineWeight, spec.kv + spec.state]));
}, 90_000);
