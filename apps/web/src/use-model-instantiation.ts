import { useEffect,useRef,useState } from 'react';
import { InstantiationResult,type Scenario,type AssetDocument } from '@model-analyser/contracts';
import type { ModelInstantiationRequest } from './model-instantiation-worker.js';
type Snapshot={key:string;run:number;attempt?:InstantiationResult;error?:string;cancelled?:boolean};

/** A result belongs to its exact input/run; terminated jobs cannot replace later edits. */
export function useModelInstantiation(scenario:Scenario|undefined,assets:AssetDocument[]|undefined,key:string){
  const [snapshot,setSnapshot]=useState<Snapshot>(),[run,setRun]=useState(0),active=useRef<Worker|null>(null),latest=useRef({key,run});latest.current={key,run};
  useEffect(()=>{
    if(!scenario||!assets)return;let instance:Worker|undefined;const current=()=>active.current===instance&&latest.current.key===key&&latest.current.run===run;
    const finish=()=>{instance?.terminate();if(active.current===instance)active.current=null;};
    try{instance=new Worker(new URL('./model-instantiation-worker.ts',import.meta.url),{type:'module'});active.current=instance;instance.onmessage=(event:MessageEvent<unknown>)=>{if(!current())return;const parsed=InstantiationResult.safeParse(event.data);setSnapshot(parsed.success?{key,run,attempt:parsed.data}:{key,run,error:'模型结构结果无效，请重新展开'});finish();};instance.onerror=()=>{if(!current())return;setSnapshot({key,run,error:'模型结构展开失败，请重新展开或检查定义'});finish();};const request:ModelInstantiationRequest={scenario,assets};instance.postMessage(request);}catch{active.current?.terminate();active.current=null;setSnapshot({key,run,error:'无法启动结构展开，请重试'});}
    return()=>{instance?.terminate();if(active.current===instance)active.current=null;};
  },[key,run]);
  const current=snapshot?.key===key&&snapshot.run===run?snapshot:undefined;
  return {attempt:current?.attempt,pending:!!scenario&&!!assets&&!current,error:current?.error,cancelled:current?.cancelled??false,cancel:()=>{active.current?.terminate();active.current=null;setSnapshot({key,run,cancelled:true});},retry:()=>setRun(value=>value+1)};
}
