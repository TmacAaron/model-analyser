import { type GraphTemplate,type NodeId } from '@model-analyser/contracts';
import { FormulaError } from './formula.js';
export function topologicalOrder(graph:GraphTemplate):NodeId[]{
  const dependencies=[...graph.edges.flatMap(e=>e.from.kind==='node'&&e.to.kind==='node'?[{fromNodeId:e.from.nodeId,toNodeId:e.to.nodeId}]:[]),...graph.dependencies];return orderDependencies(graph.nodes.map(n=>n.nodeId),dependencies);
}
export function orderDependencies(nodeIds:NodeId[],dependencies:{fromNodeId:NodeId;toNodeId:NodeId}[]):NodeId[]{
  const degree=new Map<NodeId,number>(nodeIds.map(id=>[id,0])),next=new Map<NodeId,Set<NodeId>>();
  if(degree.size!==nodeIds.length)throw new FormulaError('duplicate_id','节点 ID 重复');
  function edge(from:NodeId,to:NodeId){if(!degree.has(from)||!degree.has(to))throw new FormulaError('missing_reference','依赖引用缺失节点');const targets=next.get(from)??new Set<NodeId>();if(!targets.has(to)){degree.set(to,(degree.get(to)??0)+1);targets.add(to);next.set(from,targets);}}
  for(const dependency of dependencies)edge(dependency.fromNodeId,dependency.toNodeId);
  const ready=nodeIds.filter(id=>degree.get(id)===0),result:NodeId[]=[];
  for(let cursor=0;cursor<ready.length;cursor++){const id=ready[cursor];if(!id)throw new FormulaError('invalid_graph','就绪队列损坏');result.push(id);for(const target of next.get(id)??[]){const value=(degree.get(target)??0)-1;degree.set(target,value);if(value===0)ready.push(target);}}
  if(result.length!==nodeIds.length)throw new FormulaError('dependency_cycle','单步数据/控制依赖存在环');return result;
}
