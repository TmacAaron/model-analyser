import {ProjectFileReply,type ProjectFileTask} from './project-import-worker.js';
export function readProjectFile(file:File,signal:AbortSignal){
 return new Promise<Extract<ProjectFileReply['reply'],{kind:'decoded'}>['document']>((resolve,reject)=>{
  if(signal.aborted){reject(Error('工作区读取已取消'));return;}const taskId=crypto.randomUUID();let worker:Worker|undefined,settled=false;
  const finish=()=>{settled=true;worker?.terminate();signal.removeEventListener('abort',cancel);},fail=(message:string)=>{if(settled)return;finish();reject(Error(message));},cancel=()=>fail('工作区读取已取消');signal.addEventListener('abort',cancel,{once:true});
  try{worker=new Worker(new URL('./project-import-worker.ts',import.meta.url),{type:'module'});worker.onmessage=(event:MessageEvent<unknown>)=>{if(settled||signal.aborted)return;try{const parsed=ProjectFileReply.safeParse(event.data);if(!parsed.success||parsed.data.taskId!==taskId){fail('工作区读取返回无效结果');return;}if(parsed.data.reply.kind==='error'){fail(parsed.data.reply.message);return;}finish();resolve(parsed.data.reply.document);}catch{fail('工作区读取结果无法解析');}};worker.onerror=()=>fail('工作区读取失败，可重新导入');const task:ProjectFileTask={taskId,file};worker.postMessage(task);}catch{fail('无法启动工作区文件读取，请重试');}
 });
}
