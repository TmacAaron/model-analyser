import type {AnalysisResult,CostResult,MetricScope,NodeId} from '@model-analyser/contracts';
import {FormulaError} from './formula.js';

export type FusionRow=NonNullable<AnalysisResult['fusions']>[number];
type NodeRow=AnalysisResult['nodes'][number];

export function modelCostInputs(nodes:NodeRow[],fusions:FusionRow[],absorbed:ReadonlySet<NodeId>){
 return [...nodes.filter(node=>!absorbed.has(node.nodeId)).map(node=>node.cost),...fusions.map(fusion=>fusion.cost)];
}

export function moduleCostInputs(leafNodeIds:NodeId[],nodeById:ReadonlyMap<NodeId,NodeRow>,fusions:FusionRow[]){
 const leaves=new Set(leafNodeIds);
 const contained=fusions.filter(fusion=>fusion.evaluation.application.memberNodeIds.every(id=>leaves.has(id)));
 const absorbed=new Set(contained.flatMap(fusion=>fusion.evaluation.application.memberNodeIds));
 const leafCosts=leafNodeIds.filter(id=>!absorbed.has(id)).map(id=>{
  const leaf=nodeById.get(id);
  if(!leaf)throw new FormulaError('missing_reference','模块缺少叶节点 '+id);
  return leaf.cost;
 });
 return {contained,costs:[...leafCosts,...contained.map(fusion=>fusion.cost)]};
}

type DecodeStep=NonNullable<AnalysisResult['decode']>['steps'][number];
export function stepCostInputs(steps:DecodeStep[],target:MetricScope['target']){
 return steps.flatMap(step=>{
  const {result}=step;
  let costs:CostResult[];
  if(target.kind==='model')costs=[result.total];
  else if(target.kind==='module')costs=result.modules.filter(module=>module.nodeId===target.nodeId).map(module=>module.cost);
  else costs=[...result.nodes.filter(node=>node.nodeId===target.nodeId).map(node=>node.cost),...(result.fusions??[]).filter(fusion=>fusion.evaluation.application.nodeId===target.nodeId).map(fusion=>fusion.cost)];
  return costs.map(cost=>({cost,step}));
 });
}
