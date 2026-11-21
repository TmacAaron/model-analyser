import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { AssetDocument } from '@model-analyser/contracts';

const releases = {
  v3: { name: 'DeepSeek-V3', revision: 'bd0dd75c911b4a171ae9b1e0a71f7ae45641cf65', configSha256: '614b5e69a4a59fb8d1853de050016832ba4540a0d632f152eb60f305094e2b4e' },
  r1: { name: 'DeepSeek-R1', revision: '00c6b9d6b8308971df69134e7b421ab7a7fe6f66', configSha256: '79ddea672a62e95d3f0be27be434375538e1988975971cffcf87c96c1de84a65' },
} as const;
export type DeepSeekV3Release = keyof typeof releases;
const url = (release: DeepSeekV3Release, basename: string) =>
  'https://huggingface.co/deepseek-ai/' + releases[release].name + '/resolve/' + releases[release].revision + '/' + basename;
const positive = z.number().int().positive();
const configSchema = z.object({
  model_type: z.literal('deepseek_v3'), attention_bias: z.literal(false), hidden_act: z.literal('silu'),
  tie_word_embeddings: z.literal(false), scoring_func: z.literal('sigmoid'), topk_method: z.literal('noaux_tc'),
  norm_topk_prob: z.literal(true), moe_layer_freq: z.literal(1), rms_norm_eps: z.literal(1e-6),
  hidden_size: positive, intermediate_size: positive, moe_intermediate_size: positive,
  num_hidden_layers: positive, first_k_dense_replace: positive, num_attention_heads: positive,
  num_key_value_heads: positive, q_lora_rank: positive, kv_lora_rank: positive, qk_nope_head_dim: positive,
  qk_rope_head_dim: positive, v_head_dim: positive, n_group: positive, topk_group: positive, n_routed_experts: positive,
  num_experts_per_tok: positive, n_shared_experts: positive, vocab_size: positive, max_position_embeddings: positive,
  routed_scaling_factor: z.literal(2.5), rope_scaling: z.object({ type: z.literal('yarn') }),
  quantization_config: z.object({ quant_method: z.literal('fp8'), fmt: z.literal('e4m3'), activation_scheme: z.literal('dynamic'),
    weight_block_size: z.tuple([z.literal(128), z.literal(128)]) }),
});

export function loadDeepSeekV3Profile(release: DeepSeekV3Release) {
  const entry = releases[release];
  const bytes = readFileSync(new URL('../references/models/deepseek-v3/' + release + '-config.json', import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.configSha256) throw Error('DeepSeek source fingerprint changed: ' + release);
  const config = configSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (config.num_attention_heads !== config.num_key_value_heads || config.first_k_dense_replace >= config.num_hidden_layers ||
    config.n_routed_experts % config.n_group !== 0 || config.topk_group > config.n_group ||
    config.num_experts_per_tok > config.topk_group * config.n_routed_experts / config.n_group) {
    throw Error('DeepSeek config differs from the supported attention and routing layout');
  }
  const dimensions = {
    H: config.hidden_size, NH: config.num_attention_heads, DN: config.qk_nope_head_dim, DR: config.qk_rope_head_dim,
    DV: config.v_head_dim, R: config.kv_lora_rank, QR: config.q_lora_rank, I: config.intermediate_size, J: config.moe_intermediate_size,
    E: config.n_routed_experts, K: config.num_experts_per_tok, S: config.n_shared_experts, GN: config.n_group, TG: config.topk_group,
    V: config.vocab_size, M: config.max_position_embeddings,
  };
  const sources: AssetDocument['sources'] = [
    { kind: 'url', url: url('v3', 'config.json'), checkedOn: '2026-11-20' },
    { kind: 'url', url: url('r1', 'config.json'), checkedOn: '2026-11-20' },
    { kind: 'url', url: url('v3', 'modeling_deepseek.py'), checkedOn: '2026-11-20' },
    { kind: 'url', url: 'https://arxiv.org/html/2412.19437#S2.SS1', checkedOn: '2026-11-20' },
    { kind: 'note', text: 'Main decoder only, with absorbed MLA and explicit rectangular attention temporaries. BF16 analytical weight residency except the FP32 routing correction; published checkpoint FP8 storage, MTP, speculative decoding, YaRN table creation, kernel fusion and distributed layout are outside this definition.' },
    { kind: 'note', text: 'Routed experts use sigmoid affinities. Group and expert selection use corrected scores; weights come from the original affinities, normalized over selected experts and scaled by 2.5. Comparison counts are analytical proxies. Routed weight traffic uses an upper bound on distinct experts touched per call.' },
  ];
  return { release, name: entry.name, revision: entry.revision, dimensions, dense: config.first_k_dense_replace, moe: config.num_hidden_layers - config.first_k_dense_replace, sources };
}

export type DeepSeekV3Profile = ReturnType<typeof loadDeepSeekV3Profile>;
