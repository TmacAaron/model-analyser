import type { AssetDocument, ResolvedGraph } from '@model-analyser/contracts';
import { z } from 'zod';

const Limit = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fixed'), tokens: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('parameter'), parameterKey: z.string().min(1) }),
]);
type Limit = z.infer<typeof Limit>;
type Declaration = { limit: Limit; source: 'declared' | 'config_mapping' | 'published'; url?: string };

// Older portable snapshots already cite these exact configs. Register their
// length declarations independently of graph execution and tensor dimensions.
const published = new Map<string, { url: string; untilRevision: number; limit: Limit }>([
  ['builtin:model:deepseek-v3', { untilRevision: 5, limit: { kind: 'parameter', parameterKey: 'M' },
    url: 'https://huggingface.co/deepseek-ai/DeepSeek-V3/resolve/bd0dd75c911b4a171ae9b1e0a71f7ae45641cf65/config.json' }],
  ['builtin:model:deepseek-r1', { untilRevision: 5, limit: { kind: 'parameter', parameterKey: 'M' },
    url: 'https://huggingface.co/deepseek-ai/DeepSeek-R1/resolve/00c6b9d6b8308971df69134e7b421ab7a7fe6f66/config.json' }],
  ['builtin:model:deepseek-v4-flash', { untilRevision: 4, limit: { kind: 'fixed', tokens: 1_048_576 },
    url: 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/blob/60d8d70770c6776ff598c94bb586a859a38244f1/config.json' }],
  ['builtin:model:deepseek-v4.1-flash', { untilRevision: 4, limit: { kind: 'parameter', parameterKey: 'M' },
    url: 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/314113f8a7dadb388215396ba5fbee2c610a04d6/config.json' }],
  ['builtin:model:glm-5.2', { untilRevision: 2, limit: { kind: 'fixed', tokens: 1_048_576 },
    url: 'https://huggingface.co/zai-org/GLM-5.2/blob/cf457fa734ab149ffef225f80893eb38c6ff5cdc/config.json' }],
  ['builtin:model:kimi-k3', { untilRevision: 3, limit: { kind: 'fixed', tokens: 1_048_576 },
    url: 'https://huggingface.co/moonshotai/Kimi-K3/blob/1f5d44f794ef598de7b6f529ef7923729b7e5408/config.json' }],
  ['builtin:model:qwen3.5-397b-a17b', { untilRevision: 5, limit: { kind: 'parameter', parameterKey: 'M' },
    url: 'https://huggingface.co/Qwen/Qwen3.5-397B-A17B/resolve/6fe6a3a85cefe43a807df708dccc4e44b02e2955/config.json' }],
  ['builtin:model:qwen3.8-27b', { untilRevision: 5, limit: { kind: 'parameter', parameterKey: 'M' },
    url: 'https://huggingface.co/Qwen/Qwen3.8-27B/resolve/72a217afab8029b39e4af1c7273a829995a3dbaf/config.json' }],
]);

const lengthFields = new Set(['/max_position_embeddings', '/text_config/max_position_embeddings', '/seq_length']);

export function modelContextLimitDeclaration(model: AssetDocument | undefined): Declaration | undefined {
  if (model?.definition.kind !== 'model') return;
  if (model.extensions?.['contextLimit'] !== undefined) {
    const explicit = Limit.safeParse(model.extensions['contextLimit']);
    return explicit.success ? { limit: explicit.data, source: 'declared' } : undefined;
  }
  const mapping = model.configMapping?.parameters.filter(row => lengthFields.has(row.field) && !row.offset);
  const keys = new Set(mapping?.map(row => row.parameterKey));
  const [parameterKey] = keys;
  if (keys.size === 1 && parameterKey) return { limit: { kind: 'parameter', parameterKey }, source: 'config_mapping' };
  const reference = published.get(model.assetId);
  if (reference && model.revision <= reference.untilRevision && model.sources.some(source => source.kind === 'url' && source.url === reference.url)) {
    return { limit: reference.limit, source: 'published', url: reference.url };
  }
}

export function resolveModelContextLimit(declaration: Declaration | undefined, parameters: ResolvedGraph['parameters']) {
  if (!declaration) return;
  const { limit, source, url } = declaration;
  if (limit.kind === 'fixed') return { tokensPerRequest: limit.tokens, source, ...(url ? { url } : {}) };
  const row = parameters.find(parameter => parameter.nodeId === '$model' && parameter.parameterKey === limit.parameterKey);
  if (row?.unit !== 'count' || row.value.kind !== 'integer' || !Number.isSafeInteger(row.value.value) || row.value.value < 1) return;
  return { tokensPerRequest: row.value.value, source, parameterKey: limit.parameterKey, ...(url ? { url } : {}) };
}
