import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AssetDocument, StorageId, type QuantizedStorageSpec } from '@model-analyser/contracts';
import { z } from 'zod';
import { loadDeepSeekV4 } from './deepseek-v4-profile.js';
import { loadDeepSeekV41 } from './deepseek-v41-profile.js';
import { ref } from './model-authoring.js';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const manifestSchema = z.object({ revision: z.string().regex(/^[0-9a-f]{40}$/), indexSha256: hash,
  headers: z.array(z.object({ shard: z.string(), headerSha256: hash })).min(1), scalePairs: z.record(z.string(), z.number().int().positive()),
  samples: z.record(z.string(), z.tuple([z.string()]).rest(z.number().int().positive())),
});
const scaleDtype = { category: 'float', bits: 8, format: 'e8m0' } as const;
const groupSize = 32;
const sourceGroup = (tensor: string) => tensor.replace(/^layers\.\d+\./, '').replace(/experts\.\d+\./, 'experts.*.');

export function makeDeepSeekFlashPublishedWeightPreset(assets: AssetDocument[], v41: boolean) {
  const release = v41 ? 'v41' : 'v4', name = `DeepSeek-${v41 ? 'V4.1' : 'V4'}-Flash`;
  const checkpoint = v41 ? '314113f8a7dadb388215396ba5fbee2c610a04d6' : '60d8d70770c6776ff598c94bb586a859a38244f1';
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(new URL(`../references/models/deepseek-${release}/weight-manifest.json`, import.meta.url), 'utf8')));
  assert.equal(manifest.revision, checkpoint);
  const profile = v41 ? loadDeepSeekV41() : loadDeepSeekV4();
  const block = v41 ? 32 : 128, layers = v41 ? 40 : 43, indexLayers = v41 ? 8 : 21;
  assert.equal(profile.expertFormat, 'fp4');
  z.object({ quant_method: z.literal('fp8'), scale_fmt: z.literal('ue8m0'), activation_scheme: z.literal('dynamic'),
    weight_block_size: z.tuple([z.literal(block), z.literal(block)]),
  }).parse(profile.quantization);
  const dim = (key: string) => {
    const n = (profile.dimensions as Record<string, number>)[key];
    assert.ok(n, 'Missing dimension ' + key);
    return n;
  };
  const H = dim('H'), I = dim('I'), QR = dim('QR'), D = dim('D'), N = dim('N'), OG = dim('OG'), OR = dim('OR');
  const matrix = (checkpointId: string, storageId: string, rows: number, columns: number, out = 'w1', input = 'w0', format: 'fp4' | 'fp8' = 'fp8') =>
    ({ checkpointId, storageId: StorageId.parse(storageId), rows, columns, out, input, format });
  const attention = [matrix('attn.wq_a', 'qa-weight', QR, H), matrix('attn.wq_b', 'qb-weight', N * D, QR, 'w2'),
    matrix('attn.wkv', 'kv-weight', D, H), matrix('attn.wo_a', 'group-out-weight', OG * OR, N * D / OG, 'w2'),
    matrix('attn.wo_b', 'out-weight', H, OG * OR, 'w2', 'w1')];
  const indexer = matrix('attn.indexer.wq_b', 'index-q-weight', dim('IH') * dim('ID'), QR, 'w2');
  const shared = [matrix('ffn.shared_experts.w1', 'shared-gate-weight', I, H), matrix('ffn.shared_experts.w3', 'shared-up-weight', I, H),
    matrix('ffn.shared_experts.w2', 'shared-down-weight', H, I, 'w0', 'w1')];
  const routed = [matrix('ffn.experts.*.w1', 'routed-gate-weight', I, H, 'w2', 'w1', 'fp4'),
    matrix('ffn.experts.*.w3', 'routed-up-weight', I, H, 'w2', 'w1', 'fp4'),
    matrix('ffn.experts.*.w2', 'routed-down-weight', H, I, 'w1', 'w2', 'fp4')];
  const engram = v41 ? [matrix('engram.wkv', 'engram-proj-weight', H * (dim('HC') + 1), dim('EH') * (dim('EN') - 1) * dim('ED'))] : [];
  const ordinary = [...attention, ...shared], matrices = [...ordinary, ...routed, indexer, ...engram];
  assert.deepEqual(manifest.scalePairs, Object.fromEntries([
    ...ordinary.map(m => [m.checkpointId, layers]), ...routed.map(m => [m.checkpointId, layers * dim('E')]),
    [indexer.checkpointId, indexLayers], ...(v41 ? [['engram.wkv', 2], ['engram.embed', 2]] : []),
  ]));
  const samples = (name: string) => Object.entries(manifest.samples).filter(([key]) => sourceGroup(key) === name).map(([, shape]) => shape);
  for (const { checkpointId, rows, columns, format } of matrices) {
    const isFp4 = format === 'fp4';
    assert.deepEqual(samples(checkpointId + '.weight'), [[isFp4 ? 'I8' : 'F8_E4M3', rows, isFp4 ? columns / 2 : columns]], checkpointId);
    assert.deepEqual(samples(checkpointId + '.scale'), [['F8_E8M0', isFp4 ? rows : Math.ceil(rows / block),
      Math.ceil(columns / (isFp4 ? groupSize : block))]], checkpointId);
  }
  const unchanged = ['embed.weight', 'head.weight', 'norm.weight', 'attn.q_norm.weight', 'attn.kv_norm.weight',
    'attn_norm.weight', 'ffn_norm.weight', 'ffn.gate.weight', 'attn.compressor.wkv.weight', 'attn.compressor.wgate.weight', 'attn.compressor.norm.weight',
    ...(v41 ? ['attn.indexer.wk.weight', 'attn.indexer.k_norm.weight', 'engram.q_weight', 'engram.k_weight'] :
      ['attn.indexer.compressor.wkv.weight', 'attn.indexer.compressor.wgate.weight', 'attn.indexer.compressor.norm.weight']),
    'attn.indexer.weights_proj.weight'];
  for (const key of unchanged) {
    const values = samples(key);
    assert.ok(values.length && values.every(([dtype]) => dtype === 'BF16'), key);
  }
  if (v41) {
    assert.deepEqual(samples('engram.embed.weight'), ['ER1', 'ER14'].map(key => ['F8_E4M3', dim(key), dim('ED')]));
    assert.deepEqual(samples('engram.embed.scale'), ['ER1', 'ER14'].map(key => ['F8_E8M0', dim(key), dim('ED') / groupSize]));
  } else assert.deepEqual(samples('ffn.gate.tid2eid'), [['I64', dim('V'), dim('K')]]);

  const weight: QuantizedStorageSpec = { payloadBits: 8, payloadDtype: { category: 'float', bits: 8, format: 'fp8_e4m3fn' },
    packingUnitElements: 1, alignmentBytes: 1, auxiliaries: [{ name: 'scale', dtype: scaleDtype,
      count: { kind: 'block', axes: [{ axisId: 'out', blockSize: block }, { axisId: 'in', blockSize: block }] } }] };
  const fp4 = (axisId: string): QuantizedStorageSpec => ({ payloadBits: 4, payloadDtype: { category: 'float', bits: 4, format: 'fp4_e2m1' },
    packingUnitElements: 2, alignmentBytes: 1, auxiliaries: [{ name: 'scale', dtype: scaleDtype,
      count: { kind: 'block', axes: [{ axisId, blockSize: groupSize }] } }] });
  const model = assets.find(asset => asset.definition.kind === 'model' && asset.revision === 4);
  if (!model) throw Error('Missing fixed Flash decoder');
  const moduleRules = assets.flatMap(asset => {
    if (asset.definition.kind !== 'module' || !asset.definition.graph.nodes.some(node => node.nodeId === 'route-combine')) return [];
    const storages = new Set(asset.definition.graph.storages.map(row => row.storageId));
    return [{ module: ref(asset), targets: matrices.filter(m => storages.has(m.storageId)).map(m => m.format === 'fp4'
      ? { storageId: m.storageId, specification: fp4(m.input) }
      : { storageId: m.storageId, axes: { out: m.out, in: m.input } }) }];
  });
  const base = `https://huggingface.co/deepseek-ai/${name}/blob/${checkpoint}/`;
  return AssetDocument.parse({ documentType: 'asset', schemaVersion: 1, assetId: model.assetId.replace(':model:', ':quantization:') + '-published-weights',
    revision: 1, name: '官方 FP4／FP8 权重', parameters: [], tags: ['deepseek', 'fp4', 'fp8', 'published-weights'], sources: [
      ...['config.json', 'inference/model.py', 'model.safetensors.index.json', ...manifest.headers.map(row => row.shard)]
        .map(file => ({ kind: 'url', url: base + file, checkedOn: '2026-11-21' })),
      { kind: 'note', text: `Routed weights store two E2M1 values per byte with one E8M0 scale per 32 input channels. FP8 E4M3FN matrices use E8M0 scales per ${block} × ${block} tile. Head and group subdimensions line up with checked scale blocks. Engram table scales, cache and non-quantized weights use their declared storage. Execution continues to use the model's analytical arithmetic.` },
    ], definition: { kind: 'quantization', quantization: { selector: { kind: 'subtree', rootNodeId: '$model' }, weight },
      modelWeights: { model: ref(model), moduleRules },
    },
  });
}
