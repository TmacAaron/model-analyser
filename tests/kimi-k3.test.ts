import { expect, it } from 'vitest';
import type { MetricValue } from '@model-analyser/contracts';
import { analyzeScenario, estimateKvCapacity, instantiateModel } from '@model-analyser/core';
import { makeKimiK3Assets } from '../scripts/kimi-k3-model.js';
import { makeModelProject } from '../scripts/model-project.js';

const H = 7168, V = 163840, N = 96, D = 128, W = 4, QR = 1536, R = 512, DN = 128, DX = 64, DV = 128;
const E = 896, K = 16, M = 3584, J = 3072, S = 2, I = 33792, linearLayers = 69, fullLayers = 24;
const kdaWeights = 2 * (5 * H * N * D + 3 * N * D * W + H * D + N * D * D + H * N + D) + 4 * N * (D + 1);
const mlaWeights = 2 * (H * QR + QR + QR * N * (DN + DX) + H * (R + DX) + R + N * R * (DN + DV) + 2 * H * N * DV);
const moeWeights = 2 * (H * E + 2 * H * M + M + 3 * E * M * J + 3 * H * S * J) + 4 * E;
const allWeights = linearLayers * kdaWeights + fullLayers * mlaWeights + 93 * 12 * H + 92 * moeWeights + 6 * H * I + 4 * H * V + 6 * H;
const fixedState = linearLayers * (4 * N * D * D + 3 * 2 * N * D * W);
const kvPerToken = fullLayers * (R + DX) * 2;
const project = () => makeModelProject(makeKimiK3Assets(), {
  kind: 'prefill', batchSize: 1, queryTokensPerRequest: 4, pastTokensPerRequest: 0,
}, 'Kimi-K3 text');

function known(value?: MetricValue) {
  if (value?.status !== 'available') throw Error('Expected available metric');
  return value.quantity.value;
}

it('matches the released schedule and carries the depth archive through every block', () => {
  const p = project(), attempt = instantiateModel(p.scenarios[0]!, p.assetSnapshots);
  if (attempt.status !== 'available') throw Error(JSON.stringify(attempt.diagnostics));
  const { graph } = attempt.resolved;
  const count = (id: string) => graph.nodes.filter(node => node.nodeId.endsWith('/' + id)).length;
  expect(count('recurrent')).toBe(69);
  expect(count('qk')).toBe(24);
  expect(count('archive-residual')).toBe(8);
  expect(count('route-topk')).toBe(92);
  expect(count('dense-situ')).toBe(1);
  expect(graph.states.filter(state => state.stateKind === 'recurrent')).toHaveLength(69 * 4);
  expect(graph.states.filter(state => state.stateKind === 'latent')).toHaveLength(24);
  const wire = (from: string, to: string, port: string) => expect(graph.edges.some(edge => edge.from.kind === 'node' &&
    edge.from.nodeId === from && edge.to.kind === 'node' && edge.to.nodeId === to && edge.to.portId === port), from + ' → ' + to).toBe(true);
  wire('start/boundary/archive-residual', 'blocks[0]/boundary/attn-depth-score', 'archive');
  wire('blocks[4]/boundary/archive-residual', 'blocks[5]/boundary/archive-residual', 'archive');
  wire('blocks[5]/boundary/archive-residual', 'tail/boundary/attn-depth-mix', 'archive');
  wire('tail/boundary/archive-residual', 'final-depth-score', 'decoder-archive');
  wire('tail/final-full/ffn-residual', 'final-depth-score', 'decoder-output');
  wire('tail/final-full/latent-up', 'tail/final-full/expert-merge', 'routed-output');
  wire('tail/final-full/shared-down', 'tail/final-full/expert-merge', 'shared-output');
  const archive = graph.tensors.find(tensor => tensor.tensorId === 'decoder-archive')?.shape.find(axis => axis.axisId === 'depth');
  expect(archive?.size).toMatchObject({ kind: 'literal', quantity: { value: 8 } });
});

it('reconciles the full text ledger and separates KDA state from growing MLA slots', async () => {
  const p = project(), scenario = p.scenarios[0]!, attempt = await analyzeScenario(scenario, p.assetSnapshots);
  if (attempt.status !== 'available') throw Error(JSON.stringify(attempt.diagnostics.slice(0, 8)));
  const { memory, total, nodes } = attempt.result;
  expect(known(memory[0]?.categoryBreakdown.find(row => row.category === 'weight')?.bytes)).toBe(allWeights);
  expect(known(memory[0]?.categoryBreakdown.find(row => row.category === 'state')?.bytes)).toBe(fixedState + 4 * kvPerToken);
  expect(known(total.seconds)).toBeGreaterThan(0);
  const leaf = (id: string) => nodes.find(node => node.nodeId === id)?.cost.compute[0];
  expect(known(leaf('start/boundary/recurrent')?.usefulOperations)).toBe(7 * 4 * N * D * D);
  expect(known(leaf('start/full/qk')?.usefulOperations)).toBe(2 * N * (R + DX) * 10);
  expect(known(leaf('tail/final-full/expert-down')?.usefulOperations)).toBe(2 * 4 * K * M * J);
  const estimate = await estimateKvCapacity(scenario, p.assetSnapshots);
  expect(estimate).toMatchObject({ status: 'available', report: {
    averageBytesPerToken: kvPerToken, currentKvBytes: 4 * kvPerToken, stateCount: 24, storageCount: 48,
    devices: [{ otherStateBytes: fixedState }], budget: { status: 'no_room', reason: 'non_kv' },
  } });
}, 150_000);
