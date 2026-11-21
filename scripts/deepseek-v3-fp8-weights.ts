import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AssetDocument, StorageId, type QuantizedStorageSpec } from '@model-analyser/contracts';
import { z } from 'zod';
import { loadDeepSeekV3Profile, type DeepSeekV3Release } from './deepseek-v3-profile.js';
import { fp32, ref } from './model-authoring.js';

const block = 128;
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const revision = z.string().regex(/^[0-9a-f]{40}$/);
const releaseMetadata = z.object({ revision, headers: z.array(z.object({ revision, shard: z.string(), headerSha256: sha256 })).length(2) });
const manifest = z.object({ indexSha256: sha256, indexGitBlob: revision, releases: z.object({ v3: releaseMetadata, r1: releaseMetadata }),
  pairs: z.record(z.string(), z.number().int().positive()), samples: z.record(z.string(), z.array(z.union([z.string(), z.number().int().positive()]))),
}).parse(JSON.parse(readFileSync(new URL('../references/models/deepseek-v3/fp8-manifest.json', import.meta.url), 'utf8')));

const projections = ['gate', 'up', 'down'] as const;
type Matrix = { checkpoint: string; count: number; sampleLayer: number; shape: [number, number]; storageIds: string[] };

export function makeDeepSeekV3FP8WeightPreset(assets: AssetDocument[], release: DeepSeekV3Release) {
  const profile = loadDeepSeekV3Profile(release), pin = manifest.releases[release];
  assert.equal(profile.revision, pin.revision);
  const { H, QR, R, NH, DN, DR, DV, I, J, E, S, V } = profile.dimensions, layers = profile.dense + profile.moe;
  // The checkpoint interleaves key and value rows per head. Both pieces start on scale-block boundaries.
  assert.equal(DN % block, 0);
  assert.equal(DV % block, 0);
  const attentionMatrices: Omit<Matrix, 'count' | 'sampleLayer'>[] = [
    { checkpoint: 'self_attn.q_a_proj', shape: [QR, H], storageIds: ['q-a-weight'] },
    { checkpoint: 'self_attn.q_b_proj', shape: [NH * (DN + DR), QR], storageIds: ['q-weight'] },
    { checkpoint: 'self_attn.kv_a_proj_with_mqa', shape: [R + DR, H], storageIds: ['kv-a-weight'] },
    { checkpoint: 'self_attn.kv_b_proj', shape: [NH * (DN + DV), R], storageIds: ['kv-b-k-weight', 'kv-b-v-weight'] },
    { checkpoint: 'self_attn.o_proj', shape: [H, NH * DV], storageIds: ['o-weight'] },
  ];
  const attention = attentionMatrices.map(matrix => ({ ...matrix, count: layers, sampleLayer: 0 }));
  const feedForward = (graphPrefix: string, checkpointPrefix: string, width: number, count: number, sampleLayer: number) =>
    projections.map((projection): Matrix => ({ checkpoint: `mlp.${checkpointPrefix}${projection}_proj`, count, sampleLayer,
      shape: projection === 'down' ? [H, width] : [width, H], storageIds: [`${graphPrefix}${projection}-weight`] }));
  const dense = feedForward('', '', I, profile.dense, 0);
  const shared = feedForward('shared-', 'shared_experts.', S * J, profile.moe, profile.dense);
  const routed = feedForward('expert-', 'experts.*.', J, profile.moe * E, profile.dense);
  const matrices = [...attention, ...dense, ...shared, ...routed];
  assert.deepEqual(manifest.pairs, Object.fromEntries(matrices.map(matrix => [matrix.checkpoint + '.weight', matrix.count])));
  for (const matrix of matrices) {
    const key = `model.layers.${matrix.sampleLayer}.${matrix.checkpoint.replace('*', '0')}.weight`;
    assert.deepEqual(manifest.samples[key], ['F8_E4M3', ...matrix.shape], key);
    assert.deepEqual(manifest.samples[key + '_scale_inv'], ['F32', ...matrix.shape.map(size => Math.ceil(size / block))], key);
  }
  for (const [key, expected] of Object.entries({
    'model.embed_tokens.weight': ['BF16', V, H], 'model.norm.weight': ['BF16', H], 'lm_head.weight': ['BF16', V, H],
    'model.layers.0.input_layernorm.weight': ['BF16', H], 'model.layers.0.post_attention_layernorm.weight': ['BF16', H],
    'model.layers.0.self_attn.q_a_layernorm.weight': ['BF16', QR], 'model.layers.0.self_attn.kv_a_layernorm.weight': ['BF16', R],
    [`model.layers.${profile.dense}.mlp.gate.weight`]: ['BF16', E, H],
    [`model.layers.${profile.dense}.mlp.gate.e_score_correction_bias`]: ['F32', E],
  })) assert.deepEqual(manifest.samples[key], expected, key);

  const asset = (id: string, expectedRevision: number) => {
    const value = assets.find(entry => entry.assetId === id && entry.revision === expectedRevision);
    if (!value) throw Error('Missing DeepSeek checkpoint asset ' + id + '@' + expectedRevision);
    return ref(value);
  };
  const weight: QuantizedStorageSpec = { payloadBits: 8, payloadDtype: { category: 'float', bits: 8, format: 'fp8_e4m3fn' },
    packingUnitElements: 1, alignmentBytes: 1, auxiliaries: [{ name: 'weight_scale_inv', dtype: fp32,
      count: { kind: 'block', axes: [{ axisId: 'out', blockSize: block }, { axisId: 'in', blockSize: block }] } }] };
  const targets = (rows: Matrix[]) => rows.flatMap(row => row.storageIds.map(id => ({ storageId: StorageId.parse(id) })));
  const source = (filename: string, commit = pin.revision) => `https://huggingface.co/deepseek-ai/${profile.name}/blob/${commit}/${filename}`;
  const modelId = `builtin:model:deepseek-${release}`;
  const model = assets.find(row => row.assetId === modelId && row.definition.kind === 'model');
  if (model?.revision !== 5 && model?.revision !== 6) throw Error('Missing compatible DeepSeek decoder for published FP8');
  return AssetDocument.parse({ documentType: 'asset', schemaVersion: 1, assetId: `builtin:quantization:deepseek-${release}-fp8-weights`, revision: model.revision - 4,
    name: '官方 FP8 权重', parameters: [], tags: ['deepseek', 'fp8', 'block128', 'published-weights'], sources: [
      ...[source('config.json'), source('model.safetensors.index.json'), ...pin.headers.map(header => source(header.shard, header.revision)),
        'https://huggingface.co/deepseek-ai/DeepSeek-V3/blob/e815299b0bcbac849fa540c768ef21845365c9eb/README_WEIGHTS.md']
        .map(url => ({ kind: 'url', url, checkedOn: '2026-11-21' })),
      { kind: 'note', text: 'Main decoder matrix coverage is verified against the checkpoint index and sampled Safetensors headers. The storage profile uses E4M3FN with one FP32 inverse scale per 128 × 128 block. Key and value projections retain complete blocks when separated in the absorbed MLA graph. Experts only read the locally touched fraction of weights and scales. Matrix execution uses the BF16 analytical baseline. KV, routing and other non-FP8 tensors retain their declared formats.' },
    ], definition: { kind: 'quantization', quantization: { selector: { kind: 'subtree', rootNodeId: '$model' }, weight },
      modelWeights: { model: ref(model), moduleRules: [
        { module: asset('builtin:module:deepseek-v3-absorbed-dense', 3), targets: targets([...attention, ...dense]) },
        { module: asset('builtin:module:deepseek-v3-absorbed-moe', 5), targets: targets([...attention, ...shared, ...routed]) },
      ] },
    },
  });
}
