import { AssetRef,NodeId,TensorId,ProjectDocument } from '@model-analyser/contracts';
import { validateProject } from '../packages/contracts/src/validation.js';
import { makeSerialGatherProject } from './serial-gather-project.js';
import { remapReferenceAssets } from './local-gemm-project.js';

/** A distinct graph-authored version of the serial gather reference. */
export function makeNativeCollectiveProject(base:ProjectDocument):ProjectDocument{
  const p=makeSerialGatherProject(base),s=p.scenarios[0];if(!s)throw Error();const ids=new Map(['operator','module','model'].map(k=>['example:'+k+':gemm-serial-gather','example:'+k+':gemm-native-gather']));p.assetSnapshots=remapReferenceAssets(p.assetSnapshots,ids);s.model=AssetRef.parse({...s.model,assetId:ids.get(s.model.assetId)??s.model.assetId});
  const model=p.assetSnapshots.find(a=>a.definition.kind==='model'),c=s.parallelPlan.communications[0];if(model?.definition.kind!=='model'||!c)throw Error();const g=model.definition.graph,y=g.tensors.find(t=>t.tensorId==='Y');if(!y)throw Error();const out=TensorId.parse('Yg');g.tensors.push({...y,tensorId:out,name:'Gathered Y, logical version sharing the explicit full backing'});g.outputs=g.outputs.map(p=>p.tensorId===y.tensorId?{...p,tensorId:out}:p);g.edges=g.edges.filter(e=>e.to.kind!=='graph_output');
  g.nodes.push({nodeId:NodeId.parse('gather-Y'),name:'Graph AllGather Y',phases:['decode'],portBindings:[{portId:'source',tensorId:y.tensorId},{portId:'destination',tensorId:out}],stateBindings:[],body:{kind:'collective',communication:{...c,destination:{...c.destination,tensorId:out},placement:{nodeId:NodeId.parse('gather-Y'),phases:['decode'],afterNodeIds:[],beforeNodeIds:[]}}}});
  g.edges.push({edgeId:'gemm-to-gather',from:{kind:'node',nodeId:NodeId.parse('module'),portId:'y'},to:{kind:'node',nodeId:NodeId.parse('gather-Y'),portId:'source'},tensorId:y.tensorId},{edgeId:'gather-to-output',from:{kind:'node',nodeId:NodeId.parse('gather-Y'),portId:'destination'},to:{kind:'graph_output',portId:g.outputs[0]?.portId??'y'},tensorId:out});
  s.parallelPlan.communications=[];s.scenarioId='example:scenario:native-gather';s.name='Graph-native AllGather';p.projectId='example:project:native-gather';p.name='模型图原生 AllGather 与共享 backing 参考';
  const parsed=ProjectDocument.parse(p),issues=validateProject(parsed).filter(d=>d.severity==='error');if(issues.length)throw Error(JSON.stringify(issues));return parsed;
}
