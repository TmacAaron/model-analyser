import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AssetDocument, type MetricValue } from '@model-analyser/contracts';
import { analyzeScenario, estimateKvCapacity, instantiateModel, previewParallelPreset } from '@model-analyser/core';
import { bindDegreePool, matchingParallelPresets, serialDegrees } from '../apps/web/src/parallel-degrees.js';
import { makeGlm52Assets } from '../scripts/glm52-model.js';
import { makeGlm52ParallelAssets } from '../scripts/glm52-parallel.js';
import { literal, ref } from '../scripts/model-authoring.js';
import { makeModelProject } from '../scripts/model-project.js';

const layers = 78, owners = 21, H = 6144, V = 154880, N = 64, QR = 2048, R = 512;
const DN = 192, DR = 64, DV = 256, I = 12288, J = 2048, E = 256, IH = 32, ID = 128;
const perLayerAttention = 2 * (H * QR + QR + QR * N * (DN + DR) + H * (R + DR) + R
  + N * R * (DN + DV) + N * DV * H + 2 * H);
const indexWeights = 2 * (QR * IH * ID + H * ID + H * IH + 2 * ID);
const routedAndShared = 6 * H * J * (E + 1) + 2 * H * E + 4 * E;
const totalWeights = layers * perLayerAttention + owners * indexWeights + 3 * 6 * H * I + 75 * routedAndShared + 4 * H * V + 2 * H;
const perToken = 2 * (layers * (R + DR) + owners * ID);
const project = () => makeModelProject(makeGlm52Assets(), {
  kind: 'prefill', batchSize: 1, queryTokensPerRequest: 4, pastTokensPerRequest: 0,
}, 'GLM-5.2 text');

function known(value?: MetricValue) {
  if (value?.status !== 'available') throw Error('Expected available metric');
  return value.quantity.value;
}

it('uses the released 78-layer schedule and reuses row IDs without sharing the main KV caches', () => {
  const p = project();
  const result = instantiateModel(p.scenarios[0]!, p.assetSnapshots);
  if (result.status !== 'available') throw Error(JSON.stringify(result.diagnostics));
  const { nodes, edges, states } = result.resolved.graph;
  expect(states.filter(state => state.stateKind === 'latent')).toHaveLength(layers);
  expect(states.filter(state => state.stateKind === 'indexer')).toHaveLength(owners);
  expect(nodes.filter(node => node.nodeId.endsWith('/route-topk'))).toHaveLength(75);
  expect(nodes.filter(node => node.nodeId.endsWith('/ffn-silu'))).toHaveLength(3);
  const hasEdge = (from: string, to: string, port: string) => edges.some(edge => edge.from.kind === 'node' &&
    edge.from.nodeId === from && edge.to.kind === 'node' && edge.to.nodeId === to && edge.to.portId === port);
  expect(hasEdge('dense[2]/index-topk', 'shared-prefix[2]/qk', 'selected-rows')).toBe(true);
  expect(hasEdge('decoder[17]/source/index-topk', 'decoder[17]/reuse[2]/qk', 'selected-rows')).toBe(true);
  expect(hasEdge('decoder[17]/reuse[2]/cache-write', 'decoder[17]/reuse[2]/qk', 'latent-cache')).toBe(true);
  expect(hasEdge('decoder[17]/reuse[2]/shared-down', 'decoder[17]/reuse[2]/shared-add', 'shared-output')).toBe(true);
  expect(hasEdge('decoder[17]/reuse[2]/combine', 'decoder[17]/reuse[2]/shared-add', 'routed-output')).toBe(true);
});

it('charges the parameter ledger, exact causal pair work, and 95,232 bytes per KV token', async () => {
  const p = project(), scenario = p.scenarios[0]!;
  const attempt = await analyzeScenario(scenario, p.assetSnapshots);
  if (attempt.status !== 'available') throw Error(JSON.stringify(attempt.diagnostics.slice(0, 8)));
  const { memory, nodes, total } = attempt.result;
  expect(known(memory[0]?.categoryBreakdown.find(row => row.category === 'weight')?.bytes)).toBe(totalWeights);
  expect(known(memory[0]?.categoryBreakdown.find(row => row.category === 'state')?.bytes)).toBe(4 * perToken);
  expect(known(total.seconds)).toBeGreaterThan(0);
  for (const [nodeId, width] of [['dense[0]/qk', N * (R + DR)], ['dense[0]/index-score', IH * ID]] as const) {
    const compute = nodes.find(node => node.nodeId === nodeId)?.cost.compute[0];
    expect(known(compute?.usefulOperations)).toBe(2 * width * 10);
    expect(known(compute?.executedOperations)).toBe(2 * width * 16);
  }
  const estimate = await estimateKvCapacity(scenario, p.assetSnapshots);
  expect(estimate).toMatchObject({ status: 'available', report: {
    averageBytesPerToken: perToken, currentKvBytes: 4 * perToken, stateCount: 99, storageCount: 177,
    budget: { status: 'no_room', reason: 'non_kv' }, rowProfile: { includesIndexer: true },
  } });
}, 150_000);

const attentionWeightShards = 2 * N * (QR * (DN + DR) + R * (DN + DV) + DV * H);
const expertWeightShards = 6 * E * H * J;
const network = { bytesPerSecond: 100e9, latencySeconds: 3e-6 };

function parallelProject(batchSize: number, periods?: number) {
  const assets = makeGlm52ParallelAssets();
  const root = assets[0];
  if (root?.definition.kind !== 'model') throw Error('Missing the GLM model');
  if (periods !== undefined) {
    const repeat = root.definition.graph.nodes.find(node => node.nodeId === 'decoder')?.repeat;
    if (!repeat) throw Error('Missing index period');
    repeat.count = literal(periods);
  }
  const mi300x = AssetDocument.parse(JSON.parse(readFileSync('assets/builtin/hardware/builtin%3Ahardware%3Aamd-mi300x-192gb-r1.json', 'utf8')));
  const p = makeModelProject([...assets, mi300x], { kind: 'prefill', batchSize, queryTokensPerRequest: 1, pastTokensPerRequest: 3 }, 'GLM-5.2');
  const scenario = p.scenarios[0]!;
  scenario.deviceTopology.devices = scenario.deviceTopology.devices.map(device => ({ ...device, hardware: ref(mi300x) }));
  return { scenario, assets: p.assetSnapshots, presets: root.parallelPresets ?? [] };
}

it('accounts for all GLM layers on one eight-card Attention TP and MoE EP pool', async () => {
  const { scenario, assets, presets } = parallelProject(1);
  const degree = 8;
  expect(matchingParallelPresets({ ...serialDegrees, attentionTp: degree, moeEp: degree }, presets, scenario).map(match => match.slots)).toEqual([degree]);
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, degree), assets, presetId: 'tp-glm-attention-ep', network });
  if (attempt.status !== 'available') throw Error(attempt.message.slice(0, 4000));
  const { preview } = attempt;
  const sharded = layers * attentionWeightShards + 75 * expertWeightShards;
  expect(preview.allocations.map(row => [row.weightBytes, row.stateBytes])).toEqual(Array(degree).fill([totalWeights - sharded + sharded / degree, 4 * perToken]));
  expect(preview.communications?.filter(row => row.placement?.beforeNodeIds[0]?.endsWith('/attention-residual'))).toHaveLength(78);
  expect(preview.communications?.filter(row => row.placement?.beforeNodeIds[0]?.endsWith('/shared-add'))).toHaveLength(75);
  expect(preview.communicationCount).toBe(153);
}, 150_000);

it.each([['ep-glm-routed', 16], ['tp-glm-attention-moe', 2]] as const)('uses declared routed work under %s', async (presetId, degree) => {
  const { scenario, assets } = parallelProject(1, 1);
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, degree), assets, presetId, network });
  if (attempt.status !== 'available') throw Error(attempt.message.slice(0, 4000));
  const { preview } = attempt;
  const analyzed = await analyzeScenario(preview.scenario, preview.assets);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 5)));
  const layout = analyzed.result.distributed?.layout;
  const local = layout?.localCosts.nodes.find(node => node.nodeId === 'decoder[0]/source/expert-gate-up')?.placement;
  if (local?.kind !== 'placed') throw Error('Expected local expert work');
  const perRoute = 4 * H * J;
  const ranks = local.perDevice.map(row => {
    if (row.outcome.status !== 'available') throw Error('Expected rank cost');
    const { cost } = row.outcome;
    return [known(cost.compute[0]?.usefulOperations), known(cost.compute[0]?.executedOperations), known(cost.logicalReadBytes)];
  });
  if (presetId === 'ep-glm-routed') {
    expect(ranks).toEqual([...Array(8).fill([perRoute, perRoute, perRoute + 2 * H + 4]), ...Array(8).fill([0, perRoute, 2 * H + 4])]);
    expect(preview.communicationCount).toBe(7);
  } else {
    expect(ranks).toEqual(Array(2).fill([8 * perRoute / 2, 8 * perRoute / 2, 8 * (perRoute / 2 + 2 * H + 4)]));
    expect(preview.communicationCount).toBe(17);
  }
}, 140_000);

it('partitions independent requests and their cache by batch', async () => {
  const { scenario, assets, presets } = parallelProject(2, 1);
  expect(matchingParallelPresets({ ...serialDegrees, attentionDp: 2 }, presets, scenario).map(match => match.preset.presetId)).toEqual(['dp-batch']);
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, 2), assets, presetId: 'dp-batch' });
  if (attempt.status !== 'available') throw Error(attempt.message.slice(0, 4000));
  const weight = totalWeights - 68 * perLayerAttention - 17 * indexWeights - 68 * routedAndShared;
  const state = 4 * 2 * (10 * (R + DR) + 4 * ID);
  expect(attempt.preview.allocations.map(row => [row.weightBytes, row.stateBytes])).toEqual(Array(2).fill([weight, state]));
  expect(attempt.preview.communicationCount).toBe(0);
}, 90_000);

it('reuses all four GLM Attention TP ranks for a two by two expert mesh', async () => {
  const { scenario, assets, presets } = parallelProject(1, 1);
  const [match] = matchingParallelPresets({ ...serialDegrees, attentionTp: 4, moeEp: 2, moeTp: 2 }, presets, scenario);
  expect(match).toMatchObject({ preset: { presetId: 'tp-glm-attention-ep' }, slots: 4, expertMesh: { ep: 2, tp: 2 } });
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, 4), assets, presetId: match!.preset.presetId,
    expertMesh: match!.expertMesh, network });
  if (attempt.status !== 'available') throw Error(attempt.message.slice(0, 4000));
  expect(attempt.preview.scenario.deviceTopology.groups.map(group => group.members)).toEqual(Array(2).fill(attempt.preview.deviceIds));
  expect(attempt.preview.communications?.filter(row => row.placement?.beforeNodeIds[0]?.endsWith('/shared-add'))).toHaveLength(7);
  expect(attempt.preview.communications?.filter(row => row.placement?.beforeNodeIds[0]?.endsWith('/attention-residual'))).toHaveLength(10);
}, 90_000);
