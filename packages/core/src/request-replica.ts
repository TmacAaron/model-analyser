import { AssetDocument, type Shape, type ValueExpr } from '@model-analyser/contracts';
import replicaPayload from '../../../assets/builtin/formula/parallel-replica-payload.json' with { type: 'json' };

export const replicaPayloadFormula = AssetDocument.parse(replicaPayload);
export const requestReplicaMeshAxis = '$request';

export function soleBatchAxis(shape: Shape) {
  const axes = shape.filter(axis => axis.semantic === 'batch');
  if (axes.length > 1) throw Error('DP 快捷预设不猜测多 batch 轴含义');
  return axes[0];
}

export function payloadPerReplica(payload: ValueExpr, replicas: number): ValueExpr {
  return { kind: 'formula', call: {
    formula: { assetId: replicaPayloadFormula.assetId, revision: replicaPayloadFormula.revision, kind: 'formula' },
    bindings: { bytes: payload, replicas: { kind: 'literal', quantity: { value: replicas, unit: 'count' } } },
  } };
}
