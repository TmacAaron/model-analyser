import { NodeId,type ResolvedGraph,type Scenario,type CommunicationDefinition } from '@model-analyser/contracts';
import { instantiateModel } from '@model-analyser/core';
export type CanvasNode={id:string;name:string;kind:'module'|'operator'|'communication'|'boundary';leafIds:string[];badges?:string[];communication?:CommunicationDefinition;repeatCount?:number;boundary?:'input'|'output'};
export type CanvasEdge={id:string;from:string;to:string;kind:'data'|'control'|'synchronization';tensorIds:string[]};
export type CanvasGraph={nodes:CanvasNode[];edges:CanvasEdge[]};
const within=(id:string,parent:string)=>parent==='$model'||id.startsWith(parent+'/')||id.startsWith(parent+'[');
/** Collapse only containment, then project real dependencies onto the visible children. */
export function projectCanvasGraph(resolved:ResolvedGraph,scope='$model',communications:Scenario['parallelPlan']['communications']=[],expandOperatorCalls=false):CanvasGraph{
  // A repeat is one navigation entry. Show its first actual invocation, never a wall of copies.
  const first=[...resolved.containers,...resolved.graph.nodes].find(c=>c.nodeId===scope+'[0]');
  if(first&&!expandOperatorCalls)return projectCanvasGraph(resolved,first.nodeId,communications);
  const containers=[...new Map(resolved.containers.filter(c=>c.nodeId!=='$model'&&!resolved.graph.nodes.some(n=>n.nodeId===c.nodeId)).map(c=>[c.nodeId,c])).values()],direct=containers.filter(c=>within(c.nodeId,scope)&&c.nodeId!==scope&&!containers.some(p=>p.nodeId!==scope&&p.nodeId!==c.nodeId&&within(p.nodeId,scope)&&within(c.nodeId,p.nodeId)));
  const nodes:CanvasNode[]=direct.map(c=>({id:c.nodeId,name:c.name,kind:'module',leafIds:[...c.leafNodeIds]}));
  for(const n of resolved.graph.nodes)if((n.nodeId===scope||within(n.nodeId,scope))&&!direct.some(c=>c.leafNodeIds.includes(n.nodeId)))nodes.push({id:n.nodeId,name:n.name,kind:n.body.kind==='collective'?'communication':'operator',leafIds:[n.nodeId],...(n.body.kind==='collective'?{communication:n.body.communication}:{})});
  const repeatCounts=new Map<string,Set<string>>();for(const c of [...resolved.containers,...resolved.graph.nodes]){const match=/^(.*)\[\d+\]$/.exec(c.nodeId);if(match){const ids=repeatCounts.get(match[1]!)??new Set<string>();ids.add(c.nodeId);repeatCounts.set(match[1]!,ids);}}for(const node of nodes){const count=repeatCounts.get(node.id)?.size;if(count)node.repeatCount=count;}
  const owner=new Map(nodes.flatMap(n=>n.leafIds.map(id=>[id,n.id] as const))),edges=new Map<string,CanvasEdge>();
  const add=(id:string,from:string,to:string,kind:CanvasEdge['kind'],tensorId?:string)=>{const a=owner.get(from),b=owner.get(to);if(!a||!b||a===b)return;const key=JSON.stringify([a,b,kind]),old=edges.get(key);if(old){if(tensorId&&!old.tensorIds.includes(tensorId))old.tensorIds.push(tensorId);}else edges.set(key,{id,from:a,to:b,kind,tensorIds:tensorId?[tensorId]:[]});};
  for(const e of resolved.graph.edges)if(e.from.kind==='node'&&e.to.kind==='node')add(e.edgeId,e.from.nodeId,e.to.nodeId,'data',e.tensorId);
  // Preserve actual tensors crossing this view, including the residual input that
  // bypasses normalization/attention. Boundary identity is the canonical tensor ID.
  const boundary=(direction:'input'|'output',tensorId:string)=>{const id='$'+direction+':'+tensorId;if(!nodes.some(n=>n.id===id)){const tensor=resolved.graph.tensors.find(t=>t.tensorId===tensorId);nodes.push({id,name:tensor?.name??tensorId,kind:'boundary',boundary:direction,leafIds:[]});}return id;};
  for(const e of resolved.graph.edges){const from=e.from.kind==='node'?owner.get(e.from.nodeId):undefined,to=e.to.kind==='node'?owner.get(e.to.nodeId):undefined;
    if(!from&&to){const id=boundary('input',e.tensorId);edges.set('$input:'+e.edgeId,{id:'$input:'+e.edgeId,from:id,to,kind:'data',tensorIds:[e.tensorId]});}
    if(from&&!to){const id=boundary('output',e.tensorId);edges.set('$output:'+e.edgeId,{id:'$output:'+e.edgeId,from,to:id,kind:'data',tensorIds:[e.tensorId]});}
  }
  for(const e of resolved.graph.dependencies)add(e.edgeId,e.fromNodeId,e.toNodeId,e.kind);
  for(const c of communications){const p=c.placement;if(!p||!p.phases.includes(resolved.phase)||nodes.some(n=>n.id===p.nodeId))continue;const targets=[...p.afterNodeIds,...p.beforeNodeIds],common=targets.length?resolved.containers.filter(container=>!resolved.graph.nodes.some(n=>n.nodeId===container.nodeId)&&targets.every(id=>id===container.nodeId||container.leafNodeIds.includes(id))).toSorted((a,b)=>b.nodeId.length-a.nodeId.length)[0]?.nodeId??'$model':'$model';if(common!==scope)continue;
    const names:Record<string,string>={all_reduce:'AllReduce',all_gather:'AllGather',reduce_scatter:'ReduceScatter',all_to_all:'AllToAll',send_recv:'SendRecv'};nodes.push({id:p.nodeId,name:(names[c.operation]??c.operation)+' · '+c.groupId,kind:'communication',leafIds:[],communication:c});
    for(const edge of resolved.graph.edges){if(edge.tensorId===c.source.tensorId&&edge.from.kind==='node'){const from=owner.get(edge.from.nodeId);if(from)edges.set('$plan-source:'+p.nodeId+':'+from,{id:'$plan-source:'+p.nodeId+':'+from,from,to:p.nodeId,kind:'data',tensorIds:[edge.tensorId]});}if(edge.tensorId===c.destination.tensorId&&edge.to.kind==='node'){const to=owner.get(edge.to.nodeId);if(to)edges.set('$plan-destination:'+p.nodeId+':'+to,{id:'$plan-destination:'+p.nodeId+':'+to,from:p.nodeId,to,kind:'data',tensorIds:[edge.tensorId]});}}
    for(const [i,id] of p.afterNodeIds.entries()){const from=owner.get(id)??nodes.find(n=>n.id===id)?.id;if(from)edges.set('$plan-after:'+p.nodeId+':'+i,{id:'$plan-after:'+p.nodeId+':'+i,from,to:p.nodeId,kind:'synchronization',tensorIds:[]});}
    for(const [i,id] of p.beforeNodeIds.entries()){const to=owner.get(id)??nodes.find(n=>n.id===id)?.id;if(to)edges.set('$plan-before:'+p.nodeId+':'+i,{id:'$plan-before:'+p.nodeId+':'+i,from:p.nodeId,to,kind:'synchronization',tensorIds:[]});}
  }
  return {nodes,edges:[...edges.values()]};
}
/** Bounded DAG layout; containment is never misrepresented as an execution edge. */
export function canvasLayout(graph:CanvasGraph):Record<string,{x:number;y:number}>{
  const ids=new Set(graph.nodes.map(n=>n.id)),degree=new Map(graph.nodes.map(n=>[n.id,0])),children=new Map<string,string[]>(),pending=new Map<string,number>(),rank=new Map<string,number>();
  for(const edge of graph.edges)if(ids.has(edge.from)&&ids.has(edge.to)){degree.set(edge.to,(degree.get(edge.to)??0)+1);const next=children.get(edge.from);if(next)next.push(edge.to);else children.set(edge.from,[edge.to]);}
  const ready=graph.nodes.filter(n=>degree.get(n.id)===0).map(n=>n.id);for(const id of ready)rank.set(id,0);
  for(let i=0;i<ready.length;i++){const id=ready[i];if(id===undefined)continue;for(const next of children.get(id)??[]){pending.set(next,Math.max(pending.get(next)??0,(rank.get(id)??0)+1));const left=(degree.get(next)??0)-1;degree.set(next,left);if(left===0){rank.set(next,pending.get(next)??0);ready.push(next);}}}
  const rows=new Map<number,number>();return Object.fromEntries(graph.nodes.map((n,i)=>{const column=rank.get(n.id)??i,row=rows.get(column)??0;rows.set(column,row+1);return [n.id,{x:60+row*260,y:70+column*150}];}));
}
export function canvasFusionCandidates(resolved:ResolvedGraph,scenario:Scenario,assets:Parameters<typeof instantiateModel>[1],selected:string[]=[]){
  const used=new Set(scenario.fusionGroups.flatMap(g=>g.memberNodeIds)),pairs=resolved.graph.edges.flatMap(e=>e.from.kind==='node'&&e.to.kind==='node'?[{from:e.from.nodeId,to:e.to.nodeId}]:[]),sets=selected.length>1?[selected]:pairs.map(p=>[p.from,p.to]),seen=new Set<string>();
  return sets.flatMap(ids=>{const ordered=resolved.graph.nodes.filter(n=>ids.includes(n.nodeId)).map(n=>n.nodeId),key=[...ordered].sort().join('\0');if(ordered.length<2||new Set(ids).size!==ordered.length||seen.has(key)||ordered.some(id=>used.has(id)))return [];seen.add(key);
    const group={groupId:'canvas-probe',memberNodeIds:ordered.map(id=>NodeId.parse(id)),eliminatedTensorIds:[],extraCost:{compute:[],memoryAccess:[],temporaryStorageIds:[],timing:{kind:'fixed' as const,seconds:0,description:'No additional work declared'}},timeStrategy:{kind:'sum_members' as const}},attempt=instantiateModel({...scenario,fusionGroups:[...scenario.fusionGroups,group]},assets);
    return attempt.status==='available'?[{nodeIds:ordered,names:ordered.map(id=>resolved.graph.nodes.find(n=>n.nodeId===id)?.name??id),description:'相邻依赖且通过现有融合约束；尚无实测加速保证'}]:[];
  }).slice(0,12);
}
