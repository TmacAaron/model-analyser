import { expect, it } from 'vitest';
import type { MetricValue } from '@model-analyser/contracts';
import { analyzeScenario, estimateKvCapacity, instantiateModel } from '@model-analyser/core';
import { makeGlm52Assets } from '../scripts/glm52-model.js';
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
