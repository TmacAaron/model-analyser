import { useEffect,useRef,useState } from 'react';
import { FusionReply,type FusionTask } from './fusion-worker.js';
/** Changing inputs or selection invalidates running work before its callback can mutate a configuration. */
export function useFusionTask(key:string){
  const active=useRef<Worker|null>(null),latest=useRef(key);latest.current=key;
  const [state,setState]=useState<{key:string;pending?:boolean;reply?:FusionReply;error?:string;cancelled?:boolean}>();
  function cancel(){active.current?.terminate();active.current=null;setState({key,cancelled:true});}
  function run(request:FusionTask,onSuccess?:(reply:FusionReply)=>void){
    active.current?.terminate();let instance:Worker|undefined;
    try{instance=new Worker(new URL('./fusion-worker.ts',import.meta.url),{type:'module'});active.current=instance;setState({key,pending:true});const current=()=>active.current===instance&&latest.current===key;
      instance.onmessage=(event:MessageEvent<unknown>)=>{if(!current())return;const parsed=FusionReply.safeParse(event.data);instance?.terminate();active.current=null;if(!parsed.success){setState({key,error:'融合线程返回了无效结果'});return;}const reply=parsed.data;setState(reply.kind==='error'?{key,error:reply.message}:{key,reply});if(reply.kind!=='error')try{onSuccess?.(reply);}catch(e){setState({key,error:e instanceof Error?e.message:'当前工作区已变化，未应用融合结果'});}};
      instance.onerror=()=>{if(!current())return;instance?.terminate();active.current=null;setState({key,error:'融合计算失败，可重试或缩小选择范围'});};instance.postMessage(request);
    }catch{instance?.terminate();active.current=null;setState({key,error:'无法启动融合计算，请重试'});}
  }
  useEffect(()=>()=>{active.current?.terminate();active.current=null;},[key]);
  return {...(state?.key===key?state:{}),run,cancel};
}
