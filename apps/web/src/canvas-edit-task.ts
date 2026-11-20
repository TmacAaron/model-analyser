import {CanvasEditReply,type CanvasEditTask} from './canvas-edit-worker.js';
/** Terminating before preparation completes never creates a draft or publishes a definition. */
export function runCanvasEditTask(task:CanvasEditTask,signal:AbortSignal):Promise<CanvasEditReply['reply']>{
 return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(Error('模型结构准备已取消'));return;}
  let worker:Worker|undefined,settled=false;
  const finish=()=>{settled=true;worker?.terminate();signal.removeEventListener('abort',cancel);};
  const fail=(message:string)=>{if(settled)return;finish();reject(Error(message));};
  const cancel=()=>fail('模型结构准备已取消');signal.addEventListener('abort',cancel,{once:true});
  try{
   worker=new Worker(new URL('./canvas-edit-worker.ts',import.meta.url),{type:'module'});
   worker.onmessage=(event:MessageEvent<unknown>)=>{if(settled||signal.aborted)return;const parsed=CanvasEditReply.safeParse(event.data);if(!parsed.success||parsed.data.taskId!==task.taskId){fail('模型结构准备返回了无效结果');return;}const reply=parsed.data.reply;if(reply.kind==='error'){fail(reply.message);return;}if(reply.kind!==(task.kind==='prepare'?'prepared':'references')){fail('模型结构准备返回了错误阶段');return;}finish();resolve(reply);};
   worker.onerror=()=>fail('模型结构准备失败，可重试');worker.postMessage(task);
  }catch{fail('无法启动模型结构准备，请重试');}
 });
}
