import {runProjectTextTask} from './project-text-task.js';
import { ProjectDocument,ProjectDraft,SaveProjectDraftResponse,SaveProjectResponse } from '@model-analyser/contracts';
import { request } from './api.js';
import { SerializedAutosaver,type SaveState } from './serialized-autosave.js';
export class ProjectAutosaver extends SerializedAutosaver<ProjectDocument,ProjectDraft> {
  constructor(draft:ProjectDraft,notify:(state:SaveState)=>void,committed:(project:ProjectDocument,source:string|undefined)=>void){
    super(draft.draftGeneration,draft.baseProjectRevision,{
      parseCandidate:text=>text,
      createDraft:(candidate,baseProjectRevision,draftGeneration)=>ProjectDraft.parse({...draft,baseProjectRevision,draftGeneration,updatedAt:new Date().toISOString(),candidate}),
      validate:async(candidate,signal)=>{if(typeof candidate!=='string')throw Error('项目草稿缺少原始正文');const reply=await runProjectTextTask({taskId:crypto.randomUUID(),kind:'validate',text:candidate,format:draft.editorFormat??'json'},signal);if(reply.kind!=='validated')throw Error('项目正文返回错误校验阶段');return reply.issue;},
      writeDraft:async(draft,requestId)=>{const saved=await request('project-drafts',SaveProjectDraftResponse,{requestId,draft});if(saved.requestId!==requestId||saved.draft.draftGeneration!==draft.draftGeneration)throw Error('项目草稿响应 ID/代次不匹配');},
      commitDraft:async(draft,requestId)=>{const result=await request('commit-project-draft',SaveProjectResponse,{requestId,draftId:draft.draftId,draftGeneration:draft.draftGeneration,expectedRevision:draft.baseProjectRevision});if(result.requestId!==requestId||result.project.projectId!==draft.projectId)throw Error('项目提交响应 ID 不匹配');return {document:result.project,revision:result.project.projectRevision};},
    },notify,(project,attempt)=>committed(project,typeof attempt.candidate==='string'?attempt.candidate:undefined));
  }
}
