import type {AssetDocument,Quantity,ResolvedParameter,ValueExpr} from '@model-analyser/contracts';
import {jsonBytes} from '../../contracts/src/json-size.js';
import {explainValue,type ValueEvaluationProof} from './formula.js';
import {stableStringify} from './input-hash.js';
import type {InstantiatedCostCapture} from './instantiate.js';
import type {ParameterCaptureTrace,ParameterFrame,ParameterObservation} from './parameter-observation.js';
type Value=ResolvedParameter['value'];type Source=ResolvedParameter['source'];
export type ParameterBindingNode={id:string;kind:'workload'|'repeat_index'|'default'|'override'|'literal'|'symbol'|'formula'|'binding'|'parameter'|'boundary';inputs:string[];value:Value;unit:Quantity['unit'];frameId:string;name:string;source?:Source;formula?:Extract<ValueExpr,{kind:'formula'}>['call']['formula'];proof?:ValueEvaluationProof};
export type ParameterBindingCandidate={id:string;frameId:string;parameterKey:string;kind:'default'|'binding'|'override';status:'winning'|'superseded'|'skipped'|'unset';nodeId?:string;source?:Source;overrideIndex?:number};
export type ParameterBindingRoot={role:'call'|'storage'|'quantization'|'layout';target:string;frameId?:string;name:string;nodeId?:string};
export type AdditionalParameterRoot={frameId:string;name:string;quantity:Quantity;target:string};
export type ParameterBindingGraph={schemaVersion:1;scope:'actual_call_and_storage_parameter_context'|'actual_call_storage_and_quantization_parameter_context'|'actual_layout_parameter_context';nodes:ParameterBindingNode[];candidates:ParameterBindingCandidate[];roots:ParameterBindingRoot[];complete:boolean;truncated:boolean;boundaries:string[];frameCount:number};
type BindingTarget={role:ParameterBindingRoot['role'];target:string;frameId:string|undefined;symbols:Record<string,Quantity>};
const numeric=(value:Value):value is Extract<Value,{kind:'integer'|'number'}>=>value.kind==='integer'||value.kind==='number';
/** Rebuild actual binding edges from recorded roles/frame IDs, never equal values. */
export function parameterBindingGraph(call:InstantiatedCostCapture,assets:AssetDocument[],limit=256,additional:readonly AdditionalParameterRoot[]=[]):ParameterBindingGraph{
 const targets:BindingTarget[]=[
  {role:'call',target:call.nodeId,frameId:call.bindingContext?.frameId,symbols:call.symbols},
  ...call.storages.map(storage=>({role:'storage' as const,target:String(storage.storage.storageId),frameId:storage.bindingFrame,symbols:storage.symbols})),
  ...additional.map(root=>({role:'quantization' as const,target:root.target,frameId:root.frameId,symbols:Object.fromEntries([[root.name,root.quantity]])})),
 ];
 return buildBindings(call.bindingContext?.trace,assets,targets,additional.length?'actual_call_storage_and_quantization_parameter_context':'actual_call_and_storage_parameter_context',limit);
}

export function layoutParameterBindingGraph(trace:ParameterCaptureTrace,assets:AssetDocument[],reads:readonly AdditionalParameterRoot[]):ParameterBindingGraph{
 return buildBindings(trace,assets,reads.map(read=>({role:'layout',target:read.target,frameId:read.frameId,symbols:Object.fromEntries([[read.name,read.quantity]])})),'actual_layout_parameter_context',256);
}

function buildBindings(trace:ParameterCaptureTrace|undefined,assets:AssetDocument[],targets:BindingTarget[],scope:ParameterBindingGraph['scope'],limit:number):ParameterBindingGraph{
 if(!Number.isSafeInteger(limit)||limit<1||limit>256)throw Error('参数来源节点预算须为1至256');
 const frames=new Map((trace?.frames??[]).map(frame=>[frame.id,frame])),nodes:ParameterBindingNode[]=[],candidates:ParameterBindingCandidate[]=[],roots:ParameterBindingRoot[]=[],boundaries:string[]=[],ids=new Set<string>(),resolved=new Map<string,string|undefined>(),active=new Set<string>();let truncated=trace?.truncated??true,bytes=0;
 const id=(...parts:(string|number)[])=>JSON.stringify(parts);
 function boundary(message:string){if(boundaries.length<32&&!boundaries.includes(message))boundaries.push(message);}
 function spend(value:unknown){try{bytes+=jsonBytes(value,16*1024*1024-bytes);return true;}catch{truncated=true;return false;}}
 function add(node:ParameterBindingNode){if(nodes.length>=limit||!spend(node)){truncated=true;return undefined;}if(ids.has(node.id))throw Error('参数绑定记录身份重复');if(node.inputs.some(input=>!ids.has(input))){boundary('参数输入边达到预算或缺少实际作用域');return undefined;}ids.add(node.id);nodes.push(node);return node.id;}
 function candidate(record:ParameterBindingCandidate){if(candidates.length>=limit||!spend(record)){truncated=true;return;}candidates.push(record);}
 function symbols(frameId:string|undefined,seen=new Set<string>()):Record<string,Quantity>|undefined{if(!frameId||seen.has(frameId))return undefined;const frame=frames.get(frameId);if(!frame)return undefined;if(frame.kind!=='repeat')return frame.symbols;seen.add(frameId);const parent=symbols(frame.parent,seen);return parent?{...parent,...frame.symbols}:undefined;}
 function expression(expr:ValueExpr,proof:ValueEvaluationProof|undefined,frame:ParameterFrame,path:string):string|undefined{
  if(!proof?.quantity){truncated=true;boundary('绑定表达式达到记录预算');return undefined;}
  const value:Value={kind:'number',value:proof.quantity.value},base={id:path,value,unit:proof.quantity.unit,frameId:frame.id,name:proof.name??expr.kind};
  if(expr.kind==='literal')return add({...base,kind:'literal',inputs:[]});
  if(expr.kind==='symbol'){const input=lookup(frame.parent,expr.name);return input?add({...base,kind:'symbol',inputs:[input],name:expr.name}):undefined;}
  const inputs:string[]=[];for(const [name,child]of Object.entries(expr.call.bindings)){const binding=proof.bindings?.find(p=>p.name===name),input=expression(child,binding?.proof,frame,id(path,'argument',name));if(input)inputs.push(input);else return undefined;}
  return add({...base,kind:'formula',inputs,formula:expr.call.formula,proof});
 }
 function lookup(frameId:string|undefined,name:string):string|undefined{
  const key=id('parameter',frameId??'unrecorded',name);if(resolved.has(key))return resolved.get(key);if(!frameId||active.has(key)){boundary('参数作用域缺失或形成循环：'+name);return undefined;}const frame=frames.get(frameId);if(!frame){boundary('未采集外部参数作用域：'+name);return undefined;}active.add(key);let output:string|undefined;
  if(frame.kind==='repeat'&&name!==frame.axis)output=lookup(frame.parent,name);
  else if(frame.kind==='workload'||frame.kind==='repeat'){const quantity=frame.symbols[name];if(quantity)output=add({id:key,kind:frame.kind==='workload'?'workload':'repeat_index',inputs:[],value:{kind:'number',value:quantity.value},unit:quantity.unit,frameId:frame.id,name});else boundary('实际输入域中没有符号：'+name);}
  else{
   const events=frame.events.filter(event=>event.parameterKey===name),finals=events.filter(event=>event.kind==='final'),final=finals[0];if(finals.length!==1||final?.kind!=='final'){boundary('参数最终绑定未完整采集：'+name);}
   else{
    let winner:string|undefined,winnerValue:Value|undefined,winnerSource:Source|undefined,winnerChoice:ParameterBindingCandidate|undefined;const choices:ParameterBindingCandidate[]=[];
    for(const [index,event]of events.entries()){
     if(event.kind==='final')continue;const choiceId=id(frame.id,name,'candidate',index),choice:ParameterBindingCandidate={id:choiceId,frameId:frame.id,parameterKey:name,kind:event.kind,status:'unset',...('source'in event?{source:event.source}:{}),...(event.kind==='override'?{overrideIndex:event.overrideIndex}:{})};
     let nodeId:string|undefined;
     if(event.kind==='override'&&event.action==='skipped_existing_default_or_binding')choice.status='skipped';
     else if(event.kind==='binding'){
      const expr=event.expression;if(expr.kind==='literal'||expr.kind==='symbol'||expr.kind==='formula'){
       const parent=symbols(frame.parent);if(!parent){boundary('绑定表达式的父作用域未采集：'+name);}else{const evaluated=explainValue(expr,parent,assets);if(!numeric(event.value)||evaluated.quantity.value!==event.value.value||evaluated.quantity.unit!==final.unit)throw Error('绑定表达式与实际记录的数量或单位不同');if(evaluated.truncated)truncated=true;const input=expression(expr,evaluated.proof,frame,id(choiceId,'expression'));if(input)nodeId=add({id:choiceId,kind:'binding',inputs:[input],value:event.value,unit:final.unit,frameId:frame.id,name,source:event.source});}
      }else nodeId=add({id:choiceId,kind:'binding',inputs:[],value:event.value,unit:final.unit,frameId:frame.id,name,source:event.source});
     }else if(event.kind==='default'&&event.value!==undefined)nodeId=add({id:choiceId,kind:'default',inputs:[],value:event.value,unit:final.unit,frameId:frame.id,name,source:event.source});
     else if(event.kind==='override'&&event.action==='applied')nodeId=add({id:choiceId,kind:'override',inputs:[],value:event.value,unit:final.unit,frameId:frame.id,name,source:event.source});
     if(nodeId){choice.nodeId=nodeId;choice.status='superseded';}
     const applied=event.kind==='binding'||event.kind==='default'&&event.value!==undefined||event.kind==='override'&&event.action==='applied';if(applied){choice.status='superseded';winner=nodeId;winnerValue=event.value;winnerSource=event.source;winnerChoice=choice;}
     choices.push(choice);
    }
    if(stableStringify(winnerValue)!==stableStringify(final.value)||stableStringify(winnerSource)!==stableStringify(final.source))throw Error('最终生效参数与实际覆盖顺序不同');
    if(numeric(final.value)){const quantity=frame.symbols[name];if(!quantity||quantity.value!==final.value.value||quantity.unit!==final.unit)throw Error('最终参数与该实际作用域的符号不同');}
    if(winnerChoice)winnerChoice.status='winning';if(winner){output=add({id:key,kind:'parameter',inputs:[winner],value:final.value,unit:final.unit,frameId:frame.id,name,source:final.source});}else boundary('生效参数的表达式记录不完整：'+name);
    for(const choice of choices)candidate(choice);
   }
  }
  active.delete(key);resolved.set(key,output);return output;
 }
 for(const target of targets){
  const frame=target.frameId?frames.get(target.frameId):undefined;
  const names=[...new Set([...Object.keys(target.symbols),...(target.role==='layout'||target.role==='quantization'?[]:frame?.events.filter(e=>e.kind==='final').map(e=>e.parameterKey)??[])])];
  for(const name of names){
   if(roots.length>=limit){truncated=true;break;}
   const nodeId=lookup(target.frameId,name),root:ParameterBindingRoot={role:target.role,target:target.target,...(target.frameId?{frameId:target.frameId}:{}),name,...(nodeId?{nodeId}:{})};
   if(target.role==='layout'&&nodeId){
    const resolved=nodes.find(n=>n.id===nodeId),used=target.symbols[name];
    if(!resolved||!numeric(resolved.value)||resolved.value.value!==used?.value||resolved.unit!==used.unit)throw Error('实际布局读取与参数绑定的值或单位不同');
   }
   if(!spend(root))break;
   roots.push(root);
  }
 }
 const graph:ParameterBindingGraph={schemaVersion:1,scope,nodes,candidates,roots,complete:!truncated&&boundaries.length===0&&roots.every(root=>!!root.nodeId),truncated,boundaries,frameCount:frames.size};validateParameterBindingGraph(graph);return graph;
}
/** Structural/numeric consistency; authentic labels require full fixed-input replay. */
export function validateParameterBindingGraph(graph:ParameterBindingGraph){
 const nodes=new Map<string,ParameterBindingNode>();for(const node of graph.nodes){
  if(nodes.has(node.id)||node.inputs.some(input=>!nodes.has(input)))throw Error('参数图身份或拓扑无效');
  if(['parameter','symbol','binding'].includes(node.kind)&&node.inputs.length){
   if(node.inputs.length!==1)throw Error('参数选择边必须唯一');const input=nodes.get(node.inputs[0]??'');if(!input)throw Error('参数选择边缺少实际输入');
   if(numeric(input.value)&&numeric(node.value)){if(input.value.value!==node.value.value||input.unit!==node.unit)throw Error('参数选择边的数量或单位不同');}
   else if(stableStringify(input.value)!==stableStringify(node.value)||input.unit!==node.unit)throw Error('参数选择边的类型或值不同');
  }
  nodes.set(node.id,node);
 }
 for(const root of graph.roots)if(root.nodeId&&!nodes.has(root.nodeId))throw Error('参数根指向不存在的节点');for(const choice of graph.candidates)if(choice.nodeId&&!nodes.has(choice.nodeId))throw Error('参数候选指向不存在的节点');if(graph.complete&&(graph.truncated||graph.boundaries.length||graph.roots.some(root=>!root.nodeId)))throw Error('不能把部分参数图标为完整');return graph;
}
