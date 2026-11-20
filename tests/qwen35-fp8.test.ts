import { expect, it } from 'vitest';
import { NodeId, StorageId, type MetricValue, type Scenario } from '@model-analyser/contracts';
import { analyzeScenario, estimateKvCapacity, previewParallelPreset, replayLocalCostSource } from '@model-analyser/core';
import { bindDegreePool } from '../apps/web/src/parallel-degrees.js';
import { validateProject } from '../packages/contracts/src/validation.js';
import { validateResult } from '../packages/contracts/src/result-validation.js';
import { validateScenario } from '../packages/contracts/src/scenario-validation.js';
import { ref } from '../scripts/model-authoring.js';
import { makeModelProject } from '../scripts/model-project.js';
import { makeQwen35FP8WeightPreset } from '../scripts/qwen35-fp8-weights.js';
import { makeQwenHybridParallelAssets } from '../scripts/qwen-hybrid-parallel.js';

function amount(metric: MetricValue | undefined) {
  if (metric?.status !== 'available') throw Error('Expected a known metric');
  return metric.quantity.value;
}

function fixture() {
  const assets = makeQwenHybridParallelAssets('qwen35', 4), preset = makeQwen35FP8WeightPreset(assets);
  if (preset.definition.kind !== 'quantization') throw Error('Expected published weight preset');
  const project = makeModelProject([...assets, preset], { kind: 'prefill', batchSize: 2, queryTokensPerRequest: 1, pastTokensPerRequest: 2 }, preset.name);
  const baseline = project.scenarios[0]!;
  baseline.bindings = [{ parameterKey: 'Periods', value: { kind: 'integer', value: 1 } }];
  const scenario = { ...baseline, quantizationOverrides: [{ ...preset.definition.quantization, preset: ref(preset) }] };
  return { project, scenario, baseline };
}

it('accounts for the released formats and scale blocks in the actual EP8 allocation and sparse HBM read', async () => {
  const { project, scenario, baseline } = fixture(), assets = project.assetSnapshots;
  expect(validateProject({ ...project, scenarios: [scenario] })).toEqual([]);
  const preview = async (selected: Scenario) => {
    const attempt = await previewParallelPreset({ ...bindDegreePool(selected, 8), assets, presetId: 'ep-routed',
      network: { bytesPerSecond: 100e9, latencySeconds: 3e-6 } });
    if (attempt.status !== 'available') throw Error(attempt.message);
    return attempt.preview;
  };
  const { scenario: applied, assets: snapshot, allocations } = await preview(scenario);
  const raw = await preview(baseline);
  const expertFeatures = 1024, hidden = 4096;
  // Three DeltaNet layers, one GQA layer, and four MoE layers, including one shared expert each.
  const convertedElements = 3 * hidden * (12_288 + 2 * 8192) + hidden * 256 * (3 * 32 + 2 * 2) +
    4 * 3 * hidden * expertFeatures * (1 + 512 / 8);
  const addedFp32 = 3 * 2 * (64 + 128);
  const savedBytes = convertedElements - (convertedElements / 128 ** 2) * 2 - addedFp32;
  expect(allocations.map((row, index) => raw.allocations[index]!.weightBytes - row.weightBytes)).toEqual(Array(8).fill(savedBytes));
  expect(allocations.map(row => row.stateBytes)).toEqual(raw.allocations.map(row => row.stateBytes));

  const analyzed = await analyzeScenario(applied, snapshot);
  if (analyzed.status !== 'available') throw Error(JSON.stringify(analyzed.diagnostics.slice(0, 4)));
  const result = analyzed.result, layout = result.distributed!.layout;
  expect(validateResult(result)).toEqual([]);
  expect(amount(result.total.seconds)).toBeGreaterThan(0);
  const applications = new Map(result.quantizationApplications?.map(row => [row.storageId, row]));
  const gqa = 'decoder[0]/full', linear = 'decoder[0]/linear[0]';
  expect(applications.get(StorageId.parse(`${linear}::delta-qkv-weight-q`))?.specification.auxiliaries[0]?.count)
    .toMatchObject({ kind: 'block', axes: [{ axisId: 'd', blockSize: 128 }, { axisId: 'in', blockSize: 128 }] });
  expect(applications.get(StorageId.parse(`${linear}::decay-log`))?.specification.payloadDtype?.format).toBe('fp32');
  expect([...applications.keys()].some(id => /(?:router-weight|shared-mix-weight|lm-head-weight|conv-weight|cache-k)$/.test(id))).toBe(false);

  const id = NodeId.parse(gqa + '/expert-gate-up');
  const row = layout.localCosts.nodes.find(node => node.nodeId === id)?.placement;
  if (row?.kind !== 'placed' || row.perDevice[0]?.outcome.status !== 'available') throw Error('Missing EP8 cost');
  const { cost } = row.perDevice[0].outcome;
  expect(cost.compute[0]?.computeClass.multiplyDtype.format).toBe('bf16');
  const perExpert = 2 * expertFeatures * hidden, scalesPerExpert = (perExpert / 128 ** 2) * 2;
  expect(amount(cost.logicalReadBytes)).toBe(4 * (perExpert + scalesPerExpert + 2 * hidden + 8));
  const proof = await replayLocalCostSource({ scenario: applied, assets: snapshot, inputHash: result.inputHash,
    engineVersion: result.engineVersion, metric: cost.logicalReadBytes, proofVersion: 3,
    selector: { nodeId: id, deviceId: row.perDevice[0].deviceId, scope: cost.scope, field: 'logicalReadBytes' },
  });
  expect(proof.items).toContainEqual(expect.objectContaining({ kind: 'access', accessId: 'read-expert-gate-up-weight',
    logicalFormula: expect.objectContaining({ quantity: { value: 4 / 64, unit: 'ratio' } }),
    logical: expect.objectContaining({ quantity: { value: 4 * (perExpert + scalesPerExpert), unit: 'byte' } }),
  }));
  expect(await estimateKvCapacity(applied, snapshot)).toMatchObject({ status: 'available', report: { replicatedBytesPerToken: 2048,
    budget: { status: 'available' },
  } });
}, 120_000);

it('rejects an incompatible model snapshot or a selected subgraph for the released weights', () => {
  const { project, scenario } = fixture(), prior = makeQwenHybridParallelAssets('qwen35', 3);
  expect(validateScenario({ ...scenario, model: { ...scenario.model, revision: 3 } }, [...project.assetSnapshots, ...prior]))
    .toContainEqual(expect.objectContaining({ code: 'incompatible_model_weight_profile' }));
  const rule = { ...scenario.quantizationOverrides[0]!, selector: { kind: 'subtree' as const, rootNodeId: NodeId.parse('decoder[0]/full') } };
  expect(validateScenario({ ...scenario, quantizationOverrides: [rule] }, project.assetSnapshots))
    .toContainEqual(expect.objectContaining({ code: 'invalid_model_weight_profile' }));
});
