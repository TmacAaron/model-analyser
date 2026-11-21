import { AssetDocument, StorageId, type QuantizedStorageSpec } from '@model-analyser/contracts';
import { z } from 'zod';
import { loadKimiK3 } from './kimi-k3-profile.js';
import { ref } from './model-authoring.js';

const release = 'https://huggingface.co/moonshotai/Kimi-K3/blob/1f5d44f794ef598de7b6f529ef7923729b7e5408/';
const compression = 'mxfp4-pack-quantized';
const groupSize = 32;

export function makeKimiK3MXFP4WeightPreset(assets: AssetDocument[]) {
  const { quantization } = loadKimiK3();
  z.object({
    quant_method: z.literal('compressed-tensors'), format: z.literal(compression),
    config_groups: z.object({ group_0: z.object({
      format: z.literal(compression),
      weights: z.object({ num_bits: z.literal(4), group_size: z.literal(groupSize), strategy: z.literal('group'),
        scale_dtype: z.literal('torch.uint8'), symmetric: z.literal(true), type: z.literal('float') }),
    }) }),
  }).parse(quantization);

  const asset = (id: string, kind: 'model' | 'module') => {
    const value = assets.find(entry => entry.assetId === `builtin:${kind}:kimi-k3${id}` && entry.revision === 3 && entry.definition.kind === kind);
    if (!value) throw Error('Missing fixed Kimi-K3 asset ' + id);
    return ref(value);
  };
  const weight: QuantizedStorageSpec = {
    payloadBits: 4, payloadDtype: { category: 'float', bits: 4, format: 'fp4_e2m1' },
    packingUnitElements: 2, alignmentBytes: 1,
    auxiliaries: [{ name: 'weight_scale', dtype: { category: 'float', bits: 8, format: 'e8m0' },
      count: { kind: 'block', axes: [{ axisId: 'in', blockSize: groupSize }] } }],
  };
  // The graph records [experts, input, output] for all three projections.
  const targets = ['gate', 'up', 'down'].map(projection => ({
    storageId: StorageId.parse(`expert-${projection}-weight`), axes: { in: 'w1' },
  }));
  return AssetDocument.parse({
    documentType: 'asset', schemaVersion: 1, assetId: 'builtin:quantization:kimi-k3-mxfp4-weights', revision: 1,
    name: '官方 MXFP4 权重', parameters: [], tags: ['kimi-k3', 'mxfp4', 'published-weights'], sources: [
      ...[release + 'config.json', release + 'modeling_kimi_linear.py',
        'https://github.com/NVIDIA/Model-Optimizer/tree/main/examples/kimi']
        .map(url => ({ kind: 'url', url, checkedOn: '2026-11-21' })),
      { kind: 'note', text: 'Routed expert w1, w2 and w3 store two E2M1 values per byte with one E8M0 scale per 32 input channels. The preset covers text weight residency and sparse reads. Matrix execution, KV and other state follow the reference graph.' },
    ],
    definition: { kind: 'quantization', quantization: { selector: { kind: 'subtree', rootNodeId: '$model' }, weight },
      modelWeights: { model: asset('', 'model'), moduleRules: ['boundary', 'kda', 'mla'].map(layer => ({
        module: asset('-layer-' + layer, 'module'), targets,
      })) },
    },
  });
}
