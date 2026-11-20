import {ProjectDraft,ProjectRecoveryDocument} from './index.js';
import {jsonBytes} from './json-size.js';
import {PROJECT_DRAFT_BYTES,LEGACY_PROJECT_DRAFT_BYTES,PROJECT_METADATA_BYTES,PROJECT_TEXT_BYTES,RECOVERY_EDITOR_BYTES,RECOVERY_ENVELOPE_BYTES,utf8Bytes} from './project-limits.js';
export function validateProjectDraftSize(draft:ProjectDraft){
 const {candidate,...metadata}=draft;jsonBytes(metadata,PROJECT_METADATA_BYTES);if(typeof candidate==='string'&&utf8Bytes(candidate)>RECOVERY_EDITOR_BYTES)throw Error('项目草稿正文超过64 MiB，原文仍可导出');jsonBytes(draft,(typeof candidate==='string'?PROJECT_DRAFT_BYTES:LEGACY_PROJECT_DRAFT_BYTES)-1,true);
}
export function validateProjectRecovery(value:unknown){
 jsonBytes(value,RECOVERY_ENVELOPE_BYTES);const recovery=ProjectRecoveryDocument.parse(value),{editorText,formalProject,...metadata}=recovery;
 if(utf8Bytes(editorText)>RECOVERY_EDITOR_BYTES)throw Error('恢复正文超过64 MiB，保留原文件');jsonBytes(metadata,PROJECT_METADATA_BYTES);
 if(formalProject){if(formalProject.projectId!==recovery.projectId)throw Error('恢复文件与正式项目身份不符');jsonBytes(formalProject,PROJECT_TEXT_BYTES-1,true);}
 // Preflight the largest generated draft header before any baseline restoration or write.
 validateProjectDraftSize(ProjectDraft.parse({documentType:'project_draft',schemaVersion:1,draftId:'00000000-0000-4000-8000-000000000000',projectId:recovery.projectId,baseProjectRevision:Number.MAX_SAFE_INTEGER,draftGeneration:Number.MAX_SAFE_INTEGER,updatedAt:'2000-01-01T00:00:00.000Z',candidate:editorText,editorFormat:recovery.editorFormat??'json'}));return recovery;
}
export function serializeProjectRecovery(value:unknown){const recovery=validateProjectRecovery(value);try{jsonBytes(recovery,PROJECT_TEXT_BYTES,true);return JSON.stringify(recovery,null,2);}catch{return JSON.stringify(recovery);}}
