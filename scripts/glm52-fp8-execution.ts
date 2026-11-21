import type { AssetDocument } from '@model-analyser/contracts';
import { makeBlockFP8ExecutionAssets } from './block-fp8-execution.js';

const vllm = 'https://github.com/vllm-project/vllm/blob/2cf0a6915ce544dc493a0990f2ea38d81601128a/vllm/model_executor/';
const sources: AssetDocument['sources'] = [
  ...['layers/quantization/fp8.py', 'models/deepseek_v2.py', 'layers/attention/mla_attention.py']
    .map(path => ({ kind: 'url' as const, url: vllm + path, checkedOn: '2026-11-22' })),
  { kind: 'note', text: 'The analytical FP8 linear path uses E4M3FN operands, dynamic FP32 scaling per token and 128 contraction features, and FP32 block-scaled accumulation followed by a BF16 output cast. The activation proxy counts six operations per input element and one per group. Gate/up pairs reuse one activation conversion. The graph models Q-A and KV-A as separate projections. Activation and scale tiles are assumed to stay on chip.' },
  { kind: 'note', text: 'Steady-state absorbed MLA uses one BF16 working copy of the K/V up-projection rows. The DSA index key projection also uses BF16 resident weights, consistent with load-time upcasting in the fixed vLLM code. The estimate omits loading cost and any concurrent original checkpoint copies. Index scores, sparse attention, cache and collective formats follow the declared GLM-5.2 graph.' },
];

export function makeGlm52FP8ExecutionAssets(assets: AssetDocument[], checkpoint: AssetDocument) {
  const definition = checkpoint.definition;
  if (definition.kind !== 'quantization' || !definition.modelWeights) throw Error('Missing GLM-5.2 FP8 weight profile');
  const profile = definition.modelWeights;
  const bf16Weights = new Set(['index-k-weight', 'k-absorb-weight']);
  const moduleRules = profile.moduleRules.map(section => ({ ...section,
    targets: section.targets.filter(target => !bf16Weights.has(target.storageId)),
  }));
  return makeBlockFP8ExecutionAssets(assets, { ...checkpoint,
    definition: { ...definition, modelWeights: { ...profile, moduleRules } },
  }, {
    prefix: 'builtin:formula:glm-5.2-fp8-execution', assetId: 'builtin:quantization:glm-5.2-fp8-execution',
    tags: ['glm-5.2', 'fp8', 'block128', 'dynamic-activation'], sources, includeOutputCast: true,
  });
}
