import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AssetDocument, NodeId, StorageId, type QuantizedStorageSpec } from '@model-analyser/contracts';
import { z } from 'zod';
import { bf16, fp32, ref } from './model-authoring.js';

const repo = 'Qwen/Qwen3.5-397B-A17B-FP8', revision = 'ea5b4f81096f3901c91dea97f81324302495781d';
const base = `https://huggingface.co/${repo}/blob/${revision}`;
const fingerprint = '9a142fc6c2d67703255ce6120ee04c4c720ec58dba6ae44bebb29c4a2d6e5db8';
const indexFingerprint = '5a0489df2921265612613cd9b212842d2ba3af693eac1cf33d35f04fb9c15a9e';
const fixture = (name: string) => readFileSync(new URL('../references/models/qwen-hybrid/qwen35-fp8-' + name + '.json', import.meta.url));
const checkpointShape = z.object({ dtype: z.enum(['BF16', 'F32', 'F8_E4M3']), shape: z.array(z.number().int().positive()) });
const manifestSchema = z.object({ repository: z.literal(repo), revision: z.literal(revision), configSha256: z.literal(fingerprint),
  indexSha256: z.literal(indexFingerprint), tensorGroups: z.record(z.string(), z.object({ tensorCount: z.number().int().positive(), scaledTensorCount: z.number().int().nonnegative() })),
  examples: z.record(z.string(), z.object({ weight: checkpointShape, scale: checkpointShape.optional() })) });

const routed = ['down_proj', 'gate_proj', 'up_proj'] as const;
const projections = ['q_proj', 'k_proj', 'v_proj', 'o_proj'] as const;
const linear = ['in_proj_qkv', 'in_proj_z', 'out_proj'] as const;

function verifyCheckpoint() {
  const bytes = fixture('config');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), fingerprint);
  const config = z.object({ quantization_config: z.object({ quant_method: z.literal('fp8'), activation_scheme: z.literal('dynamic'),
    weight_per_tensor: z.literal(false), act_per_tensor: z.literal(false), weight_block_size: z.tuple([z.literal(128), z.literal(128)]),
    modules_to_not_convert: z.array(z.string()),
  }), text_config: z.object({ num_hidden_layers: z.literal(60), num_experts: z.literal(512), num_experts_per_tok: z.literal(10) }) }).parse(JSON.parse(bytes.toString('utf8')));
  const manifest = manifestSchema.parse(JSON.parse(fixture('weight-manifest').toString('utf8')));
  const quantized = new Map<string, number>();
  for (const leaf of linear) quantized.set(`linear_attn.${leaf}.weight`, 45);
  for (const leaf of projections) quantized.set(`self_attn.${leaf}.weight`, 15);
  for (const leaf of routed) {
    quantized.set(`mlp.experts.*.${leaf}.weight`, 60 * 512);
    quantized.set(`mlp.shared_expert.${leaf}.weight`, 60);
  }
  const actual = Object.entries(manifest.tensorGroups).filter(([, value]) => value.scaledTensorCount > 0);
  assert.equal(actual.length, quantized.size);
  for (const [name, counts] of actual) {
    const count = quantized.get(name);
    assert.ok(count, name);
    assert.deepEqual(counts, { tensorCount: count, scaledTensorCount: count }, name);
  }
  for (const [name, { weight, scale }] of Object.entries(manifest.examples)) {
    if (scale) {
      assert.equal(weight.dtype, 'F8_E4M3', name);
      assert.equal(scale.dtype, 'BF16', name);
      assert.equal(weight.shape.length, 2, name);
      assert.deepEqual(scale.shape, weight.shape.map(size => Math.ceil(size / 128)), name);
    }
  }
  const prefix = 'model.language_model.layers.0.';
  for (const key of ['linear_attn.conv1d', 'linear_attn.in_proj_a', 'linear_attn.in_proj_b', 'mlp.gate', 'mlp.shared_expert_gate']) {
    assert.ok(config.quantization_config.modules_to_not_convert.includes(prefix + key), key);
    assert.equal(manifest.examples[prefix + key + '.weight']?.weight.dtype, 'BF16', key);
  }
  for (const key of ['lm_head.weight', 'model.language_model.embed_tokens.weight']) assert.equal(manifest.examples[key]?.weight.dtype, 'BF16', key);
  for (const key of ['linear_attn.A_log', 'linear_attn.norm.weight']) assert.equal(manifest.examples[prefix + key]?.weight.dtype, 'F32', key);
}

export function makeQwen35FP8WeightPreset(assets: AssetDocument[]) {
  verifyCheckpoint();
  const asset = (id: string, kind: 'model' | 'module') => {
    const value = assets.find(entry => entry.assetId === id && entry.revision === 4 && entry.definition.kind === kind);
    if (!value) throw Error('Missing fixed text decoder asset ' + id);
    return ref(value);
  };
  const weight: QuantizedStorageSpec = { payloadBits: 8, payloadDtype: { category: 'float', bits: 8, format: 'fp8_e4m3fn' },
    packingUnitElements: 1, alignmentBytes: 1, auxiliaries: [{ name: 'weight_scale_inv', dtype: bf16,
      count: { kind: 'block', axes: [{ axisId: 'out', blockSize: 128 }, { axisId: 'in', blockSize: 128 }] } }] };
  const fp32Weight: QuantizedStorageSpec = { payloadBits: 32, payloadDtype: fp32, packingUnitElements: 1, alignmentBytes: 1, auxiliaries: [] };
  const matrix = (storageId: string, outputAxis?: string) => ({ storageId: StorageId.parse(storageId), ...(outputAxis ? { axes: { out: outputAxis } } : {}) });
  const common = [matrix('expert-gate-up-weight', 'i'), matrix('expert-down-weight'),
    ...['shared-gate-weight', 'shared-up-weight', 'shared-down-weight'].map(id => matrix(id))];
  return AssetDocument.parse({ documentType: 'asset', schemaVersion: 1, assetId: 'builtin:quantization:qwen3.5-397b-a17b-fp8-weights', revision: 1,
    name: '官方 FP8 权重', parameters: [], tags: ['qwen', 'fp8', 'block128', 'published-weights'], sources: [
      { kind: 'url', url: base + '/config.json', checkedOn: '2026-11-21' },
      { kind: 'url', url: base + '/model.safetensors.index.json', checkedOn: '2026-11-21' },
      { kind: 'note', text: 'E4M3FN payload and one BF16 inverse scale per 128 × 128 block per matrix. Coverage from the full checkpoint index and dtypes from pinned Safetensors headers. DeltaNet A_log and gated norm weights use FP32. Input/output activations, KV and other state retain the authored text graph formats. This preset models checkpoint weight residency and corresponding memory traffic. Matrix execution uses the declared BF16 analytical baseline; dynamic activation scales, conversion kernels and native FP8 execution require separate definitions.' },
    ], definition: { kind: 'quantization', quantization: { selector: { kind: 'subtree', rootNodeId: NodeId.parse('$model') }, weight },
      modelWeights: { model: asset('builtin:model:qwen3.5-397b-a17b', 'model'), moduleRules: [
        { module: asset('builtin:module:qwen-hybrid-moe-delta', 'module'), targets: [
          ...common, ...['q', 'k', 'v'].map(part => matrix('delta-qkv-weight-' + part, 'd')), matrix('delta-output-gate-weight'), matrix('delta-o-weight'),
          ...['decay-log', 'value-norm-weight'].map(id => ({ storageId: StorageId.parse(id), specification: fp32Weight })),
        ] },
        { module: asset('builtin:module:qwen-hybrid-moe-gqa', 'module'), targets: [...common, ...['q-weight', 'k-weight', 'v-weight', 'o-weight'].map(id => matrix(id))] },
      ] },
    },
  });
}
