import {z} from 'zod';
import {Id,ProjectDocument,Scenario} from '@model-analyser/contracts';
import {parseProjectText,rewriteProjectTextIdentity} from '../../../packages/contracts/src/project-text.js';
// Empty display names remain editable; the formal validation below still requires them.
export const ProjectEditorValue=ProjectDocument.extend({name:z.string(),scenarios:z.array(Scenario.extend({name:z.string()}))});
export type ProjectTextTask={taskId:string;text:string;format:'json'|'yaml'}&({kind:'preview'}|{kind:'validate'}|{kind:'identity';projectId:string});
// The dedicated worker performs the full schema traversal. The receiving boundary
// checks the envelope/identity and top-level shape without repeating that traversal.
const PreviewProject=z.custom<ProjectDocument>(value=>{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;return v['documentType']==='project'&&v['schemaVersion']===1&&Id.safeParse(v['projectId']).success&&Array.isArray(v['scenarios'])&&Array.isArray(v['assetSnapshots'])&&Array.isArray(v['measurements'])&&!!v['viewState']&&typeof v['viewState']==='object';
});
export const ProjectTextReply=z.strictObject({taskId:z.string(),reply:z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('preview'),project:PreviewProject.optional(),header:z.strictObject({isProjectV1:z.boolean(),projectId:Id.optional()}),issues:z.array(z.string()).max(6)}),
 z.strictObject({kind:z.literal('validated'),issue:z.string().optional()}),
 z.strictObject({kind:z.literal('identity'),text:z.string()}),
 z.strictObject({kind:z.literal('error'),message:z.string()})
])});
export type ProjectTextReply=z.infer<typeof ProjectTextReply>;
export type ProjectTextPreview=Extract<ProjectTextReply['reply'],{kind:'preview'}>;
export function evaluateProjectTextTask(task:ProjectTextTask):ProjectTextReply{
 try{
  if(task.kind==='identity')return {taskId:task.taskId,reply:{kind:'identity',text:rewriteProjectTextIdentity(task.text,task.format,task.projectId)}};
  let value:unknown;try{value=parseProjectText(task.text,task.format);}catch(e){const issue=e instanceof Error?e.message:'正文无法解析';return {taskId:task.taskId,reply:task.kind==='validate'?{kind:'validated',issue}:{kind:'preview',header:{isProjectV1:false},issues:[issue]}};}
  if(task.kind==='validate'){const parsed=ProjectDocument.safeParse(value);return {taskId:task.taskId,reply:{kind:'validated',...(parsed.success?{}:{issue:parsed.error.issues.slice(0,3).map(i=>i.path.join('.')+' '+i.message).join('；')})}};}
  const record=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined,id=Id.safeParse(record?.['projectId']),parsed=ProjectEditorValue.safeParse(value);
  return {taskId:task.taskId,reply:{kind:'preview',header:{isProjectV1:record?.['documentType']==='project'&&record['schemaVersion']===1,...(id.success?{projectId:id.data}:{})},...(parsed.success?{project:parsed.data}:{}),issues:parsed.success?[]:parsed.error.issues.slice(0,6).map(i=>i.path.join('.')+' '+i.message)}};
 }catch(e){return {taskId:task.taskId,reply:{kind:'error',message:e instanceof Error?e.message:'正文校验失败'}};}
}
if(typeof self!=='undefined'&&typeof document==='undefined')self.onmessage=(event:MessageEvent<ProjectTextTask>)=>self.postMessage(evaluateProjectTextTask(event.data));
