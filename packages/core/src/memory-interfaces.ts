import type { AssetDocument,GraphTemplate,MemoryEvidence,ResolvedGraph,StorageId } from '@model-analyser/contracts';
/** Real declared interfaces, including repeat wrappers through their caller frame. */
export function memoryInterfaces(resolved:ResolvedGraph,assets:AssetDocument[],canonical:Map<StorageId,StorageId>,allocated:Set<StorageId>):NonNullable<MemoryEvidence['interfaces']>{
  const tensors=new Map(resolved.graph.tensors.map(t=>[String(t.tensorId),t])),frames=new Map(resolved.objectBindings.map(b=>[String(b.nodeId),b])),containers=new Map(resolved.containers.map(c=>[String(c.nodeId),c])),definitions=new Map(assets.map(a=>[a.assetId+'@'+a.revision,a])),found=new Map<string,NonNullable<MemoryEvidence['interfaces']>[number]>();
  const graphOf=(a:AssetDocument|undefined)=>a?.definition.kind==='model'||a?.definition.kind==='module'?a.definition.graph:a?.definition.kind==='operator'?a.definition.operator:undefined;
  const add=(nodeId:NonNullable<MemoryEvidence['interfaces']>[number]['nodeId'],ids:(string|undefined)[])=>{const storages:StorageId[]=[];for(const id of ids){const t=id?tensors.get(id):undefined,key=t?canonical.get(t.storageId):undefined;if(!key)return;storages.push(key);}found.set(nodeId,{nodeId,storageIds:[...new Set(storages)].filter(id=>allocated.has(id))});};
  for(const n of resolved.graph.nodes)add(n.nodeId,n.portBindings.map(p=>p.tensorId));
  for(const c of resolved.containers){const target=graphOf(definitions.get(c.asset.assetId+'@'+c.asset.revision));if(!target)continue;const ports=[...target.inputs,...target.outputs],frame=frames.get(c.nodeId);
    if(frame){const mapping=new Map(frame.tensors.map(t=>[String(t.localTensorId),t.tensorId]));add(c.nodeId,ports.map(p=>mapping.get(p.tensorId)));continue;}
    const split=c.nodeId.lastIndexOf('/'),parent=split<0?'$model':c.nodeId.slice(0,split),caller=containers.get(parent),callerGraph=caller?graphOf(definitions.get(caller.asset.assetId+'@'+caller.asset.revision)):undefined,callerFrame=frames.get(parent);if(!callerGraph||!('nodes' in callerGraph)||!callerFrame)continue;
    let local:string;try{local=decodeURIComponent(c.nodeId.slice(split+1).replace(/\[\d+\]$/,''));}catch{continue;}
    const call=(callerGraph as GraphTemplate).nodes.find(n=>n.nodeId===local);if(!call)continue;const bindings=new Map(call.portBindings.map(p=>[p.portId,p.tensorId])),mapping=new Map(callerFrame.tensors.map(t=>[String(t.localTensorId),t.tensorId]));add(c.nodeId,ports.map(p=>{const id=bindings.get(p.portId);return id?mapping.get(id):undefined;}));
  }
  return [...found.values()];
}
