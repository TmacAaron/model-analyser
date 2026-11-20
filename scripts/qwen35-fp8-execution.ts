import { AssetDocument, type GraphTemplate, type ModelWeightExecution, type ValueExpr } from '@model-analyser/contracts';
import { Equations, fp8, fp8Matrix, fp32, literal, symbol, vector } from './model-authoring.js';

const groupSize = 128;
const sources: AssetDocument['sources'] = [
  { kind: 'url', url: 'https://docs.vllm.ai/en/v0.15.0/api/vllm/model_executor/layers/quantization/utils/quant_utils/#vllm.model_executor.layers.quantization.utils.quant_utils.kDynamic128Scale', checkedOn: '2026-11-21' },
  { kind: 'note', text: 'Estimate a fused projection with one dynamic FP32 activation scale per row and per 128 contraction features, E4M3FN operands, and FP32 accumulators. The conversion work proxy is six operations per input element and one per scale group. The output work proxy is three operations per output element and contraction chunk, covering the two scales, partial sum and final output conversion. Working tiles and scales reside on chip. Graph outputs, collectives and cached state keep their declared formats.' },
];
type Tensor = GraphTemplate['tensors'][number];
type Stage = ModelWeightExecution['stages'][number];
type Bindings = ModelWeightExecution['local']['bindings'];

export function makeQwen35FP8ExecutionAssets(assets: AssetDocument[], weightPreset: AssetDocument): AssetDocument[] {
  const definition = weightPreset.definition;
  if (definition.kind !== 'quantization' || !definition.modelWeights || !definition.quantization.weight) throw Error('Missing Qwen FP8 weight profile');
  const profile = definition.modelWeights, weight = definition.quantization.weight;
  const evidence = [...weightPreset.sources.filter(source => source.kind === 'url'), ...sources];
  const dimensions = ['A0', 'A1', 'A2', 'A3', 'A4'];
  const equations = new Equations('builtin:formula:qwen35-fp8-execution',
    ['N', 'F', 'O', 'Block', ...dimensions].map(key => ({ key, name: key, type: 'integer', unit: 'count', min: key === 'Block' ? 1 : 0 })), evidence);
  function formula(expression: string, unit: 'count' | 'operation', bindings: Record<string, ValueExpr>): ValueExpr {
    const template = equations.value(expression, unit);
    if (template.kind !== 'formula') throw Error('Expected FP8 equation ' + expression);
    return { ...template, call: { ...template.call, bindings } };
  }
  function combine(parts: ValueExpr[], operator: ' + ' | ' * '): ValueExpr {
    const [first] = parts;
    if (!first || parts.length > dimensions.length) throw Error('Unexpected number of tensor operands');
    const keys = dimensions.slice(0, parts.length);
    return parts.length === 1 ? first : formula(keys.join(operator), 'count', Object.fromEntries(parts.map((part, index) => ['A' + index, part])));
  }
  function stages(N: ValueExpr, F: ValueExpr, O: ValueExpr): Stage[] {
    const Block = literal(groupSize);
    return [{ segmentId: 'dynamic-fp8-activation', placement: 'before_matrix', computeClass: vector,
      usefulOperations: literal(0, 'operation'), executedOperations: formula('if(F > 0, 6 * N + (N / F) * ceil(F / Block), 0)', 'operation', { N, F, Block }) },
    { segmentId: 'fp8-block-scale-and-accumulate', placement: 'after_matrix', computeClass: vector,
      usefulOperations: literal(0, 'operation'), executedOperations: formula('3 * O * ceil(F / Block)', 'operation', { O, F, Block }) }];
  }

  const moduleRules = profile.moduleRules.map(section => {
    const module = assets.find(asset => asset.assetId === section.module.assetId && asset.revision === section.module.revision);
    if (module?.definition.kind !== 'module') throw Error('Missing quantized module ' + section.module.assetId);
    const graph = module.definition.graph;
    const tensors = new Map(graph.tensors.map(tensor => [tensor.tensorId, tensor]));
    const storages = new Map(graph.storages.map(storage => [storage.storageId, storage]));
    const eligible = new Set(section.targets.filter(target => (target.specification ?? weight).payloadDtype?.format === fp8.format).map(target => target.storageId));
    const execution = graph.nodes.flatMap((node): ModelWeightExecution[] => {
      if (node.body.kind !== 'opaque') return [];
      const { body } = node;
      const weights = body.cost.memoryAccess.filter(access => access.mode === 'read' && storages.get(access.storageId)?.category === 'weight').map(access => access.storageId);
      if (!weights.some(id => eligible.has(id))) return [];
      if (weights.some(id => !eligible.has(id)) || body.cost.compute.length !== 1) throw Error('Expected one fully quantized matrix at ' + node.nodeId);
      const matrix = body.cost.compute[0];
      const input = body.inputs[0] && tensors.get(body.inputs[0].tensorId);
      if (matrix?.computeClass.resource !== 'matrix' || input?.dtype.format !== 'bf16') throw Error('Missing BF16 input or matrix for ' + node.nodeId);
      const outputs = body.outputs.map(port => {
        const output = tensors.get(port.tensorId);
        if (!output) throw Error('Missing output ' + port.tensorId);
        return output;
      });
      const flattenHead = node.nodeId === 'o-proj' || node.nodeId === 'delta-o-proj';
      const features = input.shape.slice(flattenHead ? -2 : -1);
      if (features.length !== (flattenHead ? 2 : 1) || features.at(-1)?.semantic !== 'hidden') throw Error('Missing contraction axis for ' + node.nodeId);
      const elements = (tensor: Tensor) => combine(tensor.shape.map(axis => axis.size), ' * ');
      const bindings: Bindings = [];
      const bind = (name: string, source: Bindings[number]['source']) => {
        bindings.push({ symbol: name, source });
        return symbol(name);
      };
      const allocated = (name: string, tensor: Tensor) => bind(name, { kind: 'tensor_elements', tensorId: tensor.tensorId, basis: 'allocated' });
      const localInput = allocated('Fp8InputElements', input);
      const localWidth = combine(features.map(({ axisId }, index) => bind('Fp8Feature' + index,
        { kind: 'tensor_axis', tensorId: input.tensorId, axisId, basis: 'allocated' })), ' * ');
      const localOutput = combine(outputs.map((tensor, index) => allocated('Fp8Output' + index, tensor)), ' + ');
      return [{ nodeId: node.nodeId, weights, activation: { tensorId: input.tensorId, groupSize, scaleDtype: fp32 },
        matrix: { segmentId: matrix.segmentId, computeClass: fp8Matrix },
        stages: stages(elements(input), combine(features.map(axis => axis.size), ' * '), combine(outputs.map(elements), ' + ')),
        local: { bindings, stages: stages(localInput, localWidth, localOutput) } }];
    });
    const covered = new Set(execution.flatMap(rule => rule.weights));
    if (covered.size !== eligible.size || [...eligible].some(id => !covered.has(id))) throw Error('Missing FP8 execution recipe in ' + section.module.assetId);
    return { ...section, execution };
  });
  const preset = AssetDocument.parse({ ...weightPreset, assetId: 'builtin:quantization:qwen3.5-397b-a17b-fp8-execution', name: 'FP8 执行',
    tags: ['qwen', 'fp8', 'block128', 'dynamic-activation'], sources: evidence,
    definition: { ...definition, modelWeights: { ...profile, moduleRules } } });
  return [preset, ...equations.assets];
}
