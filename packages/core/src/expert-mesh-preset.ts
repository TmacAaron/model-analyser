import type { ParallelPresetTemplate, Scenario } from '@model-analyser/contracts';
import { canonical } from '../../contracts/src/validation.js';

type Degree = NonNullable<ParallelPresetTemplate['sharedPoolDegrees']>[number];
type Rules = Pick<ParallelPresetTemplate, 'tensorShards' | 'reductions'>;

function remainingRules(shared: Rules, owner?: Rules): Rules {
  const exclude = <T>(rows: T[], excluded: T[] = []) => {
    const keys = new Set(excluded.map(canonical));
    return rows.filter(row => !keys.has(canonical(row)));
  };
  return { tensorShards: exclude(shared.tensorShards, owner?.tensorShards), reductions: exclude(shared.reductions, owner?.reductions) };
}

/** Keep shared-pool rules such as table sharding on the full pool when the owner axis moves to EP. */
function sharedPoolRules(shared: ParallelPresetTemplate, ep: ParallelPresetTemplate, attention: ParallelPresetTemplate): ParallelPresetTemplate {
  const owners = new Map(ep.moduleRules?.map(rule => [canonical(rule.module), rule]));
  const moduleRules = shared.moduleRules?.flatMap(rule => {
    const remaining = remainingRules(rule, owners.get(canonical(rule.module)));
    return remaining.tensorShards.length || remaining.reductions.length ? [{ module: rule.module, ...remaining }] : [];
  });
  const remaining = { ...remainingRules(shared, ep), moduleRules: moduleRules?.length ? moduleRules : undefined };
  const { tensorShards, reductions } = attention;
  const attentionRules = { tensorShards, reductions, moduleRules: attention.moduleRules };
  return canonical(remaining) === canonical(attentionRules) ? attention : { ...shared, ...remaining };
}

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
  return { ep, tp, attention, shared, sharedRules: shared && attention ? sharedPoolRules(shared, ep, attention) : undefined };
}

export function pipelineExpertMeshPresets(pipeline: ParallelPresetTemplate, presets: ParallelPresetTemplate[], phase: Scenario['workload']['kind']) {
  if (pipeline.strategy !== 'pipeline' || !pipeline.pipeline || !pipeline.phases.includes(phase)) return undefined;
  return expertMeshPresets(presets.filter(preset => pipeline.phases.every(phase => preset.phases.includes(phase))), phase);
}
