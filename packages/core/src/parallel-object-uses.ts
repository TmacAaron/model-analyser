import type { ResolvedGraph } from '@model-analyser/contracts';

export function parallelObjectUses(node: ResolvedGraph['graph']['nodes'][number], frame?: ResolvedGraph['objectBindings'][number]) {
  const tensors = [...node.portBindings.map(port => port.tensorId), ...frame?.tensors.map(tensor => tensor.tensorId) ?? []];
  const storages = frame?.storages.map(storage => storage.storageId) ?? [];
  const body = node.body;
  if (body.kind === 'opaque') {
    storages.push(...body.cost.memoryAccess.map(access => access.storageId), ...body.cost.temporaryStorageIds);
    const rule = body.localCost;
    if (rule) {
      const sources = [rule.participation, ...rule.bindings.map(binding => binding.source)];
      for (const source of sources) {
        if ('tensorId' in source) tensors.push(source.tensorId);
        if ('storageId' in source) storages.push(source.storageId);
      }
      storages.push(...rule.cost.memoryAccess.map(access => access.storageId), ...rule.cost.temporaryStorageIds);
    }
  }
  if (body.kind === 'collective') storages.push(...body.communication.temporaryStorageIds ?? []);
  return { tensors: [...new Set(tensors)], storages: [...new Set(storages)] };
}
