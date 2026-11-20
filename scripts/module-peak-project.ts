import { AssetDocument,NodeId,type ProjectDocument } from '@model-analyser/contracts';
import { makeDecodeProject } from './decode-project.js';
import { makeStreamProject } from './stream-project.js';
export function makeModulePeakProject(base:ProjectDocument):ProjectDocument{
  const p=makeStreamProject(base),s=p.scenarios[0]!,root=p.assetSnapshots.find(a=>a.definition.kind==='model');if(root?.definition.kind!=='model'||s.executionPlan.kind!=='streams')throw Error();const g=root.definition.graph;
  for(const id of ['A','B']){const node=g.nodes.find(n=>n.nodeId===id)!,scratch=g.storages.find(a=>a.storageId==='scratch'+id)!;
    const asset=AssetDocument.parse({...root,assetId:'private-'+id,name:'Module '+id,definition:{kind:'module',graph:{inputs:[],outputs:[],tensors:[],states:[],edges:[],dependencies:[],storages:[scratch],nodes:[{...node,nodeId:'work'}]}}});p.assetSnapshots.push(asset);
    g.nodes[g.nodes.indexOf(node)]={...node,body:{kind:'module',asset:{assetId:asset.assetId,revision:1,kind:'module'},bindings:[]}};g.storages=g.storages.filter(a=>a.storageId!==scratch.storageId);
  }
  s.executionPlan.assignments=s.executionPlan.assignments.map(a=>({...a,nodeId:NodeId.parse(a.nodeId+'/work')}));return p;
}

export function makeModuleDecodeProject(base:ProjectDocument):ProjectDocument{
    const p=makeDecodeProject(base),s=p.scenarios[0]!,root=p.assetSnapshots.find(a=>a.definition.kind==='model')!;if(root.definition.kind!=='model')throw Error();
    const inner=AssetDocument.parse({...root,assetId:'decode-private-module',definition:{kind:'module',graph:root.definition.graph}});if(inner.definition.kind!=='module')throw Error();
    inner.definition.graph.storages.push({storageId:'scratch' as never,name:'Private workspace',category:'workspace',sharingDomain:'instance',allocation:{kind:'bytes',value:{kind:'literal',quantity:{value:20,unit:'byte'}}}});const update=inner.definition.graph.nodes[0]!;if(update.body.kind!=='opaque')throw Error();update.body.cost.temporaryStorageIds.push('scratch' as never);p.assetSnapshots.push(inner);
    root.definition.graph={inputs:[],outputs:[],tensors:[],storages:[],states:[],edges:[],dependencies:[],nodes:[{nodeId:NodeId.parse('block'),name:'Decode block',phases:['decode'],portBindings:[],stateBindings:[],body:{kind:'module',asset:{assetId:inner.assetId,revision:1,kind:'module'},bindings:root.parameters.map(p=>({parameterKey:p.key,value:{kind:'symbol',name:p.key}}))}}]};
return p;
}
