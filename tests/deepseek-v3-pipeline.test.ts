import { expect, it } from 'vitest';
import { AssetDocument, ProjectDocument } from '@model-analyser/contracts';
import { estimateKvCapacity, previewParallelPreset } from '@model-analyser/core';
import { bindDegreePool, currentDegrees, matchingParallelPresets, serialDegrees } from '../apps/web/src/parallel-degrees.js';
import { makeDeepSeekV3FP8WeightPreset } from '../scripts/deepseek-v3-fp8-weights.js';
import { makeDeepSeekV3ParallelAssets } from '../scripts/deepseek-v3-parallel.js';
import { ref } from '../scripts/model-authoring.js';
import { makeModelProject, referenceHardware } from '../scripts/model-project.js';

const stageLink = { bytesPerSecond: 25e9, latencySeconds: 6e-6 };
const innerLink = { bytesPerSecond: 100e9, latencySeconds: 3e-6 };
const fp8 = (rows: number, cols: number) => rows * cols + 4 * Math.ceil(rows / 128) * Math.ceil(cols / 128);
const hidden = 7168, kvPerLayer = 1152, vocab = 129280;

it('balances all V3 layers over two stages with FP8, Attention TP4 and MoE EP2 × TP2', async () => {
  const model = makeDeepSeekV3ParallelAssets('v3');
  const preset = makeDeepSeekV3FP8WeightPreset(model, 'v3');
  const reference = referenceHardware();
  if (reference.definition.kind !== 'hardware' || preset.definition.kind !== 'quantization') throw Error('Missing device or FP8 format');
  const device = AssetDocument.parse({ ...reference, assetId: 'example:hardware:v3-pp-fp8',
    definition: { ...reference.definition, hardware: { ...reference.definition.hardware, capacityBytes: 128_000_000_000 } } });
  const project = makeModelProject([...model, preset, device], {
    kind: 'decode', batchSize: 1, queryTokensPerRequest: 1, contextTokensPerRequest: 2, steps: 1,
  }, 'DeepSeek-V3 pipeline');
  const scenario = project.scenarios[0]!, presets = model[0]!.parallelPresets!;
  scenario.deviceTopology.devices[0]!.hardware = ref(device);
  scenario.quantizationOverrides = [{ ...preset.definition.quantization, preset: ref(preset) }];
  const degrees = { ...serialDegrees, pp: 2, attentionTp: 4, moeEp: 2, moeTp: 2 };
  const [match] = matchingParallelPresets(degrees, presets, scenario);
  expect(match).toMatchObject({ slots: 8, expertMesh: { ep: 2, tp: 2 }, pipelineStage: { presetId: 'tp-mla-ep-routed', degree: 4 } });
  if (!match) throw Error('Missing eight-card match');
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, match.slots), assets: project.assetSnapshots,
    presetId: match.preset.presetId, pipelineStage: match.pipelineStage, expertMesh: match.expertMesh,
    network: stageLink, pipelineTpNetwork: innerLink });
  if (attempt.status !== 'available') throw Error(attempt.message);
  const { preview } = attempt;
  expect(preview.communicationCount).toBe(61 + 58 + 1);
  const [transfer] = preview.communications?.filter(row => row.operation === 'send_recv') ?? [];
  expect(transfer).toMatchObject({
    timing: { bytePerSecond: stageLink.bytesPerSecond, latencySeconds: stageLink.latencySeconds },
    peerPairs: Array.from({ length: 4 }, (_, lane) => ({
      sourceDeviceId: preview.deviceIds[lane], destinationDeviceId: preview.deviceIds[4 + lane],
    })),
    placement: { afterNodeIds: ['moe[27]/mlp-residual'] },
  });
  expect(preview.communications?.filter(row => row.operation === 'all_reduce').every(row =>
    row.algorithm.startupRounds === 6 && row.timing.kind === 'bandwidth_latency' && row.timing.bytePerSecond === innerLink.bytesPerSecond)).toBe(true);

  const attention = fp8(1536, hidden) + fp8(32 * 192, 1536) + fp8(576, hidden) +
    2 * fp8(32 * 128, 512) + fp8(hidden, 32 * 128) + 2 * (2 * hidden + 1536 + 512);
  const ffn = (width: number) => 2 * fp8(width, hidden) + fp8(hidden, width);
  const moe = 128 * ffn(1024) + ffn(2048) + 256 * (2 * hidden + 4);
  const weights = [2 * hidden * vocab + 31 * attention + 3 * ffn(18432) + 28 * moe,
    2 * hidden * vocab + 2 * hidden + 30 * (attention + moe)];
  const states = [31, 30].map(layers => 3 * layers * kvPerLayer);
  for (const [rank, row] of preview.allocations.entries()) {
    const stage = rank < 4 ? 0 : 1;
    expect([row.weightBytes, row.stateBytes]).toEqual([weights[stage], states[stage]]);
  }
  const saved = ProjectDocument.parse(JSON.parse(JSON.stringify({ ...project, assetSnapshots: preview.assets, scenarios: [preview.scenario] })));
  expect(currentDegrees(saved.scenarios[0]!, presets)).toEqual(degrees);
  expect(await estimateKvCapacity(saved.scenarios[0]!, saved.assetSnapshots)).toMatchObject({ status: 'available', report: {
    averageBytesPerToken: 4 * 61 * kvPerLayer, devices: [31, 30].flatMap(layers => Array(4).fill(expect.objectContaining({ kvBytes: 3 * layers * kvPerLayer }))),
    budget: { status: 'available' },
  } });
}, 160_000);

it('places the Dense-to-MoE boundary on paired request groups and rejects reversed layer chains', async () => {
  const assets = makeDeepSeekV3ParallelAssets('r1');
  const project = makeModelProject(assets, { kind: 'prefill', batchSize: 4, queryTokensPerRequest: 1, pastTokensPerRequest: 2 }, 'DeepSeek-R1 pipeline');
  const scenario = project.scenarios[0]!;
  scenario.bindings = ['Ldense', 'Lmoe'].map(parameterKey => ({ parameterKey, value: { kind: 'integer', value: 1 } }));
  const pool = bindDegreePool(scenario, 4);
  const request = { ...pool, assets: project.assetSnapshots, presetId: 'pp-decoder', requestDp: 2, network: stageLink };
  const normal = await previewParallelPreset(request);
  if (normal.status !== 'available') throw Error(normal.message);
  expect(normal.preview.allocations.map(row => row.stateBytes)).toEqual(Array(4).fill(2 * 3 * kvPerLayer));
  expect(normal.preview.communications).toMatchObject([{
    operation: 'send_recv', peerPairs: [0, 2].map(i => ({
      sourceDeviceId: normal.preview.deviceIds[i], destinationDeviceId: normal.preview.deviceIds[i + 1],
    })),
    placement: { beforeNodeIds: expect.arrayContaining(['moe[0]/input-norm']) },
  }]);
  const model = project.assetSnapshots.find(asset => asset.assetId === scenario.model.assetId)!;
  const declaration = model.parallelPresets?.find(preset => preset.presetId === request.presetId)?.pipeline;
  if (!declaration || !('chainNodeIds' in declaration)) throw Error('Expected ordered DeepSeek layer chains');
  declaration.chainNodeIds.reverse();
  expect(await previewParallelPreset(request)).toMatchObject({ status: 'unavailable', message: expect.stringContaining('缺少顺序数据流') });
});
