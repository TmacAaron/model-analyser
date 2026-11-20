import type {CostResult,MetricScope,NodeId,ParallelResolution,SingleStepAnalysisResult} from '@model-analyser/contracts';

export type LogicalWorkRow={scope:MetricScope;compute:CostResult['compute']};
type Fusion=ParallelResolution['fusions'][number];

export function logicalWorkMembers(byNode:ReadonlyMap<NodeId,CostResult['compute']>,fusions:readonly Fusion[],leafIds:Iterable<NodeId>=byNode.keys()){
 return [
  ...Array.from(leafIds,nodeId=>({kind:'leaf' as const,nodeId,compute:byNode.get(nodeId)??[]})),
  ...fusions.map(({application,logicalExtraCompute})=>({kind:'extra' as const,nodeId:application.extraNodeId,fusionNodeId:application.nodeId,compute:logicalExtraCompute})),
 ];
}

type Frame=Pick<SingleStepAnalysisResult,'distributed'|'nodes'|'modules'|'total'>;
export function logicalWorkRows(frame:Frame):LogicalWorkRow[]{
 return frame.distributed?.logicalCompute??[...frame.nodes.map(n=>n.cost),...frame.modules.map(m=>m.cost),frame.total].map(c=>({
  scope:{...c.scope,aggregation:'model_useful'},compute:c.compute,
 }));
}

export function logicalFusionExtraRows(frame:Pick<SingleStepAnalysisResult,'fusions'|'distributed'>){
 const scopeById=new Map(frame.distributed?.logicalCompute.flatMap(row=>row.scope.target.kind==='node'?[[row.scope.target.nodeId,row.scope] as const]:[]));
 return (frame.fusions??[]).flatMap(({evaluation})=>{
  const {nodeId,extraNodeId}=evaluation.application,scope=scopeById.get(nodeId);
  return scope?[{fusionNodeId:nodeId,row:{scope:{...scope,target:{kind:'node' as const,nodeId:extraNodeId}},compute:evaluation.logicalExtraCompute}}]:[];
 });
}
