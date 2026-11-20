import { type AssetDocument,type AssetRef } from '@model-analyser/contracts';
import { collectRefs } from '../../../packages/contracts/src/validation.js';

export function traceNodeFormulas(model:AssetRef,nodeId:string,assets:AssetDocument[]){
  const lookup=(r:AssetRef)=>assets.find(a=>a.assetId===r.assetId&&a.revision===r.revision&&a.definition.kind===r.kind),chain:{asset:AssetRef;name:string;localNodeId?:string}[]=[],formulas:AssetDocument[]=[];let current=lookup(model),source:unknown;
  if(current?.definition.kind!=='model')return {chain,formulas};chain.push({asset:model,name:current.name});
  const segments=nodeId.split('/');for(const [i,segment] of segments.entries()){
    if(current.definition.kind!=='model'&&current.definition.kind!=='module')break;
    let localId:string;try{localId=decodeURIComponent(segment.replace(/\[\d+\]$/,''));}catch{break;}
    const node=current.definition.graph.nodes.find(n=>n.nodeId===localId);if(!node)break;chain.push({asset:{assetId:current.assetId,revision:current.revision,kind:current.definition.kind},name:node.name,localNodeId:node.nodeId});
    if(node.body.kind==='module'||node.body.kind==='operator'){const target=lookup(node.body.asset);if(!target)break;chain.push({asset:node.body.asset,name:target.name});current=target;if(target.definition.kind==='operator'){source=target.definition.operator;break;}if(i===segments.length-1)source=target.definition;}
    else {source=node.body;break;}
  }
  const visited=new Set<string>();function visit(value:unknown){for(const ref of collectRefs(value).filter(r=>['formula','model','module','operator'].includes(r.kind))){const key=ref.kind+':'+ref.assetId+'@'+ref.revision;if(visited.has(key))continue;visited.add(key);const a=lookup(ref);if(a?.definition.kind==='formula')formulas.push(a);if(a)visit(a.definition);}}if(source)visit(source);
  return {chain,formulas};
}
