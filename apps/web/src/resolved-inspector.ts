import type { AssetDocument,AssetRef,ResolvedGraph } from '@model-analyser/contracts';
import { collectivePorts } from '../../../packages/contracts/src/collective.js';

/** Module interfaces use their own materialized frame; repeat wrappers use the caller's boundary. */
export function resolvedInterface(resolved:ResolvedGraph,model:AssetRef,assets:AssetDocument[],nodeId:string){
  const leaf=resolved.graph.nodes.find(n=>n.nodeId===nodeId);
  if(leaf){const body=leaf.body;if(body.kind==='opaque')return {inputs:body.inputs,outputs:body.outputs};if(body.kind==='collective')return collectivePorts(body.communication);}
  const lookup=(ref:AssetRef)=>assets.find(a=>a.assetId===ref.assetId&&a.revision===ref.revision&&a.definition.kind===ref.kind);
  let asset=lookup(model),parent='$model';
  if(nodeId==='$model'){
    if(asset?.definition.kind!=='model')return;
    const frame=resolved.objectBindings.find(b=>b.nodeId==='$model');
    return mapPorts(asset.definition.graph,local=>frame?.tensors.find(t=>t.localTensorId===local)?.tensorId);
  }
  const segments=nodeId.split('/');
  for(let i=0;i<segments.length;i++){
    const segment=segments[i]!;if(asset?.definition.kind!=='model'&&asset?.definition.kind!=='module')return;
    let local:string;try{local=decodeURIComponent(segment.replace(/\[\d+\]$/,''));}catch{return;}
    const call=asset.definition.graph.nodes.find(n=>n.nodeId===local);if(!call)return;
    const target=call.body.kind==='module'||call.body.kind==='operator'?lookup(call.body.asset):undefined;
    if(i===segments.length-1){
      const iface=target?.definition.kind==='module'?target.definition.graph:target?.definition.kind==='operator'?target.definition.operator:call.body.kind==='opaque'?call.body:call.body.kind==='collective'?collectivePorts(call.body.communication):undefined;if(!iface)return;
      const frame=resolved.objectBindings.find(b=>b.nodeId===nodeId);
      if(frame)return mapPorts(iface,local=>frame.tensors.find(t=>t.localTensorId===local)?.tensorId);
      // No synthetic first/last leaf substitution: the parent declares the wrapper's complete interface.
      const caller=resolved.objectBindings.find(b=>b.nodeId===parent);
      return {inputs:iface.inputs.flatMap(p=>{const local=call.portBindings.find(b=>b.portId===p.portId)?.tensorId,id=caller?.tensors.find(t=>t.localTensorId===local)?.tensorId;return id?[{portId:p.portId,tensorId:id}]:[];}),outputs:iface.outputs.flatMap(p=>{const local=call.portBindings.find(b=>b.portId===p.portId)?.tensorId,id=caller?.tensors.find(t=>t.localTensorId===local)?.tensorId;return id?[{portId:p.portId,tensorId:id}]:[];})};
    }
    asset=target;parent=segments.slice(0,i+1).join('/');
  }
}
function mapPorts(iface:Pick<ResolvedGraph['graph'],'inputs'|'outputs'>,id:(local:string)=>ResolvedGraph['graph']['tensors'][number]['tensorId']|undefined){
  const map=(ports:typeof iface.inputs)=>ports.flatMap(p=>{const tensorId=id(p.tensorId);return tensorId?[{portId:p.portId,tensorId}]:[];});return {inputs:map(iface.inputs),outputs:map(iface.outputs)};
}
export function canonicalInspectorStorage(resolved:ResolvedGraph,id:string){const seen=new Set<string>();let storage=resolved.graph.storages.find(s=>s.storageId===id);while(storage?.allocation.kind==='alias'){if(seen.has(storage.storageId))return;seen.add(storage.storageId);const target=storage.allocation.targetStorageId;storage=resolved.graph.storages.find(s=>s.storageId===target);}return storage;}
export const containsNode=(parent:string,child:string)=>parent==='$model'||parent===child||child.startsWith(parent+'/')||child.startsWith(parent+'[');
