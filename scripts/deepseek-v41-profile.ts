import assert from 'node:assert/strict';
import type { AssetDocument } from '@model-analyser/contracts';
import { deepSeekAttentionDimensions, lockedJson } from './deepseek-v4-profile.js';

export const deepSeekV41Release = 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/314113f8a7dadb388215396ba5fbee2c610a04d6/';
export const deepSeekV41Sources: AssetDocument['sources'] = [
  ...['config.json', 'inference/config.json', 'inference/model.py', 'inference/kernel.py', 'inference/engram.py'].map(path => ({
    kind: 'url' as const, url: deepSeekV41Release + path, checkedOn: '2026-11-21',
  })),
  { kind: 'note', text: 'Main text backbone. Large matrices use a BF16 reference except source FP32 operations and the explicitly stored FP8 Engram table with E8M0 scales. Checkpoint FP8/FP4 MoE and projection kernels, vision, DSpark, sampling and parallel layouts need separate configurations.' },
  { kind: 'note', text: 'BF16 attention caches represent active batch lanes in the reference fake-quant path. Physical cache grows by completed groups and preserves all provisioned local windows. The Engram token history reserves its configured context length; its precomputed token map uses the released embedding vocabulary as an upper bound.' },
  { kind: 'note', text: 'CSA2 runs full index dot products before applying the candidate mask, as in the reference implementation. Sparse attention, hash, nonlinear and selection work use explicit analytical operation/traffic proxies. Pair counts use the published candidate dimensions and assume enough candidate entries for final Top-K; logical query chunks extend the reference initial prefill and single-token decode.' },
];

export function loadDeepSeekV41() {
  const folder = 'deepseek-v41';
  const config = lockedJson('config.json', '8be45ce0476004a3f529fd896115a4a2e800a129ad2d3ec05b16050f52e21879', folder);
  const reference = lockedJson('inference-config.json', '2e84f45cf1dac8c7fcbb200e96667d4b913275690668ed496f24c7747207a809', folder);
  const text = config.text_config as Record<string, unknown>;
  assert.equal(config.model_type, 'deepseek_v41');
  assert.equal(text.num_hidden_layers, 40);
  assert.equal(reference.n_layers, 40);
  assert.equal(text.num_key_value_heads, 1);
  assert.equal(text.n_shared_experts, 1);
  assert.equal(reference.n_shared_experts, 1);
  assert.equal(text.rms_norm_eps, 1e-20);
  assert.equal(reference.norm_eps, 1e-20);
  assert.equal(text.tie_word_embeddings, false);
  assert.equal(text.scoring_func, 'sqrtsoftplus');
  assert.equal(reference.score_func, 'sqrtsoftplus');
  assert.equal(text.norm_topk_prob, true);
  const dimensions = deepSeekAttentionDimensions(text, reference);
  const ratios = [0, 0, ...Array<number>(18).fill(2), ...Array<number>(20).fill(1), 0, 0, 0];
  assert.deepEqual(text.compress_ratios, ratios);
  assert.deepEqual(reference.compress_ratios, ratios);
  for (const [configField, referenceField, expected] of [
    ['kv_source_layer_ids', 'kv_source_layers', [2, 8, 14, 20]],
    ['index_source_layer_ids', 'index_source_layers', [2, 8, 14, 20, 24, 28, 32, 36]],
    ['candidate_source_layer_id', 'candidate_source_layer', 20],
    ['engram_layer_ids', 'engram_layer_ids', [1, 14]],
    ['engram_num_embeddings', 'engram_num_embeddings', [384006168, 384016682]],
  ] as const) {
    assert.deepEqual(text[configField], expected);
    assert.deepEqual(reference[referenceField], expected);
  }
  function value(field: string) {
    const numeric = text[field];
    assert.ok(typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric > 0);
    if (field in reference) assert.equal(numeric, reference[field]);
    return numeric;
  }
  const candidate = { CB: value('candidate_block_size'), CK: value('candidate_topk_blocks') };
  assert.ok((candidate.CK - 1) * candidate.CB >= dimensions['IK']!);
  return {
    dimensions: {
      ...dimensions, ...candidate, ED: value('engram_head_dim'), EH: value('engram_n_heads'),
      EN: value('engram_max_ngram_size'), EL: 2, M: value('max_position_embeddings'),
      ER1: 384006168, ER14: 384016682, EB: 32,
    },
    quantization: config.quantization_config, expertFormat: reference.expert_dtype,
  };
}
