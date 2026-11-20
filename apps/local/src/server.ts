import {PROJECT_DRAFT_REQUEST_BYTES,PROJECT_IMPORT_REQUEST_BYTES} from '../../../packages/contracts/src/project-limits.js';
import {ReadProjectRequest,ReadDraftRequest} from '@model-analyser/contracts';
import {decodeProjectImport} from './project-import.js';
import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AssetDocument,ConfigSource,DecodeConfigRequest, ProjectImportDocument, CommitRequest, SaveDraftRequest, SaveProjectRequest, SaveProjectDraftRequest, CommitProjectDraftRequest, ArchiveRequest, SnapshotRequest, DecodeAssetRequest,DecodeProjectRequest, RecoverRevisionRequest,DependencyUpgradeIntent,ApplyDependencyUpgradeRequest,DependencyUpgradeOperationRequest } from '@model-analyser/contracts';
import { assertVersion } from './scan.js';
import { decodeDocument } from './documents.js';
import { FileStore, StoreError } from './store.js';
import { DecodeMeasurementsRequest } from '@model-analyser/contracts';
import { decodeMeasurements } from '../../../packages/contracts/src/measurement-file.js';

export function createApp(store:FileStore,webRoot=resolve('apps/web/dist')) {
  return createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    const reply=(data:unknown,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    try {
      // Mutations are same-origin only; loopback binding alone does not prevent browser-origin writes.
      const origin=req.headers.origin;
      if(origin&&origin!==`http://${req.headers.host}`)throw new StoreError('validation','请求来源不匹配');
      const url=new URL(req.url??'/','http://localhost'),path=url.pathname,method=req.method;
      if(path.startsWith('/api/v1/')) {
        let data:unknown;
        if(method==='GET'&&path==='/api/v1/assets')data=await store.list(url.searchParams.get('archived')==='true');
        else if(method==='GET'&&path==='/api/v1/asset')data=await store.read(z.string().min(1).parse(url.searchParams.get('id')),url.searchParams.has('revision')?z.coerce.number().int().positive().parse(url.searchParams.get('revision')):undefined);
        else if(method==='GET'&&path==='/api/v1/drafts')data=await store.drafts();
        else if(method==='POST'&&path==='/api/v1/asset-draft')data=await store.readAssetDraft(ReadDraftRequest.parse(await body(req,PROJECT_IMPORT_REQUEST_BYTES)).draftId);
        else if(method==='POST'&&path==='/api/v1/project-draft')data=await store.readProjectDraft(ReadDraftRequest.parse(await body(req,PROJECT_IMPORT_REQUEST_BYTES)).draftId);
        else if(method==='GET'&&path==='/api/v1/catalog')data=await store.catalog(url.searchParams.get('fresh')==='true');
        else if(method==='GET'&&path==='/api/v1/projects')data=await store.projects();
        else if(method==='GET'&&path==='/api/v1/project')data=await store.readProject(z.string().min(1).parse(url.searchParams.get('id')),url.searchParams.has('revision')?z.coerce.number().int().positive().parse(url.searchParams.get('revision')):undefined);
        else if(method==='POST'&&path==='/api/v1/project'){const input=ReadProjectRequest.parse(await body(req,PROJECT_IMPORT_REQUEST_BYTES));data=await store.readProject(input.projectId,input.revision);}
        else if(method==='GET'&&path==='/api/v1/project-drafts')data=await store.projectDrafts();
        else if(method==='GET'&&path==='/api/v1/scan')data=await store.scan();
        else if(method==='GET'&&path==='/api/v1/dependency-upgrades')data=await store.dependencyUpgradeHistory(url.searchParams.get('projectId')??undefined);
        else if(method==='POST'&&path==='/api/v1/dependency-upgrade-preview')data=await store.previewDependencyUpgrade(DependencyUpgradeIntent.parse(await body(req)));
        else if(method==='POST'&&path==='/api/v1/dependency-upgrade-apply')data=await store.applyDependencyUpgrade(ApplyDependencyUpgradeRequest.parse(await body(req)));
        else if(method==='POST'&&path==='/api/v1/dependency-upgrade-resume')data=await store.resumeDependencyUpgrade(DependencyUpgradeOperationRequest.parse(await body(req)).requestId);
        else if(method==='POST'&&path==='/api/v1/dependency-upgrade-cancel')data=await store.cancelDependencyUpgrade(DependencyUpgradeOperationRequest.parse(await body(req)).requestId);
        else if(method==='POST'&&path==='/api/v1/drafts'){const input=SaveDraftRequest.parse(await body(req));data={requestId:input.requestId,draft:await store.saveDraft(input.draft)};}
        else if(method==='POST'&&path==='/api/v1/commit'){const input=CommitRequest.parse(await body(req));data={requestId:input.requestId,...await store.commitWithHead(input.draftId,input.draftGeneration,input.expectedRevision,input.requestId)};}
        else if(method==='POST'&&path==='/api/v1/projects'){const input=SaveProjectRequest.parse(await body(req,64*1024*1024));data={requestId:input.requestId,project:await store.saveProject(input.project,input.expectedRevision,input.requestId)};}
        else if(method==='POST'&&path==='/api/v1/project-drafts'){const input=SaveProjectDraftRequest.parse(await body(req,PROJECT_DRAFT_REQUEST_BYTES));data={requestId:input.requestId,draft:await store.saveProjectDraft(input.draft)};}
        else if(method==='POST'&&path==='/api/v1/commit-project-draft'){const input=CommitProjectDraftRequest.parse(await body(req));data={requestId:input.requestId,project:await store.commitProjectDraft(input.draftId,input.draftGeneration,input.expectedRevision,input.requestId)};}
        else if(method==='POST'&&path==='/api/v1/archive'){const input=ArchiveRequest.parse(await body(req));await store.archive(input.assetId,input.archived);data={requestId:input.requestId};}
        else if(method==='POST'&&path==='/api/v1/snapshot'){const input=SnapshotRequest.parse(await body(req));data=await store.snapshot(input.refs);}
        else if(method==='POST'&&path==='/api/v1/decode-asset'){const input=DecodeAssetRequest.parse(await body(req));const value=decodeDocument(input.text,input.format);assertVersion(value);data=AssetDocument.parse(value);}
        else if(method==='POST'&&path==='/api/v1/decode-config'){const input=DecodeConfigRequest.parse(await body(req));data=ConfigSource.parse({sourceName:input.sourceName,format:input.format,rawConfig:decodeDocument(input.text,input.format)});}
        else if(method==='POST'&&path==='/api/v1/decode-measurements'){const input=DecodeMeasurementsRequest.parse(await body(req));try{data=decodeMeasurements(input);}catch(e){throw new StoreError('validation',e instanceof Error?e.message:'测量文件无效');}}
        else if(method==='POST'&&(path==='/api/v1/decode-project'||path==='/api/v1/decode-project-text')){const input=path==='/api/v1/decode-project-text'?{format:DecodeProjectRequest.shape.format.parse(url.searchParams.get('format')),text:await textBody(req,PROJECT_IMPORT_REQUEST_BYTES)}:DecodeProjectRequest.parse(await body(req,PROJECT_IMPORT_REQUEST_BYTES));const decoded=decodeProjectImport(input.text,input.format),document=decoded.document;if(decoded.ordinaryRecovery&&document.documentType==='project_recovery'){try{const existing=await store.readProject(document.projectId);document.formalProject=existing;document.baseProjectRevision=existing.projectRevision;}catch(e){if(!(e instanceof StoreError)||e.code!=='not_found')throw e;}}data=document;}
        else if(method==='POST'&&path==='/api/v1/recover-revision'){const input=RecoverRevisionRequest.parse(await body(req));data={requestId:input.requestId,asset:await store.recoverRevision(input.assetId,input.revision,input.expectedRevision)};}
        else if(method==='POST'&&path==='/api/v1/rescan')data=await store.list();
        else throw new StoreError('not_found','接口不存在');
        reply({ok:true,data});return;
      }
      if(method!=='GET'&&method!=='HEAD')throw new StoreError('not_found','页面不存在');
      const relative=decodeURIComponent(path)==='/'?'index.html':decodeURIComponent(path).slice(1);
      const file=resolve(webRoot,relative);if(!file.startsWith(webRoot+sep))throw new StoreError('not_found','页面不存在');
      const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
      const content=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream'});res.end(method==='HEAD'?undefined:content);
    } catch(e) {
      const error=e instanceof StoreError?e: e instanceof z.ZodError?new StoreError('validation','字段校验失败'):new StoreError('io',e instanceof Error?e.message:'读写失败');
      reply({ok:false,error:{code:error.code,message:error.message,fieldIssues:e instanceof z.ZodError?e.issues.map(i=>({path:i.path.join('.'),message:i.message})):[],...(error.currentRevision===undefined?{}:{currentRevision:error.currentRevision})}},error.code==='conflict'?409:error.code==='not_found'?404:400);
    }
  });
}
async function textBody(req:IncomingMessage,maxBytes:number){let size=0;const chunks:Buffer[]=[];for await(const chunk of req){const bytes=Buffer.from(chunk as Uint8Array);size+=bytes.length;if(size>maxBytes)throw new StoreError('validation','请求超过 '+maxBytes/(1024*1024)+' MiB');chunks.push(bytes);}try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks));}catch{throw new StoreError('validation','请求不是有效UTF-8');}}
async function body(req:IncomingMessage,maxBytes=4*1024*1024):Promise<unknown>{const text=await textBody(req,maxBytes);try{return JSON.parse(text) as unknown;}catch{throw new StoreError('validation','JSON 无法解析');}}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const store=new FileStore(resolve(process.env['MODEL_ANALYSER_DATA']??'data'),resolve('assets/builtin'));
  const port=Number(process.env['PORT']??4310);createApp(store).listen(port,'127.0.0.1',()=>console.log(`Model Analyser http://127.0.0.1:${port}`));
}
