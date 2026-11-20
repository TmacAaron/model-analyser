import type {ResolvedGraph} from '@model-analyser/contracts';
import {topologicalOrder} from '@model-analyser/core';
/** One adjacency pass; node inspection and pagination reuse the same fixed graph index. */
export function structurePictureIndex(resolved:ResolvedGraph){
 const ordered=topologicalOrder(resolved.graph),ranks=new Map<string,number>(),byId=new Map<string,ResolvedGraph['graph']['nodes'][number]>(resolved.graph.nodes.map(n=>[n.nodeId,n]));
 const links=[...resolved.graph.edges.flatMap(e=>e.from.kind==='node'&&e.to.kind==='node'?[{from:e.from.nodeId,to:e.to.nodeId,control:false}]:[]),...resolved.graph.dependencies.map(e=>({from:e.fromNodeId,to:e.toNodeId,control:true}))],incoming=new Map<string,string[]>();
 for(const edge of links){const parents=incoming.get(edge.to)??[];parents.push(edge.from);incoming.set(edge.to,parents);}
 for(const id of ordered){let rank=0;for(const parent of incoming.get(id)??[])rank=Math.max(rank,(ranks.get(parent)??0)+1);ranks.set(id,rank);}
 return {ordered,ranks,byId,links};
}
