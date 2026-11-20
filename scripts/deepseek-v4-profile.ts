import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AssetDocument } from '@model-analyser/contracts';

const release = 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/blob/60d8d70770c6776ff598c94bb586a859a38244f1/';
export const deepSeekV4Sources: AssetDocument['sources'] = [
  ...['config.json', 'inference/config.json', 'inference/model.py', 'inference/kernel.py'].map(path => ({
    kind: 'url' as const, url: release + path, checkedOn: '2026-11-21',
  })),
  { kind: 'note', text: 'Main text decoder only. Large matrices are modeled at BF16 with FP32 accumulation. Reference FP32 compressor, hyper-connection, router and output projections use the generic FP32 compute ceiling. The release checkpoint uses FP8 and routed FP4; its physical weights, quantization kernels and auxiliary scales require their own configuration.' },
  { kind: 'note', text: 'BF16 window, compressed latent and indexer caches use active batch lanes, a provisioned local ring and completed global rows. Compressor value and score buffers are FP32. The causal equations support a logical query chunk after past tokens; the release reference uses an initial prefill followed by one-token calls.' },
  { kind: 'note', text: 'Sparse attention uses a materialized rectangular score and probability reference, with exact useful causal pair counts. Weight traffic assumes each active routed expert is read once and uses an upper bound on distinct experts. Nonlinear, selection, fake quantization and Sinkhorn use explicit operation proxies. MTP, kernel scheduling, data-dependent sparsity, YaRN table generation and distributed layout are outside this preset.' },
];

function lockedJson(filename: string, expected: string): Record<string, unknown> {
  const contents = readFileSync(new URL('../references/models/deepseek-v4/' + filename, import.meta.url));
  if (createHash('sha256').update(contents).digest('hex') !== expected) throw Error('DeepSeek-V4 source changed: ' + filename);
  return JSON.parse(contents.toString('utf8')) as Record<string, unknown>;
}

export function loadDeepSeekV4() {
  const config = lockedJson('config.json', 'b628e63398a645abc711d92207f8737dd8140f7a4ef1e0a5b3616019e0ddd818');
  const reference = lockedJson('inference-config.json', '6cc6f816ca73a8d38750194e330398e4f6955b4b45f674f7d29c96da14ccb733');
  const aliases = {
    H: ['hidden_size', 'dim'], V: ['vocab_size', 'vocab_size'], I: ['moe_intermediate_size', 'moe_inter_dim'],
    D: ['head_dim', 'head_dim'], R: ['qk_rope_head_dim', 'rope_head_dim'], N: ['num_attention_heads', 'n_heads'],
    QR: ['q_lora_rank', 'q_lora_rank'], OG: ['o_groups', 'o_groups'], OR: ['o_lora_rank', 'o_lora_rank'],
    W: ['sliding_window', 'window_size'], IH: ['index_n_heads', 'index_n_heads'], ID: ['index_head_dim', 'index_head_dim'],
    IK: ['index_topk', 'index_topk'], E: ['n_routed_experts', 'n_routed_experts'], K: ['num_experts_per_tok', 'n_activated_experts'],
    HC: ['hc_mult', 'hc_mult'], SI: ['hc_sinkhorn_iters', 'hc_sinkhorn_iters'],
  } as const;
  const dimensions = Object.fromEntries(Object.entries(aliases).map(([name, [published, runtime]]) => {
    const value = config[published];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value !== reference[runtime]) {
      throw Error('DeepSeek-V4 dimension mismatch: ' + published);
    }
    return [name, value];
  }));
  const periods = 20;
  const ratios = [0, 0, 4, ...Array.from({ length: periods }, () => [128, 4]).flat(), 0];
  const matches = (sequence: number[], input: unknown) =>
    Array.isArray(input) && input.length >= sequence.length && sequence.every((ratio, index) => ratio === input[index]);
  if (config.model_type !== 'deepseek_v4' || config.num_hidden_layers !== 43 || reference.n_layers !== 43 ||
    config.num_hash_layers !== 3 || reference.n_hash_layers !== 3 ||
    config.num_key_value_heads !== 1 || config.n_shared_experts !== 1 || reference.n_shared_experts !== 1 ||
    config.scoring_func !== 'sqrtsoftplus' || reference.score_func !== 'sqrtsoftplus' || config.tie_word_embeddings !== false ||
    !matches(ratios, config.compress_ratios) || !matches(ratios, reference.compress_ratios)) {
    throw Error('DeepSeek-V4 backbone no longer matches the authored schedule');
  }
  return { dimensions, periods };
}
