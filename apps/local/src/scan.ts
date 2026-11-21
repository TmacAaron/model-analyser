import {PROJECT_DRAFT_BYTES} from '../../../packages/contracts/src/project-limits.js';
import {validateProjectDraftSize} from '../../../packages/contracts/src/project-recovery.js';
import { ascendProjectProblems } from '../../../packages/contracts/src/ascend-quantization.js';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AssetDocument, AssetDraft, ProjectDocument, ProjectDraft, ScanReport,WorkspaceCatalog } from '@model-analyser/contracts';
import type {CatalogFileCache} from './catalog-cache.js';
import { validateAssets, canonical } from '../../../packages/contracts/src/validation.js';
import { decodeDocument, StoreError } from './documents.js';
import { Head,isPublished,revisionFilePattern } from './asset-head.js';
export { Head,revisionFilePattern } from './asset-head.js';

export const storageKey=(id:string)=>createHash('sha256').update(id).digest('hex');
export function assertVersion(value:unknown):void {
  if(value!==null&&typeof value==='object'&&'schemaVersion' in value&&value.schemaVersion!==1)throw new StoreError('unsupported_version',`不支持 schemaVersion=${String(value.schemaVersion)}，保留原文件`);
}
export async function readContract<T extends z.ZodType>(path:string,schema:T):Promise<z.infer<T>> {
  const maxBytes=Object.is(schema,ProjectDocument)?32*1024*1024:Object.is(schema,ProjectDraft)?PROJECT_DRAFT_BYTES:4*1024*1024;
  const value=decodeDocument(await readFile(path,'utf8'),/\.ya?ml$/i.test(path)?'yaml':'json',maxBytes);assertVersion(value);const parsed=schema.parse(value);if(Object.is(schema,ProjectDraft))validateProjectDraftSize(ProjectDraft.parse(parsed));if(Object.is(schema,ProjectDocument)){const issues=ascendProjectProblems(ProjectDocument.parse(parsed));if(issues.length)throw new StoreError('validation',issues.join('；'));}return parsed;
}
const missing=(e:unknown)=>e!==null&&typeof e==='object'&&'code' in e&&e.code==='ENOENT';
export async function findRevisionFile(dir:string,revision:number):Promise<{file:string;format:'json'|'yaml'}|undefined>{
  let files;try{files=await readdir(dir,{withFileTypes:true});}catch(e){if(missing(e))return undefined;throw e;}
  const matches=files.filter(e=>e.isFile()&&revisionFilePattern.exec(e.name)?.[1]===String(revision));
  if(matches.length>1)throw new StoreError('conflict',`修订 ${revision} 有多个权威定义文件，原文件保留`);
  const entry=matches[0];return entry?{file:join(dir,entry.name),format:/\.ya?ml$/i.test(entry.name)?'yaml':'json'}:undefined;
}
type ScanResult=z.infer<typeof ScanReport>&{revisions:AssetDocument[];builtinRevisions:AssetDocument[]};
type CatalogResult=z.infer<typeof WorkspaceCatalog>&{revisions:AssetDocument[];builtinRevisions:AssetDocument[]};
export function scanFiles(root:string,builtinRoot:string,scope:'catalog',cache:CatalogFileCache,fresh?:boolean):Promise<CatalogResult>;
export function scanFiles(root:string,builtinRoot:string,scope?:'all'|'revisions'|'library'|'assets'):Promise<ScanResult>;
export async function scanFiles(root:string,builtinRoot:string,scope:'all'|'revisions'|'library'|'assets'|'catalog'='all',cache?:CatalogFileCache,fresh=false):Promise<ScanResult|CatalogResult> {
  const report: z.infer<typeof ScanReport>={assets:[],drafts:[],projects:[],projectDrafts:[],issues:[],recoveries:[]};
  const catalog:z.infer<typeof WorkspaceCatalog>={...report,drafts:[],projects:[],projectDrafts:[]};
  async function header<T extends z.ZodType,S>(file:string,schema:T,project:(value:z.infer<T>)=>S):Promise<S>{return cache?cache.read(Object.is(schema,ProjectDocument)?'project':Object.is(schema,ProjectDraft)?'project-draft':'asset-draft',file,schema,project,fresh):project(await readContract(file,schema));}
  function checkIdentity(id:string,name:string,label:string){if(storageKey(id)+'.json'!==name)throw new StoreError('validation',label+' ID 与文件名不一致');}
  const revisions:AssetDocument[]=[];
  const byIdentity=new Map<string,AssetDocument>();
  const sources=new Map<string,{file:string;origin:'builtin'|'user';format:'json'|'yaml'}>();
  const blocked=new Set<string>();
  const identity=(a:AssetDocument)=>`${a.assetId}@${a.revision}`;
  const display=(file:string)=>file.startsWith(builtinRoot)?'builtin/'+relative(builtinRoot,file):relative(root,file);
  const issue=(file:string,e:unknown)=>{report.issues.push({file:display(file),code:e instanceof StoreError?(e.code==='not_found'?'reference':e.code):e instanceof z.ZodError||e instanceof SyntaxError?'validation':'io',message:e instanceof Error?e.message:'文件读取失败'});};
  const attempt=async<T>(file:string,fn:()=>Promise<T>):Promise<T|undefined>=>{try{return await fn();}catch(e){issue(file,e);return undefined;}};
  const entries=async(dir:string)=>{try{return (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));}catch(e){if(!missing(e))issue(dir,e);return [];}};
  function add(asset:AssetDocument,file:string,origin:'builtin'|'user') {
    const key=identity(asset),prior=byIdentity.get(key);
    if(prior){blocked.add(key);report.issues.push({file:display(file),code:'conflict',message:`同 ID 同修订存在多个权威定义文件：${key}${canonical(prior)!==canonical(asset)?'，内容不同':''}`});return;}
    byIdentity.set(key,asset);revisions.push(asset);sources.set(key,{file,origin,format:/\.ya?ml$/i.test(file)?'yaml':'json'});
  }
  const builtinFiles:string[]=[];
  async function collectBuiltins(dir:string){
    for(const entry of await entries(dir)){
      const file=join(dir,entry.name);
      if(entry.isDirectory())await collectBuiltins(file);
      else if(entry.isFile()&&/\.(json|ya?ml)$/i.test(entry.name))builtinFiles.push(file);
    }
  }
  await collectBuiltins(builtinRoot);
  const batchSize=16;
  for(let start=0;start<builtinFiles.length;start+=batchSize){
    const files=builtinFiles.slice(start,start+batchSize);
    const results=await Promise.allSettled(files.map(file=>readContract(file,AssetDocument)));
    // Report results in traversal order even when disk reads finish in a different order.
    for(const [index,result] of results.entries()){
      const file=files[index]!;
      if(result.status==='fulfilled')add(result.value,file,'builtin');else issue(file,result.reason);
    }
  }
  const heads=new Map<string,number>();
  for(const entry of await entries(join(root,'assets','user')))if(entry.isDirectory()){
    const dir=join(root,'assets','user',entry.name),headFile=join(dir,'head.json');
    const contents=await entries(dir),hasHead=contents.some(e=>e.name==='head.json');
    const head=hasHead?await attempt(headFile,()=>readContract(headFile,Head)):undefined;
    if(head&&storageKey(head.assetId)!==entry.name){issue(headFile,new StoreError('validation','head ID 与目录不一致'));continue;}
    if(head)heads.set(head.assetId,head.revision);
    let foundHead=false;
    const revisionFiles=contents.filter(e=>e.isFile()&&revisionFilePattern.test(e.name));
    const duplicates=new Set(revisionFiles.filter(e=>revisionFiles.some(other=>other!==e&&revisionFilePattern.exec(other.name)?.[1]===revisionFilePattern.exec(e.name)?.[1])).map(e=>revisionFilePattern.exec(e.name)?.[1]));
    for(const fileEntry of revisionFiles){
      if(duplicates.has(revisionFilePattern.exec(fileEntry.name)?.[1])){issue(join(dir,fileEntry.name),new StoreError('conflict','同一修订存在多个权威定义文件，原文件保留'));continue;}
      const file=join(dir,fileEntry.name),asset=await attempt(file,()=>readContract(file,AssetDocument));if(!asset)continue;
      if(storageKey(asset.assetId)!==entry.name||revisionFilePattern.exec(basename(file))?.[1]!==String(asset.revision)){issue(file,new StoreError('validation','修订身份与路径不一致'));continue;}
      if(head&&head.assetId===asset.assetId&&isPublished(head,asset.revision)){add(asset,file,'user');if(asset.revision===head.revision)foundHead=true;}
      else {
        report.issues.push({file:display(file),code:'orphan_revision',message:`未提交修订 ${identity(asset)}，不会自动作为正式资产`});
        // A malformed head must be repaired externally; never replace an unreadable version pointer.
        if(!hasHead||head)report.recoveries.push({assetId:asset.assetId,revision:asset.revision,name:asset.name,expectedRevision:head?.revision??null});
      }
    }
    if(head&&!foundHead)issue(headFile,new StoreError('reference','head 指向缺失或无效的修订'));
  }
  const usable=revisions.filter(a=>!blocked.has(identity(a)));
  // Revision consumers validate their own selected roots. They need the same fresh
  // revision closure, not archive metadata or every project's embedded snapshots.
  if(scope==='revisions')return {...ScanReport.parse(report),revisions:usable,builtinRevisions:revisions.filter(a=>sources.get(identity(a))?.origin==='builtin')};
  for(const asset of usable){
    const source=sources.get(identity(asset));if(!source)continue;
    const diagnostics=validateAssets([asset],usable).filter(d=>d.severity==='error');
    if(diagnostics.length){report.issues.push({file:display(source.file),code:'reference',message:diagnostics.map(d=>d.message).join('; ')});continue;}
    if(source.origin==='user'&&heads.get(asset.assetId)!==asset.revision)continue;
    const weightProfile=asset.definition.kind==='quantization'?asset.definition.modelWeights:undefined;
    const newer=source.origin==='builtin'?usable.filter(a=>a.assetId===asset.assetId&&a.revision>asset.revision):[];
    const pinned=newer.length>0;
    if(pinned&&(scope!=='catalog'||!weightProfile||newer.some(a=>a.definition.kind==='quantization'&&
      a.definition.modelWeights?.model.assetId===weightProfile.model.assetId&&
      a.definition.modelWeights.model.revision===weightProfile.model.revision)))continue;
    const archiveFile=join(root,'assets','archive',storageKey(asset.assetId)+'.json');
    let archived=false;try{const raw=JSON.parse(await readFile(archiveFile,'utf8')) as unknown;z.strictObject({assetId:z.literal(asset.assetId)}).parse(raw);archived=true;}catch(e){if(!missing(e))issue(archiveFile,e);}
    const entries=pinned?(catalog.pinnedWeightPresets??=[]):report.assets;
    entries.push({assetId:asset.assetId,revision:asset.revision,kind:asset.definition.kind,name:asset.name,origin:source.origin,format:source.format,archived,...(asset.definition.kind==='model'?{family:asset.definition.family}:{}),...(asset.configMapping?{configModelTypes:asset.configMapping.modelTypes}:{}),
      ...(asset.definition.kind==='quantization'&&asset.definition.modelWeights?{weightPresetModel:asset.definition.modelWeights.model,
        ...(asset.definition.modelWeights.moduleRules.some(rule=>rule.execution?.length)?{weightPresetExecution:true as const}:{})}:{})});
  }
  if(scope==='assets')return {...ScanReport.parse(report),revisions:usable,builtinRevisions:revisions.filter(a=>sources.get(identity(a))?.origin==='builtin')};
  for(const entry of await entries(join(root,'assets','drafts')))if(entry.isFile()&&entry.name.endsWith('.json')){
    if(scope==='catalog'){const file=join(root,'assets','drafts',entry.name),draft=await attempt(file,()=>header(file,AssetDraft,value=>{checkIdentity(value.draftId,entry.name,'草稿');const {candidate,...summary}=value;return summary;}));if(draft)catalog.drafts.push(draft);continue;}
    const file=join(root,'assets','drafts',entry.name),draft=await attempt(file,()=>readContract(file,AssetDraft));if(draft){if(storageKey(draft.draftId)+'.json'!==entry.name)issue(file,new StoreError('validation','草稿 ID 与文件名不一致'));else report.drafts.push(draft);}
  }
  for(const entry of scope==='library'?[]:await entries(join(root,'projects')))if(entry.isFile()&&entry.name.endsWith('.json')){
    if(scope==='catalog'){const file=join(root,'projects',entry.name),project=await attempt(file,()=>header(file,ProjectDocument,value=>{checkIdentity(value.projectId,entry.name,'项目');return {projectId:value.projectId,projectRevision:value.projectRevision,name:value.name,assetSnapshotCount:value.assetSnapshots.length,scenarios:value.scenarios.map(({scenarioId,name,model})=>({scenarioId,name,model}))};}));if(project)catalog.projects.push(project);continue;}
    const file=join(root,'projects',entry.name),project=await attempt(file,()=>readContract(file,ProjectDocument));if(project){if(storageKey(project.projectId)+'.json'!==entry.name)issue(file,new StoreError('validation','项目 ID 与文件名不一致'));else report.projects.push(project);}
  }
  for(const entry of scope==='library'?[]:await entries(join(root,'projects','drafts')))if(entry.isFile()&&entry.name.endsWith('.json')){
    if(scope==='catalog'){const file=join(root,'projects','drafts',entry.name),draft=await attempt(file,()=>header(file,ProjectDraft,value=>{checkIdentity(value.draftId,entry.name,'项目草稿');const {candidate,...summary}=value;return summary;}));if(draft)catalog.projectDrafts.push(draft);continue;}
    const file=join(root,'projects','drafts',entry.name),draft=await attempt(file,()=>readContract(file,ProjectDraft));if(draft){if(storageKey(draft.draftId)+'.json'!==entry.name)issue(file,new StoreError('validation','项目草稿 ID 与文件名不一致'));else report.projectDrafts.push(draft);}
  }
  return {...(scope==='catalog'?WorkspaceCatalog.parse(catalog):ScanReport.parse(report)),revisions:usable,builtinRevisions:revisions.filter(a=>sources.get(identity(a))?.origin==='builtin')};
}
