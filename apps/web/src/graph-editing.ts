import { z } from 'zod';
import { AssetDocument,GraphTemplate,ParameterDef,type AssetRef,type ValueExpr } from '@model-analyser/contracts';
import { collectivePorts } from '../../../packages/contracts/src/collective.js';

export type GraphNode=GraphTemplate['nodes'][number];
export type GraphAsset=AssetDocument&{definition:Extract<AssetDocument['definition'],{kind:'model'|'module'}>};
// Only the edit buffer relaxes labels. Empty labels remain drafts under the authoritative contract.
const editableParameters=z.array(z.discriminatedUnion('type',[
  ParameterDef.options[0].extend({key:z.string(),name:z.string()}),ParameterDef.options[1].extend({key:z.string(),name:z.string()}),
  ParameterDef.options[2].extend({key:z.string(),name:z.string()}),ParameterDef.options[3].extend({key:z.string(),name:z.string()}),
]));
const editableGraph=GraphTemplate.extend({nodes:z.array(GraphTemplate.shape.nodes.element.extend({name:z.string()}))});
const editableAsset=AssetDocument.extend({name:z.string(),parameters:editableParameters,definition:z.discriminatedUnion('kind',[
  AssetDocument.shape.definition.options[0].extend({family:z.string(),variant:z.string(),graph:editableGraph}),
  AssetDocument.shape.definition.options[1].extend({graph:editableGraph}),
])});
export function graphEditorAsset(text:string):GraphAsset|undefined {
  try{const value:unknown=JSON.parse(text);if(value&&typeof value==='object'&&'definition' in value){const d=value.definition;if(d&&typeof d==='object'&&'graph' in d){const g=d.graph;if(g&&typeof g==='object'&&!('nodes' in g)){const parsed=editableAsset.safeParse({...value,definition:{...d,graph:{...g,nodes:[]}}});return parsed.success?parsed.data:undefined;}}}const parsed=editableAsset.safeParse(value);return parsed.success?parsed.data:undefined;}catch{return undefined;}
}
export function replaceGraph(asset:GraphAsset,graph:GraphTemplate):GraphAsset{return {...asset,definition:{...asset.definition,graph}};}
export function nextGraphId(prefix:string,used:Iterable<string>):string{const ids=new Set(used);let n=1;while(ids.has(prefix+'_'+n))n++;return prefix+'_'+n;}
export function moveNode(graph:GraphTemplate,id:string,delta:-1|1):GraphTemplate {const nodes=[...graph.nodes],i=nodes.findIndex(n=>n.nodeId===id),j=i+delta;if(i<0||j<0||j>=nodes.length)return graph;const item=nodes[i],other=nodes[j];if(!item||!other)return graph;nodes[i]=other;nodes[j]=item;return {...graph,nodes};}
export function removeNode(graph:GraphTemplate,id:string):GraphTemplate {
  return {...graph,nodes:graph.nodes.filter(n=>n.nodeId!==id).map(n=>n.body.kind==='collective'&&n.body.communication.placement?{...n,body:{...n.body,communication:{...n.body.communication,placement:{...n.body.communication.placement,afterNodeIds:n.body.communication.placement.afterNodeIds.filter(v=>v!==id),beforeNodeIds:n.body.communication.placement.beforeNodeIds.filter(v=>v!==id)}}}}:n),
    edges:graph.edges.filter(e=>!(e.from.kind==='node'&&e.from.nodeId===id)&&!(e.to.kind==='node'&&e.to.nodeId===id)),dependencies:graph.dependencies.filter(e=>e.fromNodeId!==id&&e.toNodeId!==id),
    // A state creator cannot be silently replaced by initialized. Keep that unresolved reference as a draft diagnostic.
    states:graph.states.map(s=>({...s,readers:s.readers.filter(p=>p.nodeId!==id),writers:s.writers.filter(p=>p.nodeId!==id)}))};
}
export function nodeRemovalSummary(graph:GraphTemplate,id:string){return {data:graph.edges.filter(e=>e.from.kind==='node'&&e.from.nodeId===id||e.to.kind==='node'&&e.to.nodeId===id).length,control:graph.dependencies.filter(e=>e.fromNodeId===id||e.toNodeId===id).length,creators:graph.states.filter(s=>s.creator.kind==='node'&&s.creator.nodeId===id).map(s=>s.stateId)};}
export function nodePorts(node:GraphNode,library:AssetDocument[]):{inputs:GraphTemplate['inputs'];outputs:GraphTemplate['outputs']} {
  if(node.body.kind==='opaque')return node.body;
  if(node.body.kind==='collective')return collectivePorts(node.body.communication);
  const body=node.body,target=library.find(a=>a.assetId===body.asset.assetId&&a.revision===body.asset.revision);
  if(target?.definition.kind==='module')return target.definition.graph;
  if(target?.definition.kind==='operator')return target.definition.operator;
  return {inputs:[],outputs:[]};
}
export function referencedNode(graph:GraphTemplate,asset:AssetDocument):GraphNode {
  const kind=asset.definition.kind;if(kind!=='module'&&kind!=='operator')throw Error('只能插入模块或算子');
  return GraphTemplate.shape.nodes.element.parse({nodeId:nextGraphId(kind,graph.nodes.map(n=>n.nodeId)),name:asset.name,phases:kind==='operator'&&asset.definition.kind==='operator'?asset.definition.operator.phases:['prefill','decode'],portBindings:[],stateBindings:[],body:{kind,asset:{assetId:asset.assetId,revision:asset.revision,kind},bindings:asset.parameters.flatMap(p=>p.default?[{parameterKey:p.key,value:p.default}]:[])}});
}
export function opaqueNode(graph:GraphTemplate):GraphNode{return GraphTemplate.shape.nodes.element.parse({nodeId:nextGraphId('custom',graph.nodes.map(n=>n.nodeId)),name:'自定义开销',phases:['prefill','decode'],portBindings:[],stateBindings:[],body:{kind:'opaque',inputs:[],outputs:[],cost:{compute:[],memoryAccess:[],temporaryStorageIds:[],timing:{kind:'fixed',seconds:1,description:'用户声明的固定开销，请按所需口径修改'}}}});}
export const assetRef=(asset:AssetDocument):AssetRef=>({assetId:asset.assetId,revision:asset.revision,kind:asset.definition.kind});
export const literal=(value:number,unit:Extract<ValueExpr,{kind:'literal'}>['quantity']['unit']):ValueExpr=>({kind:'literal',quantity:{value,unit}});
