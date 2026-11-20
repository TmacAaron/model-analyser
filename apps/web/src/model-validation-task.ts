import {useEffect,useRef,useState} from 'react';
import {ModelValidationReply,type ModelValidationTask} from './model-validation-worker.js';
export type ModelValidationInput=ModelValidationTask extends infer T?T extends ModelValidationTask?Omit<T,'taskId'>:never:never;
export function runModelValidationTask(task:ModelValidationTask,signal:AbortSignal):Promise<ModelValidationReply['reply']>{
 return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(Error('模型校验已取消'));return;}
  let worker:Worker|undefined,settled=false;
  const finish=()=>{settled=true;worker?.terminate();signal.removeEventListener('abort',cancel);};
  const fail=(message:string)=>{if(settled)return;finish();reject(Error(message));};
  const cancel=()=>fail('模型校验已取消');signal.addEventListener('abort',cancel,{once:true});
  try{
   worker=new Worker(new URL('./model-validation-worker.ts',import.meta.url),{type:'module'});
   worker.onmessage=(event:MessageEvent<unknown>)=>{if(settled||signal.aborted)return;try{const parsed=ModelValidationReply.safeParse(event.data);if(!parsed.success||parsed.data.taskId!==task.taskId){fail('模型校验返回了无效结果');return;}const reply=parsed.data.reply;if(reply.kind==='error'){fail(reply.message);return;}const expected=task.kind==='config'?'asset':task.kind==='ascend'?'project':'validated';if(reply.kind!==expected){fail('模型校验返回了错误阶段');return;}finish();resolve(reply);}catch{fail('模型校验返回了无法读取的结果');}};
   worker.onerror=()=>fail('模型校验失败，可重试');worker.postMessage(task);
  }catch{fail('无法启动后台模型校验，请重试');}
 });
}
/** Exact inputs and job identity are checked before an awaited result reaches the caller. */
export function useModelValidation(key:string){
 const latest=useRef(key);latest.current=key;
 const active=useRef<{key:string;controller:AbortController}|null>(null),[state,setState]=useState<{key:string;pending:boolean}>();
 useEffect(()=>()=>{if(active.current?.key===key){active.current.controller.abort();active.current=null;}},[key]);
 async function run(input:ModelValidationInput){
  if(latest.current!==key)throw Error('输入已变化，请重新校验');active.current?.controller.abort();const job={key,controller:new AbortController()};active.current=job;setState({key,pending:true});
  try{const reply=await runModelValidationTask({...input,taskId:crypto.randomUUID()},job.controller.signal);if(latest.current!==key||active.current!==job||job.controller.signal.aborted)throw Error('输入已变化，未采用旧校验结果');return reply;}
  finally{if(active.current===job){active.current=null;setState({key,pending:false});}}
 }
 return {pending:state?.key===key&&state.pending,run,cancel:()=>{if(active.current?.key===key)active.current.controller.abort();}};
}
