import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AssetDocument } from '@model-analyser/contracts';

const release = 'https://huggingface.co/moonshotai/Kimi-K3/blob/1f5d44f794ef598de7b6f529ef7923729b7e5408/';
const kernel = 'https://github.com/fla-org/flash-linear-attention/blob/479745d8a009a87fba4a4ab2440deede85b6e974/fla/ops/kda/';
export const kimiK3Sources: AssetDocument['sources'] = [
  ...[release + 'config.json', release + 'configuration_kimi_k3.py', release + 'modeling_kimi_linear.py',
    kernel + 'fused_recurrent.py', kernel + 'gate.py', 'https://vllm.ai/blog/2026-07-27-k3']
    .map(url => ({ kind: 'url' as const, url, checkedOn: '2026-11-21' })),
  { kind: 'note', text: 'The published 93-layer text decoder uses 69 KDA and 24 gated NoPE MLA layers, eight depth archives, and one initial dense SiTU-GLU layer. Each subsequent MoE has 896 routed experts, 16 selected per token and two shared experts.' },
  { kind: 'note', text: 'BF16 analytical model with FP32 KDA matrix state, BF16 short-convolution history, and an absorbed MLA cache. NoPE passes both query/key channel sets unchanged. Attention Residual archives contain current-call token activations across depth; they do not persist as KV across Decode calls.' },
  { kind: 'note', text: 'Attention and expert compute uses a logical materialized reference, explicit arithmetic proxies and an upper bound on distinct selected routed expert weights. The released MXFP4 storage and fused kernels, chunk KDA kernel execution, device sharding and vision encoder are outside this BF16 profile.' },
];

export function loadKimiK3() {
  const bytes = readFileSync(new URL('../references/models/kimi-k3/config.json', import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== '9710e121a58d03ac92c8d6da287a19541994319afbbe6d6202af001ffd379213') {
    throw Error('Kimi-K3 config lock changed');
  }
  const { text_config: text } = JSON.parse(bytes.toString('utf8')) as { text_config: Record<string, unknown> };
  const linear = text['linear_attn_config'] as Record<string, unknown>;
  const aliases = {
    H: 'hidden_size', V: 'vocab_size', N: 'num_attention_heads', QR: 'q_lora_rank', R: 'kv_lora_rank',
    DN: 'qk_nope_head_dim', DX: 'qk_rope_head_dim', DV: 'v_head_dim', I: 'intermediate_size',
    J: 'moe_intermediate_size', E: 'num_experts', K: 'num_experts_per_token', S: 'num_shared_experts', M: 'routed_expert_hidden_size',
  };
  const dimension = (name: string, value: unknown) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw Error('Kimi-K3 invalid dimension ' + name);
    return [name, value] as const;
  };
  const dimensions = [...Object.entries(aliases).map(([name, key]) => dimension(name, text[key])),
    dimension('D', linear['head_dim']), dimension('W', linear['short_conv_kernel_size'])];
  const layers = 93, blockSize = 12, fullBlocks = 7;
  const mla = [...Array.from({ length: 23 }, (_, i) => 4 * (i + 1)), layers];
  const kda = Array.from({ length: layers }, (_, i) => i + 1).filter(i => !mla.includes(i));
  if (text['model_type'] !== 'kimi_linear' || text['num_hidden_layers'] !== layers || text['attn_res_block_size'] !== blockSize ||
    text['first_k_dense_replace'] !== 1 || text['num_key_value_heads'] !== text['num_attention_heads'] || linear['num_heads'] !== text['num_attention_heads'] ||
    text['moe_layer_freq'] !== 1 || text['latent_moe_use_norm'] !== true || text['num_expert_group'] !== 1 || text['topk_group'] !== 1 ||
    text['moe_router_activation_func'] !== 'sigmoid' || text['moe_renormalize'] !== true || text['routed_scaling_factor'] !== 1 ||
    text['mla_use_nope'] !== true || text['mla_use_output_gate'] !== true || text['tie_word_embeddings'] !== false ||
    text['hidden_act'] !== 'situ' || text['activation_situ_beta'] !== 4 || text['activation_situ_linear_beta'] !== 25 ||
    linear['use_full_rank_gate'] !== true || linear['gate_lower_bound'] !== -5 ||
    JSON.stringify(linear['full_attn_layers']) !== JSON.stringify(mla) || JSON.stringify(linear['kda_layers']) !== JSON.stringify(kda)) {
    throw Error('Kimi-K3 attention, routing or depth schedule changed');
  }
  return { dimensions, fullBlocks };
}
