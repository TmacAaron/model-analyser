import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AssetDocument, StorageId, type QuantizedStorageSpec } from '@model-analyser/contracts';
import { z } from 'zod';
import { fp8, fp32, ref } from './model-authoring.js';
import { loadGlm52 } from './glm52-profile.js';

const block = 128;
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const manifest = z.object({
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  configSha256: sha256, indexSha256: sha256,
  headers: z.array(z.object({ shard: z.string(), headerSha256: sha256 })).length(4),
  pairs: z.record(z.string(), z.number().int().positive()),
  samples: z.record(z.string(), z.tuple([z.string()]).rest(z.number().int().positive())),
}).parse(JSON.parse(readFileSync(new URL('../references/models/glm-5.2/fp8-manifest.json', import.meta.url), 'utf8')));

type Matrix = {
  checkpoint: string;
  shape: [rows: number, columns: number];
  count: number;
  layer: number;
  storage: string;
  axes?: { out: string; in: string };
};

export function makeGlm52FP8WeightPreset(assets: AssetDocument[]) {
  const schedule = loadGlm52();
  const bytes = readFileSync(new URL('../references/models/glm-5.2/fp8-config.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.configSha256);
  const config = z.object({
    model_type: z.literal('glm_moe_dsa'),
    num_hidden_layers: z.literal(schedule.layers),
    max_position_embeddings: z.literal(schedule.contextTokens),
    quantization_config: z.object({ quant_method: z.literal('fp8'), fmt: z.literal('e4m3'),
      activation_scheme: z.literal('dynamic'), weight_block_size: z.tuple([z.literal(block), z.literal(block)]) }),
  }).loose().parse(JSON.parse(bytes.toString('utf8')));
  for (const [key, value] of schedule.dimensions) {
    assert.equal(config[schedule.aliases[key as keyof typeof schedule.aliases]], value, key);
  }
  const dimension = (key: keyof typeof schedule.aliases) => {
    const result = schedule.dimensions.find(row => row[0] === key);
    if (!result) throw Error('Missing GLM-5.2 dimension ' + key);
    return result[1];
  };
  const H = dimension('H'), V = dimension('V'), N = dimension('N'), QR = dimension('QR'), R = dimension('R');
  const DN = dimension('DN'), DR = dimension('DR'), DV = dimension('DV'), IH = dimension('IH'), ID = dimension('ID');
  const I = dimension('I'), J = dimension('J'), E = dimension('E');
  assert.equal((DN + DR) % block, 0);
  assert.equal(DV % block, 0);
  assert.equal(ID % block, 0);
  const attention = ([
    { checkpoint: 'q_a_proj', shape: [QR, H], storage: 'qa-weight', axes: { out: 'w1', in: 'w0' } },
    { checkpoint: 'q_b_proj', shape: [N * (DN + DR), QR], storage: 'qb-weight', axes: { out: 'w2', in: 'w0' } },
    { checkpoint: 'kv_a_proj_with_mqa', shape: [R + DR, H], storage: 'kv-a-weight', axes: { out: 'w1', in: 'w0' } },
    { checkpoint: 'kv_b_proj', shape: [N * (DN + DV), R], storage: 'k-absorb-weight', axes: { out: 'w0', in: 'w1' } },
    { checkpoint: 'o_proj', shape: [H, N * DV], storage: 'o-weight', axes: { out: 'w2', in: 'w1' } },
  ] satisfies Omit<Matrix, 'count' | 'layer'>[]).map(row => ({ ...row, checkpoint: 'self_attn.' + row.checkpoint, count: schedule.layers, layer: 0 }));
  const indexer: Matrix[] = [
    { checkpoint: 'self_attn.indexer.wq_b', shape: [IH * ID, QR], storage: 'index-q-weight', axes: { out: 'w2', in: 'w0' }, count: schedule.owners.length, layer: 0 },
    { checkpoint: 'self_attn.indexer.wk', shape: [ID, H], storage: 'index-k-weight', axes: { out: 'w1', in: 'w0' }, count: schedule.owners.length, layer: 0 },
  ];
  const moeLayers = schedule.layers - schedule.dense;
  const ffn = (storage: string, checkpoint: string, width: number, count: number, layer: number, expert = false) =>
    (['gate', 'up', 'down'] as const).map((projection): Matrix => ({
      checkpoint: `mlp.${checkpoint}${projection}_proj`, storage: `${storage}-${projection}-weight`, count, layer,
      shape: projection === 'down' ? [H, width] : [width, H],
      ...(expert ? { axes: { out: 'w2', in: 'w1' } } : {}),
    }));
  const dense = ffn('ffn', '', I, schedule.dense, 0);
  const shared = ffn('shared', 'shared_experts.', J, moeLayers, schedule.dense);
  const routed = ffn('expert', 'experts.*.', J, moeLayers * E, schedule.dense, true);
  const matrices = [...attention, ...indexer, ...dense, ...shared, ...routed];
  assert.deepEqual(manifest.pairs, Object.fromEntries(matrices.map(row => [row.checkpoint + '.weight', row.count])));
  for (const row of matrices) {
    const key = `model.layers.${row.layer}.${row.checkpoint.replace('*', '0')}.weight`;
    assert.deepEqual(manifest.samples[key], ['F8_E4M3', ...row.shape], key);
    assert.deepEqual(manifest.samples[key + '_scale_inv'], ['F32', ...row.shape.map(size => Math.ceil(size / block))], key);
  }
  for (const [key, expected] of Object.entries({
    'model.embed_tokens.weight': ['BF16', V, H], 'model.norm.weight': ['BF16', H], 'lm_head.weight': ['BF16', V, H],
    'model.layers.0.input_layernorm.weight': ['BF16', H], 'model.layers.0.post_attention_layernorm.weight': ['BF16', H],
    'model.layers.0.self_attn.q_a_layernorm.weight': ['BF16', QR], 'model.layers.0.self_attn.kv_a_layernorm.weight': ['BF16', R],
    'model.layers.0.self_attn.indexer.k_norm.weight': ['BF16', ID], 'model.layers.0.self_attn.indexer.k_norm.bias': ['BF16', ID],
    'model.layers.0.self_attn.indexer.weights_proj.weight': ['BF16', IH, H],
    [`model.layers.${schedule.dense}.mlp.gate.weight`]: ['BF16', E, H],
    [`model.layers.${schedule.dense}.mlp.gate.e_score_correction_bias`]: ['F32', E],
  })) assert.deepEqual(manifest.samples[key], expected, key);

  const assetRef = (id: string) => {
    const asset = assets.find(row => row.assetId === id && row.revision === 3);
    if (!asset) throw Error('Missing GLM-5.2 checkpoint asset ' + id + '@3');
    return ref(asset);
  };
  const moduleRule = (blockId: string, rows: Matrix[]) => ({
    module: assetRef('builtin:module:glm-5.2-block-' + blockId),
    targets: rows.map(row => ({ storageId: StorageId.parse(row.storage), ...(row.axes ? { axes: row.axes } : {}) })),
  });
  const weight: QuantizedStorageSpec = { payloadBits: 8, payloadDtype: fp8, packingUnitElements: 1, alignmentBytes: 1,
    auxiliaries: [{ name: 'weight_scale_inv', dtype: fp32,
      count: { kind: 'block', axes: [{ axisId: 'out', blockSize: block }, { axisId: 'in', blockSize: block }] } }],
  };
  const source = 'https://huggingface.co/zai-org/GLM-5.2-FP8/blob/' + manifest.revision + '/';
  return AssetDocument.parse({
    documentType: 'asset', schemaVersion: 1, assetId: 'builtin:quantization:glm-5.2-fp8-weights', revision: 1,
    name: '官方 FP8 权重', parameters: [], tags: ['glm-5.2', 'fp8', 'block128', 'published-weights'],
    sources: [
      ...['config.json', 'model.safetensors.index.json', ...manifest.headers.map(row => row.shard)]
        .map(filename => ({ kind: 'url', url: source + filename, checkedOn: '2026-11-21' })),
      { kind: 'note', text: 'The main text decoder uses published E4M3 matrices with FP32 inverse scales per 128 × 128 block. The absorbed MLA key and value projections share the packed checkpoint layout. The analytical traffic assumes one read of the packed weights and scales, attributed by projection row width. Expert reads include scales for the locally touched matrices. Matrix execution and KV use the BF16 analytical baseline.' },
    ],
    definition: { kind: 'quantization', quantization: { selector: { kind: 'subtree', rootNodeId: '$model' }, weight },
      modelWeights: { model: assetRef('builtin:model:glm-5.2'), moduleRules: [
        moduleRule('dense', [...attention, ...indexer, ...dense]),
        moduleRule('full', [...attention, ...indexer, ...shared, ...routed]),
        moduleRule('shared', [...attention, ...shared, ...routed]),
      ] },
    },
  });
}
