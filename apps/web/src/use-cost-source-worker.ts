import {useEffect,useRef,useState} from 'react';

type Task<Request>={taskId:string;phase:string;request:Request};
type State<Report>={status:'running'|'cancelled'}|{status:'error';message:string}|{status:'available';report:Report};

export function useCostSourceWorker<Request,Report>(open:boolean,request:Request|undefined,phase:string,readReply:(value:unknown,task:Task<Request>)=>State<Report>){
 const worker=useRef<Worker|null>(null),owner=useRef(request);
 owner.current=request;
 const [retry,setRetry]=useState(0);
 const [saved,setSaved]=useState<{owner:typeof request;state:State<Report>}>({owner:request,state:{status:'running'}});
 const state:State<Report>=saved.owner===request?saved.state:{status:'running'};
 useEffect(()=>{
  if(!open||!request)return;
  setSaved({owner:request,state:{status:'running'}});
  const task={taskId:crypto.randomUUID(),phase,request};
  let active:Worker|undefined;
  function finish(next:State<Report>){
   if(worker.current!==active||owner.current!==request)return;
   setSaved({owner:request,state:next});active?.terminate();worker.current=null;
  }
  try{
   active=new Worker(new URL('./leaf-cost-source-worker.ts',import.meta.url),{type:'module'});
   worker.current=active;
   active.onmessage=(message:MessageEvent<unknown>)=>{
    try{finish(readReply(message.data,task));}
    catch(error){finish({status:'error',message:error instanceof Error?error.message:'来源回复有误'});}
   };
   active.onerror=()=>finish({status:'error',message:'来源后台任务失败'});
   active.postMessage(task);
  }catch(error){
   active?.terminate();worker.current=null;
   setSaved({owner:request,state:{status:'error',message:error instanceof Error?error.message:'无法启动来源任务'}});
  }
  return ()=>{active?.terminate();if(worker.current===active)worker.current=null;};
 },[open,request,phase,readReply,retry]);
 return {state,retry:()=>setRetry(value=>value+1),cancel:()=>{worker.current?.terminate();worker.current=null;setSaved({owner:request,state:{status:'cancelled'}});}};
}
