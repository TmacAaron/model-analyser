import { instantiateModel } from '@model-analyser/core';
import type { Scenario,AssetDocument,InstantiationResult } from '@model-analyser/contracts';
import {projectCanvasView,type CanvasView,type CanvasProjection} from './canvas-projection.js';

export type ModelInstantiationRequest=
  |{kind:'instantiate';scenario:Scenario;assets:AssetDocument[];view?:CanvasView}
  |{kind:'project';view:CanvasView};
export type ModelInstantiationReply=
  |{kind:'instantiated';attempt:InstantiationResult;projection?:CanvasProjection}
  |{kind:'projected';projection:CanvasProjection};

const endpoint=globalThis as unknown as {onmessage:((event:MessageEvent<ModelInstantiationRequest>)=>void)|null;postMessage:(reply:ModelInstantiationReply)=>void};
let canvasInput:{resolved:Extract<InstantiationResult,{status:'available'}>['resolved'];scenario:Scenario}|undefined;
endpoint.onmessage=({data:request})=>{
  if(request.kind==='instantiate'){
    const attempt=instantiateModel(request.scenario,request.assets),view=request.view;
    canvasInput=view&&attempt.status==='available'?{resolved:attempt.resolved,scenario:request.scenario}:undefined;
    const projection=canvasInput&&view?projectCanvasView(canvasInput.resolved,canvasInput.scenario,view):undefined;
    endpoint.postMessage({kind:'instantiated',attempt,...(projection?{projection}:{})});
  }else{
    if(!canvasInput)throw Error('画布缺少实际模型结构');
    endpoint.postMessage({kind:'projected',projection:projectCanvasView(canvasInput.resolved,canvasInput.scenario,request.view)});
  }
};
