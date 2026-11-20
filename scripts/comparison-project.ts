import { AssetDocument,ProjectDocument,Scenario,type AssetRef } from '@model-analyser/contracts';
/** Independent arithmetic: A=X s /16X B, B=4.5 s /8X B, C=max(3,X) s /32X B. */
export function makeComparisonProject(base:ProjectDocument):ProjectDocument{
  const p=ProjectDocument.parse(base),original=p.scenarios[0],hardware=p.assetSnapshots.find(a=>a.definition.kind==='hardware');if(!original||hardware?.definition.kind!=='hardware')throw Error('C01 hardware required');
  hardware.definition.hardware.capacityBytes=64;p.assetSnapshots=[hardware];p.scenarios=[];p.measurements=[];p.projectId='example:project:comparison';p.name='Integer comparison hand reference';
  for(const [index,expression] of ['X','4.5','max(3, X)'].entries()){
    const key=['a','b','c'][index];if(!key)throw Error();
    const shell={documentType:'asset',schemaVersion:1,revision:1,tags:['synthetic-comparison-reference'],sources:[{kind:'note',text:'Artificial seconds and bytes, not measured hardware or performance.'}],parameters:[]};
    const time=AssetDocument.parse({...shell,assetId:'example:formula:comparison-time-'+key,name:'Time '+key,definition:{kind:'formula',formula:{inputs:{X:{unit:'count',integerRequired:true,min:1}},expression,output:{unit:'second',integerRequired:false,nonNegative:true},description:'Independent synthetic time oracle'}}});
    const bytes=AssetDocument.parse({...shell,assetId:'example:formula:comparison-bytes-'+key,name:'Bytes '+key,definition:{kind:'formula',formula:{inputs:{X:{unit:'count',integerRequired:true,min:1}},expression:'X * '+[16,8,32][index],output:{unit:'byte',integerRequired:true,nonNegative:true},description:'Independent resident weight oracle'}}});
    const call=(a:AssetDocument)=>({kind:'formula',call:{formula:{assetId:a.assetId,revision:1,kind:'formula'},bindings:{X:{kind:'symbol',name:'X'}}}});
    const model=AssetDocument.parse({...shell,assetId:'example:model:comparison-'+key,name:'Comparison '+key,parameters:[{key:'X',name:'Integer X',type:'integer',unit:'count',min:1,max:1000,default:{kind:'integer',value:2}}],definition:{kind:'model',family:'synthetic',variant:'comparison-'+key,graph:{inputs:[],outputs:[],tensors:[],states:[],edges:[],dependencies:[],storages:[{storageId:'weights',name:'Resident synthetic weights',category:'weight',sharingDomain:'instance',allocation:{kind:'bytes',value:call(bytes)}}],nodes:[{nodeId:'work',name:'Synthetic work',phases:['prefill','decode'],portBindings:[],stateBindings:[],body:{kind:'opaque',inputs:[],outputs:[],cost:{compute:[],memoryAccess:[],temporaryStorageIds:[],timing:{kind:'custom_formula',seconds:call(time),description:'Artificial time'}}}}]}}});
    const scenario=Scenario.parse({...original,scenarioId:'example:scenario:comparison-'+key,name:['Linear A','Constant B','Plateau C'][index],model:{assetId:model.assetId,revision:1,kind:'model'} satisfies AssetRef,bindings:[],numericOverrides:[],quantizationOverrides:[],fusionGroups:[],parallelPlan:{assignments:[],communications:[],assumptions:[]},executionPlan:{kind:'serial'},workload:{kind:'prefill',batchSize:1,queryTokensPerRequest:1,pastTokensPerRequest:0}});
    p.scenarios.push(scenario);p.assetSnapshots.push(time,bytes,model);
  }
  return ProjectDocument.parse(p);
}
