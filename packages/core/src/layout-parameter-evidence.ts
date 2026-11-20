import type {AssetDocument,NodeId,Scenario,DecodeStepContext} from '@model-analyser/contracts';
import {instantiateModel} from './instantiate.js';
import type {ValueEvaluationProof} from './formula.js';
import {layoutParameterBindingGraph,type AdditionalParameterRoot} from './parameter-binding-graph.js';
import {assetParameterFrameId,workloadParameterFrameId,type ParameterCaptureTrace} from './parameter-observation.js';

export type LayoutFrame={kind:'asset';nodeId:NodeId}|{kind:'workload'};
export type LayoutBindingRead=AdditionalParameterRoot&{frame?:LayoutFrame};

export function layoutBindingReads(proof:ValueEvaluationProof,field:string,frameFor:(symbol:string)=>LayoutFrame|undefined){
 const parts=new Map<string,LayoutBindingRead>();
 function visit(node:ValueEvaluationProof){
  if(node.kind==='symbol'&&node.symbol&&node.quantity){
   const name=node.symbol,frame=frameFor(name);
   const frameId=frame?.kind==='asset'?assetParameterFrameId(frame.nodeId):frame?.kind==='workload'?workloadParameterFrameId():'unrecorded-layout-frame';
   parts.set(JSON.stringify([frameId,name]),{name,quantity:node.quantity,target:field,frameId,...(frame?{frame}:{})});
  }
  for(const binding of node.bindings??[])if(binding.proof)visit(binding.proof);
 }
 visit(proof);
 return [...parts.values()];
}

export function captureLayoutBindings(scenario:Scenario,assets:AssetDocument[],stepContext:DecodeStepContext|undefined,reads:readonly LayoutBindingRead[]){
 const nodes=[...new Set(reads.flatMap(read=>read.frame?.kind==='asset'?[read.frame.nodeId]:[]))];
 const traces:ParameterCaptureTrace[]=[];
 const expanded=instantiateModel(scenario,assets,undefined,stepContext,{
  nodeId:nodes[0]??'$model',bindingNodes:nodes.slice(1),bindings:true,bindingTraceReady:trace=>traces.push(trace),
 });
 const trace=traces[0];
 if(expanded.status!=='available'||!trace||traces.length!==1)throw Error('未能捕获原算式的实际参数绑定');
 return layoutParameterBindingGraph(trace,assets,reads);
}
