import {readFileSync} from 'node:fs';
import {AssetDocument,ProjectDocument,Scenario} from '@model-analyser/contracts';
export const c01Project=()=>ProjectDocument.parse(JSON.parse(readFileSync('examples/contracts/project.json','utf8')) as unknown);
const base=c01Project();
const literal=(value:number,unit='count')=>({kind:'literal',quantity:{value,unit}});
export function echo(repeat?:'chain'|'independent'){
  const dtype={category:'float',bits:16,format:'bf16'},shape=[{axisId:'d',semantic:'hidden',size:literal(4)}];
  const frame={inputs:[{portId:'x',tensorId:'X'}],outputs:[{portId:'y',tensorId:'Y'}],tensors:['X','Y'].map(id=>({tensorId:id,name:id,shape,dtype,storageId:'s'+id})),storages:['X','Y'].map(id=>({storageId:'s'+id,name:id,category:'activation',sharingDomain:'request',allocation:{kind:'tensor',shape,dtype}})),states:[]};
  const classAsset=base.assetSnapshots.find(a=>a.definition.kind==='operator');if(classAsset?.definition.kind!=='operator')throw Error();const computeClass=classAsset.definition.operator.cost.compute[0]?.computeClass;
  const cost={compute:[{segmentId:'work',computeClass,usefulOperations:{kind:'symbol',name:'P'},executedOperations:{kind:'symbol',name:'P'}}],memoryAccess:[{accessId:'read',storageId:'sX',mode:'read',logicalBytes:literal(8,'byte')},{accessId:'write',storageId:'sY',mode:'write',logicalBytes:literal(8,'byte')}],temporaryStorageIds:[],timing:{kind:'fixed',seconds:1,description:'Explicit synthetic leaf'}};
  const op=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'echo-op',revision:1,name:'Echo',tags:[],parameters:[{key:'P',name:'P',type:'integer',unit:'operation',min:0,default:{kind:'integer',value:1}}],sources:[],definition:{kind:'operator',operator:{...frame,category:'custom',phases:['prefill','decode'],cost}}});
  const outputShape=repeat==='independent'?[{axisId:'layer',semantic:'custom',size:literal(3)},...shape]:shape;
  const model=AssetDocument.parse({...op,assetId:'echo-model',name:'Echo model',parameters:[],definition:{kind:'model',family:'synthetic',variant:'echo',graph:{...frame,tensors:frame.tensors.map(t=>t.tensorId==='Y'?{...t,shape:outputShape}:t),storages:frame.storages.map(s=>s.storageId==='sY'?{...s,allocation:{...s.allocation,shape:outputShape}}:s),nodes:[{nodeId:'block',name:'Block',phases:['prefill','decode'],portBindings:[...frame.inputs,...frame.outputs],stateBindings:[],body:{kind:'operator',asset:{assetId:op.assetId,revision:1,kind:'operator'},bindings:[]},...(repeat?{repeat:{axis:'layer',count:literal(3),wiring:repeat,carry:repeat==='chain'?[{outputPortId:'y',inputPortId:'x'}]:[]}}:{})}],edges:[{edgeId:'in',from:{kind:'graph_input',portId:'x'},to:{kind:'node',nodeId:'block',portId:'x'},tensorId:'X'},{edgeId:'out',from:{kind:'node',nodeId:'block',portId:'y'},to:{kind:'graph_output',portId:'y'},tensorId:'Y'}],dependencies:[]}}});
  const original=base.scenarios[0];if(!original)throw Error();const scenario=Scenario.parse({...original,model:{assetId:model.assetId,revision:1,kind:'model'}});
  return {scenario,assets:[op,model,...base.assetSnapshots.filter(a=>a.definition.kind==='hardware').map(a=>structuredClone(a))],op,model};
}
