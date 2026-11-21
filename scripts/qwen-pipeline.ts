import { AssetDocument, ParallelPresetTemplate } from '@model-analyser/contracts';
import { bf16 } from './model-authoring.js';

export function addQwenPipelinePreset(model: AssetDocument) {
  if (model.definition.kind !== 'model') throw Error('Expected a Qwen model');
  const chain = model.definition.graph.nodes.find(node => node.nodeId === 'decoder');
  const embedding = model.definition.graph.nodes.find(node => node.nodeId === 'embedding');
  const payload = embedding?.body.kind === 'opaque' && embedding.body.cost.memoryAccess.find(access =>
    access.storageId === 'embedding' || access.storageId === 'embedding-weight')?.logicalBytes;
  if (chain?.repeat?.wiring !== 'chain' || !payload || payload.kind === 'storage_allocation') throw Error('Missing Qwen pipeline boundary declaration');
  const pipeline = ParallelPresetTemplate.parse({
    presetId: 'pp-decoder', name: '解码层流水线', description: '连续解码层分到各卡，阶段间传输激活。',
    strategy: 'pipeline', phases: ['prefill', 'decode'], tensorShards: [], reductions: [],
    networkDefaults: { scope: 'inter_group', bytesPerSecond: 100e9, latencySeconds: 3e-6, description: 'Editable reference link for stage transfers.' },
    pipeline: { chainNodeId: chain.nodeId, payloadBytes: payload, payloadDtype: bf16 },
    assumptions: ['Each stage owns its layer weights and state. Tied weights used on multiple stages are locally replicated on those stages. A single microbatch traverses all stages in order.'],
  });
  return AssetDocument.parse({ ...model, revision: model.revision + 1,
    parallelPresets: [...model.parallelPresets?.map(preset => preset.presetId === 'tp-attention-heads' ?
      { ...preset, sharedPoolDegrees: ['attentionTp'] } : preset) ?? [], pipeline],
  });
}

export function addQwenPipelineRequestParallel(model: AssetDocument) {
  return AssetDocument.parse({ ...model, revision: model.revision + 1,
    parallelPresets: model.parallelPresets?.map(preset => preset.strategy === 'pipeline' ? {
      ...preset, requestBatchSharding: true,
      assumptions: [...preset.assumptions, 'Each independent request group has its own pipeline. Stage transfers use only the local batch slice.'],
    } : preset),
  });
}
