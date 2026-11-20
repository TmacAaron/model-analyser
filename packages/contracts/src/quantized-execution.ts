import type { CostDefinition,GraphTemplate,ModelWeightExecution } from './index.js';

type Leaf = Extract<GraphTemplate['nodes'][number]['body'],{kind:'opaque'}>;

/** Apply declared compute stages to the same mathematical node and physical ports. */
export function quantizedExecutionBody(body:Leaf,execution:ModelWeightExecution):Leaf {
  const local=body.localCost;
  if(!local)throw Error('量化执行节点需要逐卡成本规则');
  function update(cost:CostDefinition,stages:ModelWeightExecution['stages']):CostDefinition {
    const segment=cost.compute.find(value=>value.segmentId===execution.matrix.segmentId);
    if(segment?.computeClass.resource!=='matrix'||execution.matrix.computeClass.resource!=='matrix')throw Error('量化执行须指向矩阵计算段');
    if(new Set([...cost.compute,...stages].map(value=>value.segmentId)).size!==cost.compute.length+stages.length)throw Error('量化执行阶段名称重复');
    const steps=(position:ModelWeightExecution['stages'][number]['placement'])=>stages.flatMap(({placement,...stage})=>placement===position?[stage]:[]);
    return {...cost,compute:cost.compute.flatMap(value=>value.segmentId===execution.matrix.segmentId?
      [...steps('before_matrix'),{...value,computeClass:execution.matrix.computeClass},...steps('after_matrix')]:[value])};
  }
  const bindings=[...local.bindings,...execution.local.bindings];
  if(new Set(bindings.map(binding=>binding.symbol)).size!==bindings.length)throw Error('量化执行局部参数重复');
  return {...body,cost:update(body.cost,execution.stages),localCost:{...local,bindings,cost:update(local.cost,execution.local.stages)}};
}
