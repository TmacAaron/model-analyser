import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AssetDocument } from '@model-analyser/contracts';
import indexerWeights from '../references/models/glm-5.2/indexer-weights.json' with { type: 'json' };

const release = 'https://huggingface.co/zai-org/GLM-5.2/blob/cf457fa734ab149ffef225f80893eb38c6ff5cdc/';
export const glm52Sources: AssetDocument['sources'] = [
  ...[
    release + 'config.json', release + 'model.safetensors.index.json',
    'https://github.com/huggingface/transformers/blob/e0e7504bca2bfd1b85bb0eedb148f7b250226f06/src/transformers/models/glm_moe_dsa/modeling_glm_moe_dsa.py',
    'https://github.com/vllm-project/vllm/blob/2cf0a6915ce544dc493a0990f2ea38d81601128a/vllm/model_executor/models/deepseek_v2.py',
    'https://github.com/vllm-project/vllm/blob/2cf0a6915ce544dc493a0990f2ea38d81601128a/vllm/v1/attention/backends/mla/flashmla_sparse.py',
  ].map(url => ({ kind: 'url' as const, url, checkedOn: '2026-11-21' })),
  { kind: 'note', text: 'The 78-layer text decoder uses a BF16 analytical sparse MLA path with absorbed K and V projections. Each layer stores 512 latent and 64 rotary values per token. Only 21 indexer owners append a 128-wide index key; their selected row IDs are carried to the reuse layers in the same forward pass.' },
  { kind: 'note', text: 'Selected rows use the release interleaved RoPE and a BF16 dot-product reference with FP32 scoring. Explicit materialized score tiles model causal useful pairs and rectangular executed work. Active expert weights are read once per distinct selected expert using an upper bound. Router and softmax nonlinear operations and TopK use arithmetic proxies.' },
  { kind: 'note', text: 'Theoretical baseline with untied BF16 token embeddings and full-position output projection. MTP, fused kernels, actual FP8 index packing, RoPE table generation, distributed layout, and data-dependent routes are outside this model profile.' },
];

export function loadGlm52() {
  const bytes = readFileSync(new URL('../references/models/glm-5.2/config.json', import.meta.url));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== '185f93ee6d12548e16a847e279dc0c3c90b1524c970b0866b42fb545747d859a') throw Error('GLM-5.2 config lock changed');
  const config = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  const aliases = {
    H: 'hidden_size', V: 'vocab_size', N: 'num_attention_heads', QR: 'q_lora_rank', R: 'kv_lora_rank',
    DN: 'qk_nope_head_dim', DR: 'qk_rope_head_dim', DV: 'v_head_dim', IH: 'index_n_heads', ID: 'index_head_dim',
    IK: 'index_topk', I: 'intermediate_size', J: 'moe_intermediate_size', E: 'n_routed_experts', K: 'num_experts_per_tok',
  };
  const dimensions = Object.entries(aliases).map(([name, field]) => {
    const value = config[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw Error('GLM-5.2 invalid dimension ' + field);
    return [name, value] as const;
  });
  const dense = 3, initialReuse = 3, periods = 18;
  const owners = [0, 1, 2, ...Array.from({ length: periods }, (_, i) => dense + initialReuse + 4 * i)];
  const layers = dense + initialReuse + 4 * periods;
  const mlp = config['mlp_layer_types'], indexer = config['indexer_types'];
  if (config['model_type'] !== 'glm_moe_dsa' || config['dtype'] !== 'bfloat16' || config['num_hidden_layers'] !== layers ||
    config['n_group'] !== 1 || config['topk_group'] !== 1 || config['n_shared_experts'] !== 1 ||
    config['norm_topk_prob'] !== true || config['routed_scaling_factor'] !== 2.5 || config['scoring_func'] !== 'sigmoid' ||
    config['attention_bias'] !== false || config['indexer_rope_interleave'] !== true || config['rope_interleave'] !== true ||
    config['tie_word_embeddings'] !== false || !Array.isArray(mlp) || mlp.length !== layers ||
    mlp.some((kind, i) => kind !== (i < dense ? 'dense' : 'sparse')) || !Array.isArray(indexer) || indexer.length !== layers ||
    indexer.some((kind, i) => kind !== (owners.includes(i) ? 'full' : 'shared')) ||
    JSON.stringify(indexerWeights.backboneLayers) !== JSON.stringify(owners)) throw Error('GLM-5.2 layer schedule or weight ownership changed');
  return { dimensions, dense, initialReuse, periods };
}
