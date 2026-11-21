import type { AssetDocument } from '@model-analyser/contracts';
import { makeBlockFP8ExecutionAssets } from './block-fp8-execution.js';
import type { DeepSeekV3Release } from './deepseek-v3-profile.js';

const source = 'https://github.com/deepseek-ai/DeepSeek-V3/blob/b15f0dbbbe6a4bc403306175698439ef380f5fb5/inference/';
const sources: AssetDocument['sources'] = [
  ...['model.py', 'kernel.py', 'configs/config_671B.json'].map(filename => ({ kind: 'url' as const, url: source + filename, checkedOn: '2026-11-21' })),
  { kind: 'note', text: 'The FP8 linear branch dynamically converts each input row in groups of 128 contraction elements. The estimate counts FP32 casts, absolute values, maxima, scale calculation, normalization and FP8 conversion as five operations per input element plus one per scale group. Separate gate and up projections each convert their input. Each FP8 dot tile uses two FP32 scales and accumulation, followed by one output cast per result element.' },
  { kind: 'note', text: 'Absorbed MLA key and value contractions use the BF16 analytical baseline, as in the reference path with dequantized KV-B. KV-B dequantization has no separate cost in this estimate. Native FP8 linear work uses a fused analytical tile estimate with conversion tiles and scales on chip. Router, graph outputs, KV and communication use their existing formats.' },
];

export function makeDeepSeekV3FP8ExecutionAssets(assets: AssetDocument[], weight: AssetDocument, release: DeepSeekV3Release) {
  return makeBlockFP8ExecutionAssets(assets, weight, {
    prefix: 'builtin:formula:deepseek-v3-fp8-execution',
    assetId: 'builtin:quantization:deepseek-' + release + '-fp8-execution',
    revision: 1,
    tags: ['deepseek', 'fp8', 'block128', 'dynamic-activation'],
    sources,
    equationSources: sources,
    excludedWeights: ['kv-b-k-weight', 'kv-b-v-weight'],
    repeatActivation: ['gate-up-proj', 'shared-gate-up', 'expert-gate-up'],
    activationOperationsPerElement: 5,
    includeOutputCast: true,
  });
}
