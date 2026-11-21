import { LocalCostRule, TensorId, type GraphTemplate, type ValueExpr } from '@model-analyser/contracts';
import { symbol } from './model-authoring.js';

export type AxisBinding = [parameter: string, tensorId: string, axisId: string];

/** Generate explicit local equations from authored operand axes, preserving the global equations. */
export function withLocalCost(graph: GraphTemplate, nodeAxes: Readonly<Record<string, AxisBinding[]>>, description: string,
  logicalAccesses?: Readonly<Record<string, readonly string[]>>): GraphTemplate {
  const tensors = new Map(graph.tensors.map(tensor => [tensor.tensorId, tensor]));
  return { ...graph, nodes: graph.nodes.map(node => {
    if (node.body.kind !== 'opaque') return node;
    const body = node.body;
    const input = body.inputs[0] ?? body.outputs[0];
    const batch = input && tensors.get(input.tensorId)?.shape.find(axis => axis.semantic === 'batch');
    if (!input || !batch && body.inputs.length) throw Error('Missing batch port for ' + node.nodeId);
    const axes: AxisBinding[] = [...(batch ? [['B', input.tensorId, batch.axisId] as AxisBinding] : []), ...(nodeAxes[node.nodeId] ?? [])];
    const axisBindings = (basis: 'logical' | 'allocated') => axes.map(([parameter, tensorId, axisId]) => ({
      parameter,
      symbol: basis + '_' + parameter,
      source: { kind: 'tensor_axis' as const, tensorId: TensorId.parse(tensorId), axisId, basis },
    }));
    const logical = axisBindings('logical'), allocated = axisBindings('allocated');
    const replace = (value: ValueExpr, bindings: ReturnType<typeof axisBindings>): ValueExpr => {
      if (value.kind === 'literal') return value;
      if (value.kind === 'symbol') {
        const binding = bindings.find(item => item.parameter === value.name);
        return binding ? symbol(binding.symbol) : value;
      }
      return { ...value, call: { ...value.call, bindings: Object.fromEntries(
        Object.entries(value.call.bindings).map(([key, operand]) => [key, replace(operand, bindings)]),
      ) } };
    };
    const localCost = LocalCostRule.parse({
      participation: { kind: 'tensor_layout', tensorId: input.tensorId },
      bindings: [...logical, ...allocated].map(({ symbol, source }) => ({ symbol, source })),
      cost: {
        ...body.cost,
        compute: body.cost.compute.map(segment => ({
          ...segment,
          usefulOperations: replace(segment.usefulOperations, logical),
          executedOperations: replace(segment.executedOperations, allocated),
        })),
        memoryAccess: body.cost.memoryAccess.map(access => {
          const bindings = logicalAccesses?.[node.nodeId]?.includes(access.accessId) ? logical : allocated;
          const value = access.logicalBytes;
          return { ...access, logicalBytes: value.kind === 'storage_allocation'
            ? { ...value, passes: replace(value.passes, bindings) } : replace(value, bindings) };
        }),
      },
      description,
    });
    return { ...node, body: { ...body, localCost } };
  }) };
}
