import type {AssetDocument,Scenario,Quantity,NodeId} from '@model-analyser/contracts';
import {jsonBytes} from '../../contracts/src/json-size.js';
import {bindParameters} from './parameters.js';
import type {ParameterFrame,ParameterObservation,ParameterCaptureTrace} from './parameter-observation.js';
import {assetParameterFrameId,workloadParameterFrameId} from './parameter-observation.js';
/** Capture selected scopes and their actual ancestors; unknown frames stay boundaries. */
export class ParameterCapture{
 private snapshots=new WeakMap<object,Record<string,Quantity>>();private ids=new WeakMap<object,string>();private frames:ParameterFrame[]=[];private bytes=0;private events=0;private truncated=false;
 constructor(private selected:string,private additional:readonly string[]=[]){}
 private wanted(path:string){const contains=(node:string)=>node===path||node.startsWith(path+'/')||node.startsWith(path+'[');return path==='$model'||contains(this.selected)||this.additional.some(contains);}
 private spend(value:unknown){try{this.bytes+=jsonBytes(value,16*1024*1024-this.bytes);return true;}catch{this.truncated=true;return false;}}
 private add(frame:ParameterFrame){if(this.frames.length>=128||!this.spend(frame)){this.truncated=true;return undefined;}this.frames.push(frame);return frame;}
 workload(symbols:Record<string,Quantity>){const id=workloadParameterFrameId();this.ids.set(symbols,id);this.add({id,nodeId:'$workload',kind:'workload',symbols:structuredClone(symbols),events:[]});}
 repeat(symbols:Record<string,Quantity>,parent:Record<string,Quantity>,path:string,axis:string,index:number){const id=JSON.stringify(['repeat',path,axis]);this.ids.set(symbols,id);if(this.wanted(path)){const parentId=this.ids.get(parent),quantity=symbols[axis];this.add({id,nodeId:path,kind:'repeat',...(parentId?{parent:parentId}:{}),axis,index,symbols:quantity?{[axis]:structuredClone(quantity)}:{},events:[]});}}
 bind(asset:AssetDocument,bindings:Scenario['bindings'],parent:Record<string,Quantity>,assets:AssetDocument[],scenario:Scenario,nodeId:NodeId,root=false){
  const id=assetParameterFrameId(nodeId),parentId=this.ids.get(parent),frame=this.wanted(nodeId)?this.add({id,nodeId,kind:'asset',...(parentId?{parent:parentId}:{}),asset:{assetId:asset.assetId,revision:asset.revision,kind:asset.definition.kind},name:asset.name,symbols:{},events:[]}):undefined;
  const observe=frame?(event:ParameterObservation)=>{if(this.events>=2048||!this.spend(event)){this.truncated=true;return false;}this.events++;frame.events.push(event);return true;}:undefined;
  const result=bindParameters(asset,bindings,parent,assets,scenario,nodeId,root,observe);this.ids.set(result.symbols,id);
  if(this.wanted(nodeId)){const entries:[string,Quantity][]=[];for(const parameter of result.parameters){const value=parameter.value;if(value.kind==='integer'||value.kind==='number')entries.push([parameter.parameterKey,{value:value.value,unit:parameter.unit}]);}const captured=Object.fromEntries(entries);this.snapshots.set(result.symbols,captured);if(frame&&this.spend(captured))frame.symbols=structuredClone(captured);}
  return result;
 }
 symbolsSnapshot(symbols:Record<string,Quantity>){return this.snapshots.get(symbols)??symbols;}
 frame(symbols:Record<string,Quantity>){return this.ids.get(symbols);}
 snapshot():ParameterCaptureTrace{return structuredClone({frames:this.frames,truncated:this.truncated});}
}
