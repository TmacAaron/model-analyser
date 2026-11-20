import type {ResolvedGraph,Scenario} from '@model-analyser/contracts';
import {canvasLayout,projectCanvasGraph,type CanvasGraph} from './canvas-graph.js';
import type {CanvasPositions} from './canvas-scene.js';

export type CanvasView={scope:string;expandOperatorCalls:boolean};
export type CanvasProjection={view:CanvasView;graph:CanvasGraph;defaultPositions:CanvasPositions};

export function projectCanvasView(resolved:ResolvedGraph,scenario:Scenario,view:CanvasView):CanvasProjection{
  const graph=projectCanvasGraph(resolved,view.scope,scenario.parallelPlan.communications,view.expandOperatorCalls);
  const quantized=new Set<string>(resolved.quantizationApplications.flatMap(item=>item.nodeIds));
  const fused=new Set<string>(resolved.fusionApplications.flatMap(item=>item.memberNodeIds));
  const budgets=new Set<string>(scenario.modulePeakOverrides?.flatMap(rule=>rule.phases.includes(scenario.workload.kind)?
    resolved.containers.find(c=>c.nodeId===rule.nodeId)?.leafNodeIds??[]:[])??[]);
  const parallelTargets=scenario.parallelPlan.assignments.flatMap(assignment=>{
    if(!assignment.phases.includes(scenario.workload.kind))return [];
    return assignment.selector.kind==='nodes'?assignment.selector.nodeIds:[assignment.selector.rootNodeId];
  });
  graph.nodes=graph.nodes.map(node=>({...node,badges:[
    ...(node.leafIds.some(id=>quantized.has(id))?['量化已应用']:[]),
    ...(node.leafIds.some(id=>fused.has(id))?['融合已应用']:[]),
    ...(parallelTargets.some(target=>target==='$model'||target===node.id||node.leafIds.some(id=>id===target||id.startsWith(target+'/')))?['并行布局']:[]),
    ...(node.leafIds.some(id=>budgets.has(id))?['显存预算']:[]),
  ]}));
  return {view,graph,defaultPositions:canvasLayout(graph)};
}
