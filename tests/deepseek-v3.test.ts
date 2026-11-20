import { expect, it } from 'vitest';
import { analyzeScenario, estimateKvCapacity } from '@model-analyser/core';
import type { MetricValue } from '@model-analyser/contracts';
import { validateResult } from '../packages/contracts/src/result-validation.js';
import { validateProject } from '../packages/contracts/src/validation.js';
import { makeDeepSeekAssets } from '../scripts/deepseek-model.js';
import { loadDeepSeekV3Profile } from '../scripts/deepseek-v3-profile.js';
import { makeModelProject } from '../scripts/model-project.js';

function amount(value: MetricValue | undefined) {
  if (value?.status !== 'available') throw Error('Expected a known metric, got ' + JSON.stringify(value));
  return value.quantity.value;
}

// Independent ledger from the pinned release dimensions.
const hidden = 7168, vocab = 129280, heads = 128, experts = 256;
const denseLayers = 3, moeLayers = 58, layers = denseLayers + moeLayers;
const attentionMatrices = hidden * 1536 + 1536 * heads * (128 + 64) + hidden * (512 + 64) +
  heads * 512 * (128 + 128) + hidden * heads * 128;
const denseMatrices = 3 * hidden * 18432;
const oneExpert = 3 * hidden * 2048;
const parameters = 2 * hidden * vocab + hidden + layers * (attentionMatrices + 1536 + 512 + 2 * hidden) +
  denseLayers * denseMatrices + moeLayers * ((experts + 1) * oneExpert + experts * hidden + experts);
const weights = 2 * parameters + 2 * experts * moeLayers;
const kvBytesPerToken = 2 * (512 + 64) * layers;

it.each(['v3', 'r1'] as const)('reproduces %s main-model weights and latent cache from the publisher config', async release => {
  const profile = loadDeepSeekV3Profile(release);
  const assets = makeDeepSeekAssets('absorbed', profile);
  const batchSize = 2, queries = 3, past = 1;
  const project = makeModelProject(assets, { kind: 'prefill', batchSize, queryTokensPerRequest: queries, pastTokensPerRequest: past }, profile.name);
  expect(validateProject(project)).toEqual([]);
  const scenario = project.scenarios[0]!;
  expect(scenario.model.assetId).toBe('builtin:model:deepseek-' + release);
  const attempt = await analyzeScenario(scenario, project.assetSnapshots);
  if (attempt.status !== 'available') throw Error(JSON.stringify(attempt.diagnostics));
  const { result } = attempt;
  expect(validateResult(result)).toEqual([]);
  expect(amount(result.memory[0]?.categoryBreakdown.find(item => item.category === 'weight')?.bytes)).toBe(weights);
  expect(amount(result.memory[0]?.categoryBreakdown.find(item => item.category === 'state')?.bytes))
    .toBe(batchSize * (queries + past) * kvBytesPerToken);
  const denseWork = 2 * batchSize * queries * (layers * attentionMatrices + denseLayers * denseMatrices +
    moeLayers * 9 * oneExpert + hidden * vocab);
  const pairWidth = 512 + 64 + 512;
  const matrix = result.total.compute.find(item => item.computeClass.resource === 'matrix');
  expect(amount(matrix?.usefulOperations)).toBe(denseWork + 2 * batchSize * heads * layers * (past * queries + 6) * pairWidth);
  expect(amount(matrix?.executedOperations)).toBe(denseWork + 2 * batchSize * heads * layers * queries * (past + queries) * pairWidth);
  const route = result.total.compute.find(item => item.computeClass.resource === 'custom');
  expect(amount(route?.usefulOperations)).toBe(batchSize * queries * moeLayers * (2 * experts + 8 * 4 + 8 * experts));
}, 60_000);

it('uses the final Decode allocation for KV bytes per token and detects the single-card capacity limit', async () => {
  const assets = makeDeepSeekAssets('absorbed', loadDeepSeekV3Profile('v3'));
  const project = makeModelProject(assets, {
    kind: 'decode', batchSize: 1, contextTokensPerRequest: 2, queryTokensPerRequest: 1, steps: 2,
  }, 'DeepSeek-V3 Decode');
  const attempt = await estimateKvCapacity(project.scenarios[0]!, project.assetSnapshots);
  if (attempt.status !== 'available') throw Error(attempt.message);
  expect(attempt.report).toMatchObject({
    stateCount: layers, referenceTokensPerRequest: 4, decodeStep: 1,
    currentKvBytes: 4 * kvBytesPerToken, averageBytesPerToken: kvBytesPerToken,
    budget: { status: 'no_room', limitingDeviceIds: ['gpu0'] },
  });
}, 90_000);
