import {AssetDocument,ProjectDocument,StorageId,type Shape} from '@model-analyser/contracts';
import {c01Project,echo} from './model-fixtures.js';

const symbol=(name:string)=>({kind:'symbol' as const,name});
const parameter=(key:string,value:number)=>({key,name:key,type:'integer' as const,unit:'count' as const,min:1,default:{kind:'integer' as const,value}});

export function repeatLayoutProject(wiring:'chain'|'independent',inPlace=false){
 const {scenario,assets,op,model}=echo(wiring),project=c01Project();
 if(model.definition.kind!=='model'||op.definition.kind!=='operator')throw Error('Missing repeat fixture');
 model.parameters.push(parameter('Width',2),parameter('R',3));
 op.parameters.push(parameter('D',1));
 const formula=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'test:repeat-dimension',revision:1,name:'Shape bound in the repeated instance',tags:[],sources:[],parameters:[],
  definition:{kind:'formula',formula:{inputs:{w:{unit:'count',integerRequired:true},i:{unit:'count',integerRequired:true}},expression:'max(w, i + 1)',
    output:{unit:'count',integerRequired:true,nonNegative:true},description:'Read the actual parent width and repeat index'}}});
 assets.push(formula);
 const graph=model.definition.graph,node=graph.nodes[0];
 if(!node?.repeat||node.body.kind!=='operator')throw Error('Missing repeat node');
 node.repeat.count=symbol('R');
 node.body.bindings.push({parameterKey:'D',value:{kind:'formula',call:{formula:{assetId:formula.assetId,revision:1,kind:'formula'},bindings:{w:symbol('Width'),i:symbol('layer')}}}});
 const axis=(name:string):Shape[number]=>({axisId:'d',semantic:'hidden',size:symbol(name)});
 for(const tensor of op.definition.operator.tensors)tensor.shape=[axis('D')];
 for(const storage of op.definition.operator.storages)if(storage.allocation.kind==='tensor')storage.allocation.shape=[axis('D')];
 for(const tensor of graph.tensors){
  tensor.shape=tensor.tensorId==='Y'&&wiring==='independent'?[{axisId:'layer',semantic:'custom',size:symbol('R')},axis('Width')]:[axis('Width')];
  if(tensor.tensorId==='Y'&&inPlace)tensor.storageId=StorageId.parse('sX');
 }
 for(const storage of graph.storages)if(storage.allocation.kind==='tensor'){
  storage.allocation.shape=graph.tensors.find(t=>t.storageId===storage.storageId)?.shape??[axis('Width')];
 }
 if(inPlace)graph.storages=graph.storages.filter(s=>s.storageId!=='sY');
 scenario.numericOverrides=[{target:{kind:'scenario',scenarioId:scenario.scenarioId},field:'parameter',parameterKey:'Width',value:{value:4,unit:'count'}}];
 scenario.executionPlan={kind:'streams',assignments:[],extraDependencies:[],resourcePolicy:{kind:'ideal'}};
 return ProjectDocument.parse({...project,name:'Repeat layout evidence',assetSnapshots:assets,scenarios:[scenario],measurements:[]});
}
