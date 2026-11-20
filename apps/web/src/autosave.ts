import { AssetDocument,AssetDraft } from '@model-analyser/contracts';
import { request,draftResponse,commitResponse } from './api.js';
import { SerializedAutosaver,type SaveState } from './serialized-autosave.js';
export type {SaveState} from './serialized-autosave.js';
export class Autosaver extends SerializedAutosaver<AssetDocument,AssetDraft> {
  constructor(draft:AssetDraft,notify:(state:SaveState)=>void,committed:(asset:AssetDocument)=>void){
    const {importIntent,...envelope}=draft;let pendingImport=importIntent;
    super(draft.draftGeneration,draft.baseRevision,{
      createDraft:(candidate,baseRevision,draftGeneration)=>AssetDraft.parse({...envelope,baseRevision,draftGeneration,updatedAt:new Date().toISOString(),candidate,...(pendingImport?{importIntent:pendingImport}:{})}),
      validate:(candidate)=>{const parsed=AssetDocument.safeParse(candidate);return parsed.success?undefined:parsed.error.issues.slice(0,3).map(i=>i.path.join('.')+' '+i.message).join('；');},
      writeDraft:async(draft,requestId)=>{const saved=await request('drafts',draftResponse,{requestId,draft});if(saved.requestId!==requestId||saved.draft.draftGeneration!==draft.draftGeneration)throw Error('响应 ID/代次不匹配');},
      commitDraft:async(draft,requestId)=>{const result=await request('commit',commitResponse,{requestId,draftId:draft.draftId,draftGeneration:draft.draftGeneration,expectedRevision:draft.baseRevision});if(result.requestId!==requestId||result.asset.assetId!==draft.assetId)throw Error('提交响应 ID 不匹配');pendingImport=undefined;return {document:result.asset,revision:result.headRevision??result.asset.revision,savedRevision:result.asset.revision};},
    },notify,committed);
  }
}
