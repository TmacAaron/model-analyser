import {useEffect,useRef,useState} from 'react';
import type {AssetDocument,InstantiationResult,Scenario} from '@model-analyser/contracts';
import type {CanvasProjection,CanvasView} from './canvas-projection.js';
import type {ModelInstantiationRequest} from './model-instantiation-worker.js';

type Snapshot={key:string;run:number;attempt?:InstantiationResult;projection?:CanvasProjection;error?:string;cancelled?:boolean};
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);

// instantiateModel validates the complete contract in the worker. Check the
// transport shape here without walking and copying every expanded node again.
function isAttempt(value:unknown):value is InstantiationResult{
  if(!record(value)||!Array.isArray(value.diagnostics))return false;
  if(value.status==='unavailable')return value.diagnostics.length>0;
  const resolved=value.resolved;
  if(value.status!=='available'||!record(resolved)||!record(resolved.graph))return false;
  const {graph}=resolved;
  return (resolved.phase==='prefill'||resolved.phase==='decode')&&
    ['nodes','edges','dependencies','inputs','outputs','tensors','storages','states'].every(key=>Array.isArray(graph[key]))&&
    ['containers','parameters','assetRefs','objectBindings','quantizationApplications','fusionApplications'].every(key=>Array.isArray(resolved[key]));
}

function isProjection(value:unknown):value is CanvasProjection{
  return record(value)&&record(value.view)&&typeof value.view.scope==='string'&&typeof value.view.expandOperatorCalls==='boolean'&&
    record(value.graph)&&Array.isArray(value.graph.nodes)&&Array.isArray(value.graph.edges)&&record(value.defaultPositions);
}

const viewIdentity=(view:CanvasView)=>JSON.stringify([view.scope,view.expandOperatorCalls]);

/** A worker belongs to one fixed expansion. It can project subsequent scopes from that same resolved graph. */
export function useModelInstantiation(scenario:Scenario|undefined,assets:AssetDocument[]|undefined,key:string,view?:CanvasView){
  const [snapshot,setSnapshot]=useState<Snapshot>(),[run,setRun]=useState(0),active=useRef<Worker|null>(null);
  const viewKey=view&&viewIdentity(view),latest=useRef({key,run,view,viewKey});latest.current={key,run,view,viewKey};
  useEffect(()=>{
    if(!scenario||!assets)return;
    let worker:Worker|undefined,expanded=false;
    const current=()=>worker!==undefined&&active.current===worker&&latest.current.key===key&&latest.current.run===run;
    const finish=()=>{worker?.terminate();if(active.current===worker)active.current=null;};
    const fail=(error:string)=>{
      finish();
      setSnapshot(previous=>previous?.key===key&&previous.run===run?{...previous,error}:{key,run,error});
    };
    try{
      worker=new Worker(new URL('./model-instantiation-worker.ts',import.meta.url),{type:'module'});
      active.current=worker;
      worker.onmessage=({data}:MessageEvent<unknown>)=>{
        if(!current())return;
        if(record(data)&&data.kind==='instantiated'&&!expanded&&isAttempt(data.attempt)){
          const attempt=data.attempt;
          if(initialView&&attempt.status==='available'&&!isProjection(data.projection)){
            fail('画布结果无效，请重新准备');return;
          }
          expanded=true;
          const projection=isProjection(data.projection)&&viewIdentity(data.projection.view)===latest.current.viewKey?data.projection:undefined;
          setSnapshot({key,run,attempt,...(projection?{projection}:{})});
          if(!initialView||attempt.status==='unavailable')finish();
        }else if(record(data)&&data.kind==='projected'&&expanded&&isProjection(data.projection)){
          const projection=data.projection;
          if(viewIdentity(projection.view)!==latest.current.viewKey)return;
          setSnapshot(previous=>previous?.key===key&&previous.run===run?{...previous,projection}:previous);
        }else fail('模型结构结果无效，请重新展开');
      };
      worker.onerror=()=>{if(current())fail(expanded?'画布准备失败，请重新准备':'模型结构展开失败，请重新展开或检查定义');};
      worker.onmessageerror=()=>{if(current())fail('模型结构结果无法读取，请重试');};
      const initialView=latest.current.view;
      worker.postMessage({kind:'instantiate',scenario,assets,...(initialView?{view:initialView}:{})} satisfies ModelInstantiationRequest);
    }catch{fail('无法启动结构展开，请重试');}
    return finish;
  },[key,run]);

  const current=snapshot?.key===key&&snapshot.run===run?snapshot:undefined;
  const projection=current?.projection&&viewIdentity(current.projection.view)===viewKey?current.projection:undefined;
  useEffect(()=>{
    const scope=latest.current.view,worker=active.current;
    if(!scope||!worker||current?.attempt?.status!=='available'||projection||current.error)return;
    try{worker.postMessage({kind:'project',view:scope} satisfies ModelInstantiationRequest);}
    catch{worker.terminate();active.current=null;setSnapshot({...current,error:'无法准备画布，请重试'});}
  },[key,run,viewKey,current?.attempt,projection,current?.error]);

  return {attempt:current?.attempt,projection,pending:!!scenario&&!!assets&&!current,error:current?.error,cancelled:current?.cancelled??false,
    cancel:()=>{active.current?.terminate();active.current=null;setSnapshot({key,run,cancelled:true});},retry:()=>setRun(value=>value+1)};
}
