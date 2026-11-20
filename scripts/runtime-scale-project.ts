import { readFileSync } from 'node:fs';
import { AssetDocument,ProjectDocument,type AssetRef } from '@model-analyser/contracts';

export type RuntimeScaleKind='inline'|'operator'|'chain';
const literal=(value:number,unit:string)=>({kind:'literal',quantity:{value,unit}});
const ref=(a:AssetDocument):AssetRef=>({assetId:a.assetId,revision:a.revision,kind:a.definition.kind});
const emptyFrame={inputs:[],outputs:[],tensors:[],storages:[],states:[]};
const emptyGraph={...emptyFrame,nodes:[],edges:[],dependencies:[]};
const fixedCost={compute:[],memoryAccess:[],temporaryStorageIds:[],timing:{kind:'fixed',seconds:1e-6,description:'Authored synthetic one-microsecond leaf, not a device measurement'}};
function asset(assetId:string,name:string,definition:unknown){return AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId,revision:1,name,tags:['software-runtime-fixture'],parameters:[],sources:[{kind:'note',text:'Synthetic software-scaling input. No real model, kernel or hardware performance claim.'}],definition});}
function pack(name:string,model:AssetDocument,children:AssetDocument[]){const base=ProjectDocument.parse(JSON.parse(readFileSync('examples/contracts/project.json','utf8'))),hardware=base.assetSnapshots.filter(a=>a.definition.kind==='hardware');return ProjectDocument.parse({...base,projectId:'runtime:project:'+name,projectRevision:1,name:'Software runtime · '+name,assetSnapshots:[model,...children,...hardware],scenarios:[{...base.scenarios[0],scenarioId:'runtime:scenario:'+name,name,model:ref(model),bindings:[],workload:{kind:'prefill',batchSize:1,queryTokensPerRequest:1,pastTokensPerRequest:0},parallelPlan:{assignments:[],communications:[],assumptions:[]},executionPlan:{kind:'serial'},quantizationOverrides:[],numericOverrides:[],fusionGroups:[]}],measurements:[],viewState:{nodes:[]}});}

/** Compact source; expansion, rather than a huge pre-expanded input, spends the budget. */
export function runtimeScaleProject(kind:RuntimeScaleKind,count=9999):ProjectDocument{
  const dtype={category:'float',bits:16,format:'bf16'},shape=[{axisId:'d',semantic:'hidden',size:literal(4,'count')}],frame=kind==='chain'?{inputs:[{portId:'x',tensorId:'X'}],outputs:[{portId:'y',tensorId:'Y'}],tensors:['X','Y'].map(id=>({tensorId:id,name:id,shape,dtype,storageId:'s'+id})),storages:['X','Y'].map(id=>({storageId:'s'+id,name:id,category:'activation',sharingDomain:'request',allocation:{kind:'tensor',shape,dtype}})),states:[]}:emptyFrame;
  const cost=kind==='chain'?{...fixedCost,memoryAccess:[{accessId:'read',storageId:'sX',mode:'read',logicalBytes:literal(8,'byte'),hbmEstimate:{kind:'bytes',value:literal(8,'byte')}},{accessId:'write',storageId:'sY',mode:'write',logicalBytes:literal(8,'byte'),hbmEstimate:{kind:'bytes',value:literal(8,'byte')}}]}:fixedCost,op=asset('runtime:operator:empty','Referenced synthetic leaf',{kind:'operator',operator:{...emptyFrame,category:'custom',phases:['prefill','decode'],cost:fixedCost}}),model=asset('runtime:model:'+kind+':'+count,'Synthetic '+kind+' × '+count,{kind:'model',family:'synthetic',variant:'software-scaling',graph:{...frame,nodes:[{nodeId:'leaves',name:'Synthetic leaf',phases:['prefill','decode'],portBindings:[...frame.inputs,...frame.outputs],stateBindings:[],repeat:{axis:'i',count:literal(count,'count'),wiring:kind==='chain'?'chain':'independent',carry:kind==='chain'?[{outputPortId:'y',inputPortId:'x'}]:[]},body:kind==='operator'?{kind:'operator',asset:ref(op),bindings:[]}:{kind:'opaque',inputs:frame.inputs,outputs:frame.outputs,cost}}],edges:kind==='chain'?[{edgeId:'input',from:{kind:'graph_input',portId:'x'},to:{kind:'node',nodeId:'leaves',portId:'x'},tensorId:'X'},{edgeId:'output',from:{kind:'node',nodeId:'leaves',portId:'y'},to:{kind:'graph_output',portId:'y'},tensorId:'Y'}]:[],dependencies:[]}});
  return pack(kind+'-'+count,model,kind==='operator'?[op]:[]);
}

/** Number of referenced assets along the path, including model and operator. */
export function runtimeDepthProject(referenceDepth:number):ProjectDocument{
  if(!Number.isInteger(referenceDepth)||referenceDepth<2)throw Error('Depth must include model and operator');const op=asset('runtime:depth:operator','Depth leaf',{kind:'operator',operator:{...emptyFrame,category:'custom',phases:['prefill','decode'],cost:fixedCost}}),children=[op];let target=op;
  const graph=()=>({...emptyGraph,nodes:[{nodeId:'next',name:'Next',phases:['prefill','decode'],portBindings:[],stateBindings:[],body:{kind:target.definition.kind,asset:ref(target),bindings:[]}}]});
  for(let i=referenceDepth-2;i>=1;i--){target=asset('runtime:depth:module:'+i,'Depth '+i,{kind:'module',graph:graph()});children.push(target);}const model=asset('runtime:depth:model:'+referenceDepth,'Reference depth '+referenceDepth,{kind:'model',family:'synthetic',variant:'reference-depth',graph:graph()});return pack('depth-'+referenceDepth,model,children);
}
