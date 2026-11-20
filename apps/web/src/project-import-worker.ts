import {z} from 'zod';
import {ProjectImportDocument,apiResponse} from '@model-analyser/contracts';
import {PROJECT_TEXT_BYTES,RECOVERY_ENVELOPE_BYTES} from '../../../packages/contracts/src/project-limits.js';
import {parseProjectText} from '../../../packages/contracts/src/project-text.js';
import {validateProjectRecovery} from '../../../packages/contracts/src/project-recovery.js';
import {request} from './api.js';
export type ProjectFileTask={taskId:string;file:File};
export const ProjectFileReply=z.strictObject({taskId:z.string(),reply:z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('decoded'),document:ProjectImportDocument}),z.strictObject({kind:z.literal('error'),message:z.string()})])});
export type ProjectFileReply=z.infer<typeof ProjectFileReply>;
export async function decodeProjectFile(file:File){
 if(file.size>RECOVERY_ENVELOPE_BYTES)throw Error('恢复封装超过256 MiB，未修改工作区');let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await file.arrayBuffer());}catch{throw Error('项目文件不是有效UTF-8，未修改原文件或工作区');}const format=/\.ya?ml$/i.test(file.name)?'yaml':'json';
 if(file.size>PROJECT_TEXT_BYTES){const value=parseProjectText(text,format,RECOVERY_ENVELOPE_BYTES);if(!value||typeof value!=='object'||!('documentType'in value)||value.documentType!=='project_recovery')throw Error('普通项目正文超过32 MiB，保留原文件');if('schemaVersion'in value&&value.schemaVersion!==1)throw Error('不支持恢复封装的schemaVersion，保留原文件');validateProjectRecovery(value);}
 const response=await fetch('/api/v1/decode-project-text?format='+format,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:text});
 if(response.status===404&&file.size<=PROJECT_TEXT_BYTES)return request('decode-project',ProjectImportDocument,{text,format});
 const envelope=apiResponse(ProjectImportDocument).parse(await response.json());if(!envelope.ok)throw Error(envelope.error.message);return envelope.data;
}
if(typeof self!=='undefined'&&typeof document==='undefined')self.onmessage=async(event:MessageEvent<ProjectFileTask>)=>{const {taskId,file}=event.data;try{self.postMessage({taskId,reply:{kind:'decoded',document:await decodeProjectFile(file)}});}catch(e){self.postMessage({taskId,reply:{kind:'error',message:e instanceof Error?e.message:'项目文件读取失败'}});}};
