import type { ParallelPresetTemplate, Scenario } from '@model-analyser/contracts';
import { canonical } from '../../contracts/src/validation.js';

type Degree = NonNullable<ParallelPresetTemplate['sharedPoolDegrees']>[number];

/** A joint expert reduction is valid when both layouts already reduce the same partial tile. */
export function expertMeshPresets(presets: ParallelPresetTemplate[], phase: Scenario['workload']['kind']) {
  const single = (degree: Degree) => presets.find(preset => preset.strategy === 'tensor_sharded' &&
    preset.phases.includes(phase) && preset.sharedPoolDegrees?.length === 1 && preset.sharedPoolDegrees[0] === degree);
  const ep = single('moeEp'), tp = single('moeTp');
  if (!ep || !tp) return undefined;
  const reductions = (preset: ParallelPresetTemplate) => [
    ...preset.reductions.map(reduction => canonical([null, reduction])),
    ...preset.moduleRules?.flatMap(rule => rule.reductions.map(reduction => canonical([rule.module, reduction]))) ?? [],
  ].sort();
  const epReductions = reductions(ep);
  if (!epReductions.length || canonical(epReductions) !== canonical(reductions(tp))) return undefined;
  const attention = single('attentionTp');
  const shared = attention && presets.find(preset => preset.strategy === 'tensor_sharded' && preset.phases.includes(phase) &&
    preset.sharedPoolDegrees?.length === 2 && preset.sharedPoolDegrees.includes('attentionTp') && preset.sharedPoolDegrees.includes('moeEp'));
  return { ep, tp, attention, shared };
}

export function pipelineExpertMeshPresets(pipeline: ParallelPresetTemplate, presets: ParallelPresetTemplate[], phase: Scenario['workload']['kind']) {
  if (pipeline.strategy !== 'pipeline' || !pipeline.pipeline || !pipeline.phases.includes(phase)) return undefined;
  return expertMeshPresets(presets.filter(preset => pipeline.phases.every(phase => preset.phases.includes(phase))), phase);
}
