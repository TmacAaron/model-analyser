import type { AssetDocument } from '@model-analyser/contracts';
import { makeBlockFP8ExecutionAssets } from './block-fp8-execution.js';

const sources: AssetDocument['sources'] = [
  { kind: 'url', url: 'https://docs.vllm.ai/en/v0.15.0/api/vllm/model_executor/layers/quantization/utils/quant_utils/#vllm.model_executor.layers.quantization.utils.quant_utils.kDynamic128Scale', checkedOn: '2026-11-21' },
  { kind: 'note', text: 'Estimate a fused projection with one dynamic FP32 activation scale per row and per 128 contraction features, E4M3FN operands, and FP32 accumulators. The conversion work proxy is six operations per input element and one per scale group. The output work proxy is three operations per output element and contraction chunk, covering the two scales, partial sum and final output conversion. Working tiles and scales reside on chip. Graph outputs, collectives and cached state keep their declared formats.' },
];
export function makeQwen35FP8ExecutionAssets(assets: AssetDocument[], weightPreset: AssetDocument): AssetDocument[] {
  return makeBlockFP8ExecutionAssets(assets, weightPreset, {
    prefix: 'builtin:formula:qwen35-fp8-execution', assetId: 'builtin:quantization:qwen3.5-397b-a17b-fp8-execution',
    tags: ['qwen', 'fp8', 'block128', 'dynamic-activation'], sources,
  });
}
