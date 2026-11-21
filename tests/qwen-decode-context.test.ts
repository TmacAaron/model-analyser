import { expect, it } from 'vitest';
import { Scenario, type MetricValue } from '@model-analyser/contracts';
import { analyzeScenario, estimateKvCapacity, previewParallelPreset } from '@model-analyser/core';
import { bindDegreePool, currentDegrees, matchingParallelPresets, serialDegrees } from '../apps/web/src/parallel-degrees.js';
import { makeModelProject } from '../scripts/model-project.js';
import { addQwenContextPreset } from '../scripts/qwen-context-parallel.js';
import { addQwenDecodeContextPreset } from '../scripts/qwen-decode-context.js';
import { makeQwenParallelAssets } from '../scripts/qwen-parallel-assets.js';
import { addQwenPipelinePreset } from '../scripts/qwen-pipeline.js';

const network = { bytesPerSecond: 100e9, latencySeconds: 3e-6 };
const degrees = { ...serialDegrees, dcp: 2 };
const amount = (metric?: MetricValue) => {
  if (metric?.status !== 'available') throw Error('Expected an available cost');
  return metric.quantity.value;
};

it('keeps Qwen KV ownership stable while a two-step decode crosses a split', async () => {
  const base = makeQwenParallelAssets();
  const root = base.find(asset => asset.assetId === 'builtin:model:qwen3-0.6b')!;
  const layer = base.find(asset => asset.definition.kind === 'module')!;
  const [pcpRoot, pcpLayer, ...formulas] = addQwenContextPreset(layer, [addQwenPipelinePreset(root)]);
  const [model, ...dcpAssets] = addQwenDecodeContextPreset(pcpLayer!, [pcpRoot!]);
  const project = makeModelProject([model!, pcpLayer!, ...dcpAssets, ...formulas, ...base.filter(asset => asset.definition.kind === 'formula')],
    { kind: 'decode', batchSize: 1, contextTokensPerRequest: 3, queryTokensPerRequest: 1, steps: 2 }, 'Qwen DCP');
  const scenario = project.scenarios[0]!, assets = project.assetSnapshots;
  scenario.bindings = [{ parameterKey: 'M', value: { kind: 'integer', value: 8 } }];
  const [match] = matchingParallelPresets(degrees, model!.parallelPresets!, scenario);
  expect(match).toMatchObject({ slots: 2, preset: { presetId: 'dcp-kv' } });
  const attempt = await previewParallelPreset({ ...bindDegreePool(scenario, 2), assets, presetId: 'dcp-kv', network });
  if (attempt.status !== 'available') throw Error(attempt.message.slice(0, 6000));
  const { preview } = attempt, reopened = Scenario.parse(JSON.parse(JSON.stringify(preview.scenario)));
  expect(currentDegrees(reopened, model!.parallelPresets!)).toEqual(degrees);
  const layers = 28, heads = 16, width = 128, kvHeads = 8;
  const perToken = 4 * layers * kvHeads * width;
  expect(preview.allocations.map(row => row.stateBytes)).toEqual([4 * perToken, 4 * perToken]);
  expect(preview.communicationCount).toBe(layers * 3);
  const result = await analyzeScenario(reopened, preview.assets);
  if (result.status !== 'available' || !result.result.decode) throw Error(JSON.stringify(result).slice(0, 6000));
  for (const [index, step] of result.result.decode.steps.entries()) {
    const layout = step.result.distributed!.layout;
    const nodeCosts = (id: string) => {
      const placement = layout.localCosts.nodes.find(row => row.nodeId === 'decoder[0]/'+id)?.placement;
      if (placement?.kind !== 'placed') throw Error('Missing local costs '+id);
      return placement.perDevice.map(rank => {
        if (rank.outcome.status !== 'available') throw Error('Missing rank costs '+rank.deviceId);
        return rank.outcome.cost;
      });
    };
    const cacheWrites = nodeCosts('cache-update').map(cost => amount(cost.logicalWriteBytes));
    expect(cacheWrites).toEqual(index === 0 ? [4 * kvHeads * width, 0] : [0, 4 * kvHeads * width]);
    expect(nodeCosts('qk').map(cost => amount(cost.compute[0]?.usefulOperations))).toEqual([4, index].map(n => 2 * heads * width * n));
    expect(nodeCosts('qk').map(cost => amount(cost.compute[0]?.executedOperations))).toEqual([4, 4].map(n => 2 * heads * width * n));
    const attention = layout.communications.filter(row => row.evaluation.definition.source.tensorId.startsWith('decoder[0]::'));
    expect(attention).toHaveLength(3);
    for (const { evaluation } of attention) {
      const { source, placement } = evaluation.definition;
      const max = source.tensorId.endsWith('dcp-max'), numerator = source.tensorId.endsWith('dcp-numerator');
      expect(source.distribution).toMatchObject({ kind: 'partial', reduceOperation: max ? 'max' : 'sum' });
      expect(placement?.beforeNodeIds).toEqual(['decoder[0]/' + (max ? 'shift-exp' : 'normalize')]);
      expect(evaluation.perDevice.map(row => amount(row.sendBytes))).toEqual(Array(2).fill(4 * heads * (numerator ? width : 1)));
    }
    expect(step.stateTransitions).toHaveLength(layers);
    for (const transition of step.stateTransitions) for (const storage of transition.storages) {
      expect(amount(storage.beforeBytes)).toBe(2 * 4 * kvHeads * width);
      expect(amount(storage.afterBytes)).toBe(amount(storage.beforeBytes));
    }
  }
  expect(await estimateKvCapacity(reopened, preview.assets)).toMatchObject({ status: 'available',
    report: { fixedSlotsPerRequest: 8, averageBytesPerToken: perToken, budget: { status: 'fixed' } } });
  const single = await previewParallelPreset({ ...bindDegreePool(reopened, 1), assets: preview.assets, presetId: 'replicated' });
  expect(single).toMatchObject({ status: 'available', preview: { deviceIds: [expect.any(String)], communicationCount: 0 } });
  if (single.status === 'available') expect(single.preview.scenario.parallelPlan.decodeContext).toBeUndefined();

  const short = { ...scenario, bindings: [{ parameterKey: 'M', value: { kind: 'integer' as const, value: 4 } }] };
  expect(await previewParallelPreset({ ...bindDegreePool(short, 2), assets, presetId: 'dcp-kv', network }))
    .toMatchObject({ status: 'unavailable', message: expect.stringContaining('固定 KV 槽位 4') });
  expect(await previewParallelPreset({ ...bindDegreePool(scenario, 3), assets, presetId: 'dcp-kv', network }))
    .toMatchObject({ status: 'unavailable' });
}, 120_000);
