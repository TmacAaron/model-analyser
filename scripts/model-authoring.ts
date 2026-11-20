import { createHash } from 'node:crypto';
import { AssetDocument,GraphTemplate,TensorId,StorageId,NodeId,type ValueExpr,type Shape,type CostDefinition } from '@model-analyser/contracts';
import { parseExpression,expressionSymbols } from '../packages/contracts/src/expression.js';

/** Offline asset authoring only. The analysis engine has no model-family branches. */
type DTypeSpec=GraphTemplate['tensors'][number]['dtype'];
type ComputeClass=CostDefinition['compute'][number]['computeClass'];
type ParameterDef=AssetDocument['parameters'][number];
export const bf16:DTypeSpec={category:'float',bits:16,format:'bf16'};
export const fp32:DTypeSpec={category:'float',bits:32,format:'fp32'};
export const int64:DTypeSpec={category:'int',bits:64,format:'int64'};
export const matrix:ComputeClass={arithmetic:'float',inputDtypes:[bf16],multiplyDtype:bf16,accumulateDtype:fp32,resource:'matrix'};
export const vector:ComputeClass={arithmetic:'float',inputDtypes:[fp32],multiplyDtype:fp32,accumulateDtype:fp32,resource:'vector'};
export const literal=(value:number,unit:'count'|'byte'|'operation'='count'):ValueExpr=>({kind:'literal',quantity:{value,unit}});
export const symbol=(name:string):ValueExpr=>({kind:'symbol',name});
export const ref=(a:AssetDocument)=>({assetId:a.assetId,revision:a.revision,kind:a.definition.kind});

export class Equations {
  assets:AssetDocument[]=[];
  constructor(readonly prefix:string,readonly parameters:ParameterDef[],readonly sources:AssetDocument['sources']){}
  value(expression:string,unit:'count'|'byte'|'operation'):ValueExpr{
    if(/^\d+$/.test(expression))return literal(Number(expression),unit);
    if(unit==='count'&&this.parameters.some(p=>p.key===expression))return symbol(expression);
    const id=this.prefix+':'+createHash('sha256').update(unit+':'+expression).digest('hex').slice(0,16);
    let asset=this.assets.find(a=>a.assetId===id);
    if(!asset){const names=[...expressionSymbols(parseExpression(expression))].sort();asset=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:id,revision:1,name:expression+' ['+unit+']',parameters:[],tags:['transformer-equation'],sources:this.sources,definition:{kind:'formula',formula:{inputs:Object.fromEntries(names.map(name=>{const p=this.parameters.find(p=>p.key===name);if(!p||p.type!=='integer')throw Error('Missing equation parameter '+name);return [name,{unit:p.unit,integerRequired:true,min:p.min??0}];})),expression,output:{unit,integerRequired:true,nonNegative:true},description:'Explicit analytical equation. Multiply-add counts as two operations; no executable model code.'}}});this.assets.push(asset);}
    if(asset.definition.kind!=='formula')throw Error();return {kind:'formula',call:{formula:ref(asset),bindings:Object.fromEntries(Object.keys(asset.definition.formula.inputs).map(k=>[k,symbol(k)]))}};
  }
}

type TensorOptions={dtype?:DTypeSpec;category?:GraphTemplate['storages'][number]['category'];storageId?:string};
export class GraphAuthor {
  graph:GraphTemplate={inputs:[],outputs:[],nodes:[],edges:[],dependencies:[],tensors:[],storages:[],states:[]};
  private producers=new Map<string,GraphTemplate['edges'][number]['from']>();
  constructor(readonly equations:Equations){}
  shape(axes:[string,Shape[number]['semantic'],string][]):Shape{return axes.map(([axisId,semantic,size])=>({axisId,semantic,size:this.equations.value(size,'count')}));}
  tensor(id:string,axes:[string,Shape[number]['semantic'],string][],options:TensorOptions={}):string{
    const shape=this.shape(axes),dtype=options.dtype??bf16,storageId=StorageId.parse(options.storageId??id),category=options.category??'activation';
    if(!this.graph.storages.some(s=>s.storageId===storageId))this.graph.storages.push({storageId,name:id,category,sharingDomain:category==='weight'?'instance':'request',allocation:{kind:'tensor',shape,dtype}});
    this.graph.tensors.push({tensorId:TensorId.parse(id),name:id,shape,dtype,storageId});return id;
  }
  input(id:string,portId=id){this.graph.inputs.push({portId,tensorId:TensorId.parse(id)});this.producers.set(id,{kind:'graph_input',portId});}
  output(id:string,portId=id){this.graph.outputs.push({portId,tensorId:TensorId.parse(id)});const from=this.producers.get(id);if(!from)throw Error('Missing producer '+id);this.graph.edges.push({edgeId:'out-'+portId,from,to:{kind:'graph_output',portId},tensorId:TensorId.parse(id)});}
  ports(ids:string[]){return ids.map(tensorId=>({portId:tensorId,tensorId:TensorId.parse(tensorId)}));}
  node(id:string,name:string,inputs:string[],outputs:string[],work?:{useful:string;executed?:string;computeClass?:ComputeClass},options:{accessBytes?:Record<string,string>;temporaries?:string[]}={}){
    const ports=[...this.ports(inputs),...this.ports(outputs)],cost:CostDefinition={compute:work?[{segmentId:'arithmetic',computeClass:work.computeClass??matrix,usefulOperations:this.equations.value(work.useful,'operation'),executedOperations:this.equations.value(work.executed??work.useful,'operation')}]:[],memoryAccess:[],temporaryStorageIds:(options.temporaries??[]).map(id=>StorageId.parse(id)),timing:{kind:'roofline_bound',computeEfficiency:1,memoryEfficiency:1,computeMemoryOverlap:'ideal',launchSeconds:0}};
    for(const [mode,list] of [['read',inputs],['write',outputs]] as const)for(const tensor of list){const t=this.graph.tensors.find(t=>t.tensorId===tensor);if(!t)throw Error('Unknown tensor '+tensor);const bytes=options.accessBytes?.[tensor];cost.memoryAccess.push({accessId:mode+'-'+tensor,storageId:t.storageId,mode,logicalBytes:bytes?this.equations.value(bytes,'byte'):{kind:'storage_allocation',passes:literal(1)},hbmEstimate:{kind:'factor',value:1}});}
    for(const temporary of options.temporaries??[])for(const mode of ['read','write'] as const)cost.memoryAccess.push({accessId:mode+'-scratch-'+temporary,storageId:StorageId.parse(temporary),mode,logicalBytes:{kind:'storage_allocation',passes:literal(1)},hbmEstimate:{kind:'factor',value:1}});
    this.graph.nodes.push({nodeId:NodeId.parse(id),name,phases:['prefill','decode'],portBindings:ports,stateBindings:[],body:{kind:'opaque',inputs:this.ports(inputs),outputs:this.ports(outputs),cost}});this.connect(id,inputs,outputs);
  }
  module(id:string,name:string,asset:AssetDocument,input:string,output:string,parameters:ParameterDef[],repeat?:GraphTemplate['nodes'][number]['repeat']){
    this.modulePorts(id,name,asset,{x:input},{y:output},parameters,repeat);
  }
  modulePorts(id:string,name:string,asset:AssetDocument,inputs:Record<string,string>,outputs:Record<string,string>,parameters:ParameterDef[],
    repeat?:GraphTemplate['nodes'][number]['repeat'],stateBindings:GraphTemplate['nodes'][number]['stateBindings']=[]){
    const nodeId=NodeId.parse(id),inputPorts=Object.entries(inputs),outputPorts=Object.entries(outputs);
    const portBindings=[...inputPorts,...outputPorts].map(([portId,tensorId])=>({portId,tensorId:TensorId.parse(tensorId)}));
    this.graph.nodes.push({nodeId,name,phases:['prefill','decode'],portBindings,stateBindings,...(repeat?{repeat}:{}),body:{kind:'module',asset:ref(asset),bindings:parameters.map(p=>({parameterKey:p.key,value:symbol(p.key)}))}});
    for(const [portId,input] of inputPorts){
      const from=this.producers.get(input);if(!from)throw Error('Missing module input '+input);
      this.graph.edges.push({edgeId:id+'-in'+(portId==='x'?'':'-'+portId),from,to:{kind:'node',nodeId,portId},tensorId:TensorId.parse(input)});
    }
    for(const [portId,output] of outputPorts)this.producers.set(output,{kind:'node',nodeId,portId});
  }
  private connect(id:string,inputs:string[],outputs:string[]){for(const tensor of inputs){const from=this.producers.get(tensor);if(from)this.graph.edges.push({edgeId:id+'-in-'+tensor,from,to:{kind:'node',nodeId:NodeId.parse(id),portId:tensor},tensorId:TensorId.parse(tensor)});}for(const tensor of outputs)this.producers.set(tensor,{kind:'node',nodeId:NodeId.parse(id),portId:tensor});}
}
