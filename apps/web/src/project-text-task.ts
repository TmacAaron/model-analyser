import {useEffect,useRef,useState} from 'react';
import {ProjectTextReply,type ProjectTextTask,type ProjectTextPreview} from './project-text-worker.js';
import type {ProjectDocument} from '@model-analyser/contracts';
export async function runProjectTextTask(task:ProjectTextTask,signal:AbortSignal):Promise<ProjectTextReply['reply']>{
 return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(Error('正文校验已取消'));return;}let worker:Worker|undefined,settled=false;
  const finish=()=>{settled=true;worker?.terminate();signal.removeEventListener('abort',cancel);},fail=(message:string)=>{if(settled)return;finish();reject(Error(message));},cancel=()=>fail('正文校验已取消');signal.addEventListener('abort',cancel,{once:true});
  try{worker=new Worker(new URL('./project-text-worker.ts',import.meta.url),{type:'module'});worker.onmessage=(event:MessageEvent<unknown>)=>{if(settled||signal.aborted)return;try{const parsed=ProjectTextReply.safeParse(event.data);if(!parsed.success||parsed.data.taskId!==task.taskId){fail('正文校验返回无效结果');return;}const reply=parsed.data.reply;if(reply.kind==='error'){fail(reply.message);return;}const expected=task.kind==='validate'?'validated':task.kind;if(reply.kind!==expected){fail('正文校验返回错误阶段');return;}if(reply.kind==='preview'&&reply.project&&reply.project.projectId!==reply.header.projectId){fail('正文校验返回了不同项目身份');return;}finish();resolve(reply);}catch{fail('正文校验返回无法读取的结果');}};worker.onerror=()=>fail('后台正文校验失败，可重试');worker.postMessage(task);}catch{fail('无法启动后台正文校验，可重试');}
 });
}
export type KnownProjectText={text:string;format:'json'|'yaml';session:number;project:ProjectDocument};
type Input={text:string;format:'json'|'yaml';session:number};
const same=(a:Input,b:Input)=>a.text===b.text&&a.format===b.format&&a.session===b.session;
export function useProjectTextPreview(text:string,format:'json'|'yaml',session:number,known:KnownProjectText|null){
 const input={text,format,session},latest=useRef(input);latest.current=input;const seeded=known&&same(known,input)?known.project:undefined,previous=useRef<{session:number;format:'json'|'yaml';project:ProjectDocument}|undefined>(undefined);
 const active=useRef<{input:Input;controller:AbortController}|null>(null),[retry,setRetry]=useState(0),[state,setState]=useState<{input:Input;status:'pending'|'ready'|'canceled'|'error';reply?:ProjectTextPreview;message?:string}>();
 useEffect(()=>{
  if((!text&&session===0)||seeded)return;const job={input:{text,format,session},controller:new AbortController()};active.current?.controller.abort();active.current=job;setState({input:job.input,status:'pending'});
  void runProjectTextTask({taskId:crypto.randomUUID(),kind:'preview',text,format},job.controller.signal).then(reply=>{if(job.controller.signal.aborted||active.current!==job||!same(latest.current,job.input))return;if(reply.kind!=='preview')throw Error('正文预览返回错误阶段');setState({input:job.input,status:'ready',reply});}).catch(e=>{if(job.controller.signal.aborted||active.current!==job||!same(latest.current,job.input))return;setState({input:job.input,status:'error',message:e instanceof Error?e.message:'正文预览失败'});}).finally(()=>{if(active.current===job)active.current=null;});
  return()=>{job.controller.abort();if(active.current===job)active.current=null;};
 },[text,format,session,seeded,retry]);
 const current=state&&same(state.input,input)?state:undefined,reply:ProjectTextPreview|undefined=seeded?{kind:'preview',project:seeded,header:{isProjectV1:true,projectId:seeded.projectId},issues:[]}:current?.reply;
 const status=seeded||(!text&&session===0)?'ready' as const:current?.status??'pending';if(reply?.project)previous.current={session,format,project:reply.project};
 const pendingProject=status==='pending'&&previous.current?.session===session&&previous.current.format===format?previous.current.project:undefined;
 return {project:reply?.project,pendingProject,header:reply?.header,issues:reply?.issues??[],status,message:current?.message,cancel:()=>{if(active.current&&same(active.current.input,input)){active.current.controller.abort();active.current=null;setState({input,status:'canceled'});}},retry:()=>setRetry(n=>n+1)};
}
