import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { AssetDocument } from '@model-analyser/contracts';

const releases = {
  qwen35: {
    name: 'Qwen3.5-397B-A17B', id: 'qwen3.5-397b-a17b', family: 'qwen3.5',
    revision: '6fe6a3a85cefe43a807df708dccc4e44b02e2955',
    sha256: '3ae7fa89c2f7d1354096418ddaf1331e9e0898a8ca11e804fb6dbaa087efb7da',
    module: 'qwen3_5_moe',
  },
  qwen38: {
    name: 'Qwen3.8-27B', id: 'qwen3.8-27b', family: 'qwen3.8',
    revision: '72a217afab8029b39e4af1c7273a829995a3dbaf',
    sha256: '191e0af232104ed8b65258cf3fb2b842e288008baca7633c11b82a1ac7203aab',
    module: 'qwen3_5',
  },
} as const;
export type QwenHybridRelease = keyof typeof releases;
const transformers = '049d2bf1220747b6d39e2a978b9f5fe0defa1dca';
const configUrl = (release: QwenHybridRelease) => {
  const entry = releases[release];
  return 'https://huggingface.co/Qwen/' + entry.name + '/resolve/' + entry.revision + '/config.json';
};
const codeUrl = (release: QwenHybridRelease) => {
  const module = releases[release].module;
  return 'https://github.com/huggingface/transformers/blob/' + transformers + '/src/transformers/models/' + module + '/modeling_' + module + '.py';
};
const positive = z.number().int().positive();
const textConfig = z.object({
  hidden_size: positive, head_dim: positive, num_attention_heads: positive, num_key_value_heads: positive,
  max_position_embeddings: positive, vocab_size: positive, num_hidden_layers: positive,
  linear_key_head_dim: positive, linear_value_head_dim: positive, linear_num_key_heads: positive,
  linear_num_value_heads: positive, linear_conv_kernel_dim: positive, full_attention_interval: z.literal(4),
  hidden_act: z.literal('silu'), rms_norm_eps: z.literal(1e-6), attention_bias: z.literal(false),
  attention_dropout: z.literal(0), attn_output_gate: z.literal(true), use_cache: z.literal(true),
  dtype: z.literal('bfloat16'), mamba_ssm_dtype: z.literal('float32'),
  layer_types: z.array(z.enum(['linear_attention', 'full_attention'])),
  rope_parameters: z.object({ partial_rotary_factor: z.literal(0.25), rope_type: z.literal('default') }),
});
const profileSchema = z.object({
  tie_word_embeddings: z.literal(false),
  text_config: z.discriminatedUnion('model_type', [
    textConfig.extend({
      model_type: z.literal('qwen3_5_moe_text'), moe_intermediate_size: positive,
      shared_expert_intermediate_size: positive, num_experts: positive, num_experts_per_tok: positive,
      mlp_only_layers: z.tuple([]),
    }),
    textConfig.extend({ model_type: z.literal('qwen3_5_text'), intermediate_size: positive, output_gate_type: z.literal('swish') }),
  ]),
});

export const hybridSources: AssetDocument['sources'] = [
  ...(['qwen35', 'qwen38'] as const).flatMap(release => [configUrl(release), codeUrl(release)]
    .map(url => ({ kind: 'url' as const, url, checkedOn: '2026-11-21' }))),
  { kind: 'note', text: 'Main text decoder only. The analytical profile uses the pinned Transformers full-attention sigmoid output gate in both releases, including Qwen3.8 whose config declares swish. Vision, MTP, training, runtime allocator and distributed execution are outside this scope.' },
  { kind: 'note', text: 'Gated DeltaNet prefill and decode both use the serial recurrent equations for mathematical work. It is an authored idealized state-update/liveness ledger, not the chunk kernel, its scratch space, or an exact PyTorch allocation trace.' },
  { kind: 'note', text: 'BF16 weights, activations, GQA KV and convolution history; FP32 recurrent matrices and explicit FP32 workspace. Norm, nonlinear, comparison and mask work use scalar proxies; casts, index routing implementation, rotary table creation and kernel-specific copies are excluded. Routed traffic uses the upper bound on distinct experts touched.' },
];

export function loadQwenHybrid(release: QwenHybridRelease) {
  const entry = releases[release];
  const bytes = readFileSync(new URL('../references/models/qwen-hybrid/' + release + '-config.json', import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw Error('Qwen config hash changed: ' + release);
  const { text_config: config } = profileSchema.parse(JSON.parse(bytes.toString('utf8')));
  const moe = config.model_type === 'qwen3_5_moe_text';
  if (moe !== (release === 'qwen35') || config.num_hidden_layers !== config.layer_types.length ||
    config.num_hidden_layers % 4 !== 0 ||
    config.layer_types.some((kind, index) => kind !== (index % 4 === 3 ? 'full_attention' : 'linear_attention')) ||
    config.linear_num_value_heads % config.linear_num_key_heads !== 0 ||
    config.num_attention_heads % config.num_key_value_heads !== 0 || config.head_dim % 8 !== 0) {
    throw Error('Qwen config does not match the modeled hybrid layer sequence');
  }
  if (moe && config.num_experts_per_tok > config.num_experts) throw Error('Invalid routed expert count');
  const dimensions = {
    H: config.hidden_size, NH: config.num_attention_heads, NK: config.num_key_value_heads, D: config.head_dim,
    R: config.head_dim * config.rope_parameters.partial_rotary_factor,
    LK: config.linear_num_key_heads, LV: config.linear_num_value_heads,
    DK: config.linear_key_head_dim, DV: config.linear_value_head_dim, W: config.linear_conv_kernel_dim,
    M: config.max_position_embeddings, V: config.vocab_size,
    ...(moe ? { E: config.num_experts, K: config.num_experts_per_tok, J: config.moe_intermediate_size, S: config.shared_expert_intermediate_size }
      : { I: config.intermediate_size }),
  };
  return { ...entry, release, moe, dimensions, periods: config.num_hidden_layers / 4 };
}
