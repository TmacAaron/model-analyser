import { z } from 'zod';
import { apiResponse,AssetDocument,AssetDraft,ProjectDraft,ReadDraftRequest,AssetIndexEntry,SaveDraftResponse,CommitResponse,ProjectDocument,ReadProjectRequest } from '@model-analyser/contracts';
export class ApiFailure extends Error {constructor(readonly code:string,message:string){super(message);}}
export async function request<T extends z.ZodType>(path:string,schema:T,body?:unknown,options?:{signal:AbortSignal}):Promise<z.infer<T>> {
  const response=await fetch('/api/v1/'+path,{...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),...(options?{signal:options.signal}:{})});
  const parsed=apiResponse(z.unknown()).parse(await response.json() as unknown);
  if(!parsed.ok)throw new ApiFailure(parsed.error.code,parsed.error.message+(parsed.error.fieldIssues.length?'：'+parsed.error.fieldIssues.map(i=>`${i.path} ${i.message}`).join('; '):''));
  return schema.parse(parsed.data);
}
export const listAssets=(archived=false)=>request('assets?archived='+archived,z.array(AssetIndexEntry));
export const getAsset=(id:string,revision?:number)=>request('asset?id='+encodeURIComponent(id)+(revision===undefined?'':'&revision='+revision),AssetDocument);
export const listDrafts=()=>request('drafts',z.array(AssetDraft));
export const getAssetDraft=(draftId:string)=>request('asset-draft',AssetDraft,ReadDraftRequest.parse({draftId}));
export const getProjectDraft=(draftId:string,options?:{signal:AbortSignal})=>request('project-draft',ProjectDraft,ReadDraftRequest.parse({draftId}),options);
export const draftResponse=SaveDraftResponse;
export const commitResponse=CommitResponse;
/** Read only this identity; never download every project/draft to find one ID. */
export async function lookupProject(projectId:string,options?:{signal:AbortSignal}){
  try{return await request('project',ProjectDocument,ReadProjectRequest.parse({projectId}),options);}
  catch(e){if(e instanceof ApiFailure&&e.code==='not_found')return null;throw e;}
}
