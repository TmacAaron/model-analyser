import {randomUUID} from 'node:crypto';
import {Id,ProjectDocument,ProjectRecoveryDocument} from '@model-analyser/contracts';
import {validateProject} from '../../../packages/contracts/src/validation.js';
import {validateProjectRecovery} from '../../../packages/contracts/src/project-recovery.js';
import {jsonBytes} from '../../../packages/contracts/src/json-size.js';
import {PROJECT_TEXT_BYTES,RECOVERY_ENVELOPE_BYTES} from '../../../packages/contracts/src/project-limits.js';
import {StoreError} from './documents.js';
import {assertVersion} from './scan.js';
import {parseProjectText} from '../../../packages/contracts/src/project-text.js';
export function decodeProjectImport(text:string,format:'json'|'yaml'){
 const bytes=Buffer.byteLength(text);if(bytes>RECOVERY_ENVELOPE_BYTES)throw new StoreError('validation','恢复封装超过256 MiB，保留原文件');
 const recover=(projectId:string)=>({document:ProjectRecoveryDocument.parse({documentType:'project_recovery',schemaVersion:1,status:'draft',projectId,baseProjectRevision:null,formalProject:null,editorText:text,editorFormat:format}),ordinaryRecovery:true});
 let value:unknown;try{value=parseProjectText(text,format,RECOVERY_ENVELOPE_BYTES);}catch{if(bytes>PROJECT_TEXT_BYTES)throw new StoreError('validation','普通项目正文超过32 MiB，未识别为恢复封装');return recover(randomUUID());}
 assertVersion(value);
 const record=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
 if(record?.documentType==='project_recovery'){try{return {document:validateProjectRecovery(value),ordinaryRecovery:false};}catch(e){throw new StoreError('validation',e instanceof Error?e.message:'恢复文件无效，保留原文件');}}
 if(bytes>PROJECT_TEXT_BYTES)throw new StoreError('validation','普通项目正文超过32 MiB，保留原文件');
 if(record?.documentType!=='project'||record.schemaVersion!==1)throw new StoreError('validation','文件不是受支持的项目或恢复文件');
 const id=Id.safeParse(record.projectId),recovery=()=>recover(id.success?id.data:randomUUID());
 try{jsonBytes(value,PROJECT_TEXT_BYTES-1,true);const parsed=ProjectDocument.safeParse(value);if(parsed.success&&!validateProject(parsed.data).some(d=>d.severity==='error'))return {document:parsed.data,ordinaryRecovery:false};}catch{/* Resource/shape errors in an identified v1 document retain its exact source. */}
 return recovery();
}
