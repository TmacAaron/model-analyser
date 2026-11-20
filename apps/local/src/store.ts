import {validateProjectDraftSize} from '../../../packages/contracts/src/project-recovery.js';
import {parseProjectText} from '../../../packages/contracts/src/project-text.js';
import { assetDependencies } from '../../../packages/contracts/src/validation.js';
import { mkdir, readFile, unlink, readdir } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { atomicWriteJson,atomicWriteDocument,serializeJsonFile,serializeDocumentFile } from './atomic-file.js';
import { z } from 'zod';
import { scanFiles, storageKey, Head, assertVersion, readContract,findRevisionFile } from './scan.js';
import { readAssetHead,isPublished,publishRevisionHead } from './asset-head.js';
import {CatalogFileCache} from './catalog-cache.js';
import { AssetDocument, AssetDraft, AssetIndexEntry, ProjectDocument, ProjectDraft,DependencyUpgradeIntent,DependencyUpgradePlan,DependencyUpgradeOperation,DependencyUpgradeHistory,ApplyDependencyUpgradeRequest, type AssetRef } from '@model-analyser/contracts';
import { canonical, validateAssets, validateProject } from '../../../packages/contracts/src/validation.js';
import { proposeDependencyUpgrade,UpgradePlanningError,upgradeRef } from '../../../packages/contracts/src/dependency-upgrade.js';

import { StoreError } from './documents.js';
export { StoreError, decodeDocument } from './documents.js';
const fileKey=storageKey;
const CommitReceipt=z.strictObject({schemaVersion:z.literal(1),requestId:z.string().min(1),draftId:z.string().min(1),draftGeneration:z.number().int().nonnegative(),expectedRevision:z.number().int().positive().nullable(),asset:AssetDocument,storageFormat:z.enum(['json','yaml']).optional(),importIntent:AssetDraft.shape.importIntent,headRevision:z.number().int().positive().optional()});
const ProjectReceipt=z.strictObject({schemaVersion:z.literal(1),requestId:z.string().min(1),requestFingerprint:z.string(),expectedRevision:z.number().int().positive().nullable(),project:ProjectDocument,
  draft:z.strictObject({draftId:z.string(),generation:z.number().int().nonnegative()}).optional()});
const UpgradeReceipt=z.strictObject({schemaVersion:z.literal(1),requestFingerprint:z.string(),operation:DependencyUpgradeOperation});
const upgradeHash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function upgradeReceipt(raw:unknown,requestId?:string){assertVersion(raw);const receipt=UpgradeReceipt.parse(raw),op=receipt.operation,{planHash,...proposal}=op.plan;if(op.requestId!==op.plan.intent.requestId||requestId!==undefined&&op.requestId!==requestId||upgradeHash(proposal)!==planHash||receipt.requestFingerprint!==canonical({...op.plan.intent,planHash}))throw new StoreError('conflict','升级回执身份、指纹或内容校验失败，原文保留');return receipt;}
const absent=(e:unknown)=>typeof e==='object'&&e!==null&&'code' in e&&e.code==='ENOENT';
async function maybe(path:string):Promise<unknown|undefined>{try{return JSON.parse(await readFile(path,'utf8')) as unknown;}catch(e){if(absent(e))return undefined;throw e;}}
export class FileStore {
  private queue:Promise<unknown>=Promise.resolve();
  private catalogFiles=new CatalogFileCache();private catalogEpoch=0;
  private catalogJob:{epoch:number;promise:ReturnType<FileStore['readCatalog']>}|null=null;
  constructor(readonly root:string,readonly builtinRoot:string,private readonly checkpoint?:(stage:string)=>Promise<void>){}
  private serialized<T>(fn:()=>Promise<T>):Promise<T>{const task=this.queue.then(async()=>{this.catalogEpoch++;try{return await fn();}finally{this.catalogEpoch++;}});this.queue=task.catch(()=>undefined);return task;}
  private assetDir(id:string){return join(this.root,'assets','user',fileKey(id));}
  private draftPath(id:string){return join(this.root,'assets','drafts',fileKey(id)+'.json');}
  private receiptPath(id:string){return join(this.root,'operations',fileKey(id)+'.json');}
  private projectDraftPath(id:string){return join(this.root,'projects','drafts',fileKey(id)+'.json');}
  private projectReceiptPath(id:string){return join(this.root,'project-operations',fileKey(id)+'.json');}
  private upgradePath(id:string){return join(this.root,'dependency-upgrades',fileKey(id)+'.json');}
  private atomic(path:string,value:unknown){return atomicWriteJson(path,value);}
  private async assetRevision(id:string,revision:number){const found=await findRevisionFile(this.assetDir(id),revision);if(!found)return undefined;const asset=await readContract(found.file,AssetDocument);if(asset.assetId!==id||asset.revision!==revision)throw new StoreError('validation','修订身份与路径不一致');return {...found,asset};}
  private async requireAssetRevision(id:string,revision:number){const found=await this.assetRevision(id,revision);if(!found)throw new StoreError('not_found','资产修订文件不存在');return found;}
  private async requirePublishedRevision(id:string,revision:number){if(!isPublished(await readAssetHead(this.assetDir(id),id),revision))throw new StoreError('reference','修订尚未正式发布');return this.requireAssetRevision(id,revision);}
  private async writeAssetRevision(asset:AssetDocument,format:'json'|'yaml'){
    const text=serializeDocumentFile(asset,format);if(Buffer.byteLength(text)>4*1024*1024)throw new StoreError('validation','资产修订超过4 MiB，未写入');
    const old=await this.assetRevision(asset.assetId,asset.revision);if(old){if(old.format!==format||canonical(old.asset)!==canonical(asset))throw new StoreError('conflict','同修订已有不同内容或格式的恢复文件，原文件保留');return;}
    await atomicWriteDocument(join(this.assetDir(asset.assetId),asset.revision+'.'+format),asset,format);
  }
  async scan(){const {revisions,builtinRevisions,...report}=await scanFiles(this.root,this.builtinRoot);return report;}
  private async readCatalog(fresh:boolean){const {revisions,builtinRevisions,...report}=await scanFiles(this.root,this.builtinRoot,'catalog',this.catalogFiles,fresh);return report;}
  catalog(fresh=false){if(!fresh&&this.catalogJob?.epoch===this.catalogEpoch)return this.catalogJob.promise;const job={epoch:this.catalogEpoch,promise:this.readCatalog(fresh)};if(!fresh)this.catalogJob=job;void job.promise.finally(()=>{if(this.catalogJob===job)this.catalogJob=null;}).catch(()=>undefined);return job.promise;}
  async builtins():Promise<AssetDocument[]> {return (await scanFiles(this.root,this.builtinRoot,'revisions')).builtinRevisions;}
  async revisions():Promise<AssetDocument[]> {return (await scanFiles(this.root,this.builtinRoot,'revisions')).revisions;}
  async list(includeArchived=false):Promise<AssetIndexEntry[]> {return (await this.catalog()).assets.filter(a=>includeArchived||!a.archived);}
  async read(id:string,revision?:number):Promise<AssetDocument>{
    const scan=await scanFiles(this.root,this.builtinRoot,'assets');
    const entry=scan.assets.find(a=>a.assetId===id);
    const asset=scan.revisions.find(a=>a.assetId===id&&a.revision===(revision??entry?.revision));
    if(!asset)throw new StoreError('not_found','正式修订不存在；可检查扫描诊断与恢复清单');return asset;
  }
  async drafts():Promise<AssetDraft[]>{return (await scanFiles(this.root,this.builtinRoot,'library')).drafts;}
  async readAssetDraft(id:string):Promise<AssetDraft>{let draft:AssetDraft;try{draft=await readContract(this.draftPath(id),AssetDraft);}catch(e){if(absent(e))throw new StoreError('not_found','草稿不存在');throw e;}if(draft.draftId!==id)throw new StoreError('validation','草稿身份与路径不符');return draft;}
  saveDraft(input:unknown):Promise<AssetDraft>{return this.serialized(async()=>{assertVersion(input);const draft=AssetDraft.parse(input);const old=await maybe(this.draftPath(draft.draftId));assertVersion(old);
    if(old!==undefined){const prior=AssetDraft.parse(old);if(draft.assetId!==prior.assetId||draft.draftGeneration<prior.draftGeneration||(draft.draftGeneration===prior.draftGeneration&&canonical(draft)!==canonical(prior)))throw new StoreError('conflict','草稿代次过期或冲突');}
    await this.atomic(this.draftPath(draft.draftId),draft);return draft;});}
  async commit(draftId:string,generation:number,expectedRevision:number|null,requestId:string=randomUUID()):Promise<AssetDocument>{return (await this.commitWithHead(draftId,generation,expectedRevision,requestId)).asset;}
  commitWithHead(draftId:string,generation:number,expectedRevision:number|null,requestId:string=randomUUID()):Promise<{asset:AssetDocument;headRevision:number}>{return this.serialized(async()=>{
    const previous=await maybe(this.receiptPath(requestId));
    if(previous!==undefined){const receipt=CommitReceipt.parse(previous);
      if(receipt.requestId!==requestId||receipt.draftId!==draftId||receipt.draftGeneration!==generation||receipt.expectedRevision!==expectedRevision)throw new StoreError('conflict','请求 ID 已用于不同提交');
      return this.finishCommit(receipt);
    }
    const raw=await maybe(this.draftPath(draftId));if(raw===undefined)throw new StoreError('not_found','草稿不存在');assertVersion(raw);const draft=AssetDraft.parse(raw);
    if(draft.draftGeneration!==generation||draft.baseRevision!==expectedRevision)throw new StoreError('conflict','草稿代次或基线已变化');
    const library=await scanFiles(this.root,this.builtinRoot,'revisions');
    if(library.builtinRevisions.some(a=>a.assetId===draft.assetId))throw new StoreError('conflict','内置资产须先创建用户副本');
    const head=await readAssetHead(this.assetDir(draft.assetId),draft.assetId),current=head?.revision??null;
    if(current!==expectedRevision)throw new StoreError('conflict','资产已被修改',current??undefined);
    const prior=current===null?undefined:await this.requireAssetRevision(draft.assetId,current),storageFormat=draft.storageFormat??(draft.importIntent?'json':prior?.format??'json');
    assertVersion(draft.candidate);const candidate=AssetDocument.parse(draft.candidate);
    if(candidate.assetId!==draft.assetId||candidate.definition.kind!==draft.assetKind)throw new StoreError('validation','草稿身份与正文不符');
    const intent=draft.importIntent;if(intent&&(intent.source.kind!==candidate.definition.kind||intent.mode==='preserve'&&(intent.source.assetId!==candidate.assetId||intent.source.revision!==candidate.revision)||intent.source.assetId!==candidate.assetId&&current!==null))throw new StoreError('validation','导入意图与定义身份、修订或副本基线不符');
    const next=AssetDocument.parse({...candidate,revision:intent?.mode==='preserve'?intent.source.revision:(current??0)+1}),headRevision=Math.max(current??0,next.revision);
    const diagnostics=validateAssets([next],[...library.revisions.filter(a=>!(a.assetId===next.assetId&&a.revision===next.revision)),next]).filter(d=>d.severity==='error');
    if(diagnostics.length)throw new StoreError('reference',diagnostics.map(d=>d.message).join('; '));
    if(prior&&intent?.mode!=='preserve'){if(canonical({...prior.asset,revision:0})===canonical({...next,revision:0})){
      const receipt=CommitReceipt.parse({schemaVersion:1,requestId,draftId,draftGeneration:generation,expectedRevision,asset:prior.asset,storageFormat:prior.format,...(intent?{importIntent:intent}:{}),headRevision:prior.asset.revision});
      await this.atomic(this.receiptPath(requestId),receipt);return this.finishCommit(receipt);
    }}
    await this.writeAssetRevision(next,storageFormat);
    const receipt=CommitReceipt.parse({schemaVersion:1,requestId,draftId,draftGeneration:generation,expectedRevision,asset:next,storageFormat,...(intent?{importIntent:intent}:{}),headRevision});
    // Record the exact result before publishing head. A lost response can then replay the same request after restart.
    await this.atomic(this.receiptPath(requestId),receipt);return this.finishCommit(receipt);
  });}
  private async finishCommit(receipt:z.infer<typeof CommitReceipt>):Promise<{asset:AssetDocument;headRevision:number}>{
    const asset=receipt.asset,dir=this.assetDir(asset.assetId),head=await readAssetHead(dir,asset.assetId),current=head?.revision??null,intent=receipt.importIntent,headRevision=Math.max(receipt.expectedRevision??0,asset.revision);
    if(receipt.headRevision!==undefined&&receipt.headRevision!==headRevision||intent&&(intent.source.kind!==asset.definition.kind||intent.mode==='preserve'&&(intent.source.assetId!==asset.assetId||intent.source.revision!==asset.revision)||intent.source.assetId!==asset.assetId&&receipt.expectedRevision!==null))throw new StoreError('conflict','提交回执的导入身份或发布基线不符');
    const stored=await this.requireAssetRevision(asset.assetId,asset.revision);
    if(stored.format!==(receipt.storageFormat??'json')||canonical(stored.asset)!==canonical(asset))throw new StoreError('conflict','提交回执与不可变修订内容或格式不一致');
    if(isPublished(head,asset.revision)){/* Published already; replay must never move head backwards. */}
    else if(current===receipt.expectedRevision&&(intent?.mode==='preserve'||asset.revision===(current??0)+1)){
      const diagnostics=validateAssets([asset],[...(await this.revisions()),asset]).filter(d=>d.severity==='error');
      if(diagnostics.length)throw new StoreError('reference',diagnostics.map(d=>d.message).join('; '));
      await this.checkpoint?.('before_head');await publishRevisionHead(dir,asset.assetId,asset.revision,current);
    }else throw new StoreError('conflict','回执的基线与当前版本不一致',current??undefined);
    const draftRaw=await maybe(this.draftPath(receipt.draftId));
    if(draftRaw!==undefined){const draft=AssetDraft.parse(draftRaw);if(draft.assetId===asset.assetId&&draft.draftGeneration===receipt.draftGeneration&&draft.baseRevision===receipt.expectedRevision)await unlink(this.draftPath(receipt.draftId)).catch(()=>undefined);}
    return {asset,headRevision};
  }
  archive(id:string,value:boolean):Promise<void>{return this.serialized(async()=>{await this.read(id);const path=join(this.root,'assets','archive',fileKey(id)+'.json');if(value)await this.atomic(path,{assetId:id});else await unlink(path).catch(e=>{if(!absent(e))throw e;});});}
  async projects():Promise<ProjectDocument[]>{return (await this.scan()).projects;}
  async readProject(id:string,revision?:number):Promise<ProjectDocument>{const path=revision===undefined?join(this.root,'projects',fileKey(id)+'.json'):join(this.root,'projects','revisions',fileKey(id),revision+'.json');let project:ProjectDocument;try{project=await readContract(path,ProjectDocument);}catch(e){if(absent(e))throw new StoreError('not_found','项目不存在');throw e;}if(project.projectId!==id)throw new StoreError('validation','项目身份与路径不符');return project;}
  async projectDrafts():Promise<ProjectDraft[]>{return (await this.scan()).projectDrafts;}
  async readProjectDraft(id:string):Promise<ProjectDraft>{let draft:ProjectDraft;try{draft=await readContract(this.projectDraftPath(id),ProjectDraft);}catch(e){if(absent(e))throw new StoreError('not_found','项目草稿不存在');throw e;}if(draft.draftId!==id)throw new StoreError('validation','项目草稿身份与路径不符');return draft;}
  saveProjectDraft(input:unknown):Promise<ProjectDraft>{return this.serialized(async()=>{
    assertVersion(input);const draft=ProjectDraft.parse(input);try{validateProjectDraftSize(draft);}catch(e){throw new StoreError('validation',e instanceof Error?e.message:'项目草稿超限，未写入');}const path=this.projectDraftPath(draft.draftId),raw=await maybe(path);assertVersion(raw);
    if(raw!==undefined){const prior=ProjectDraft.parse(raw);if(prior.projectId!==draft.projectId||prior.draftGeneration>draft.draftGeneration||(prior.draftGeneration===draft.draftGeneration&&canonical(prior)!==canonical(draft)))throw new StoreError('conflict','项目草稿代次过期或冲突');}
    await this.atomic(path,draft);return draft;
  });}
  saveProject(input:unknown,expectedRevision:number|null,requestId:string=randomUUID()):Promise<ProjectDocument>{return this.serialized(async()=>{
    assertVersion(input);const project=ProjectDocument.parse(input),fingerprint=canonical({kind:'save_project',project,expectedRevision});
    return this.saveProjectUnlocked(project,expectedRevision,requestId,fingerprint);
  });}
  commitProjectDraft(draftId:string,generation:number,expectedRevision:number|null,requestId:string=randomUUID()):Promise<ProjectDocument>{return this.serialized(async()=>{
    const fingerprint=canonical({kind:'commit_project_draft',draftId,generation,expectedRevision});
    const prior=await maybe(this.projectReceiptPath(requestId));if(prior!==undefined)return this.replayProject(prior,requestId,fingerprint);
    const raw=await maybe(this.projectDraftPath(draftId));if(raw===undefined)throw new StoreError('not_found','项目草稿不存在');assertVersion(raw);const draft=ProjectDraft.parse(raw);
    if(draft.draftGeneration!==generation||draft.baseProjectRevision!==expectedRevision)throw new StoreError('conflict','项目草稿代次或基线已变化');
    const candidate=typeof draft.candidate==='string'?parseProjectText(draft.candidate,draft.editorFormat??'json'):draft.candidate;assertVersion(candidate);const project=ProjectDocument.parse(candidate);if(project.projectId!==draft.projectId)throw new StoreError('validation','项目草稿身份与正文不符');
    return this.saveProjectUnlocked(project,expectedRevision,requestId,fingerprint,{draftId,generation});
  });}
  private async replayProject(raw:unknown,requestId:string,fingerprint:string):Promise<ProjectDocument>{
    assertVersion(raw);const receipt=ProjectReceipt.parse(raw);if(receipt.requestId!==requestId||receipt.requestFingerprint!==fingerprint)throw new StoreError('conflict','请求 ID 已用于不同项目提交');return this.finishProject(receipt);
  }
  private async saveProjectUnlocked(project:ProjectDocument,expectedRevision:number|null,requestId:string,fingerprint:string,draft?:{draftId:string;generation:number},beforeReceiptCheckpoint?:string):Promise<ProjectDocument>{
    const prior=await maybe(this.projectReceiptPath(requestId));if(prior!==undefined)return this.replayProject(prior,requestId,fingerprint);
    const path=join(this.root,'projects',fileKey(project.projectId)+'.json'),old=await maybe(path);assertVersion(old);
    const current=old===undefined?null:ProjectDocument.parse(old).projectRevision;if(current!==expectedRevision)throw new StoreError('conflict','项目已变化',current??undefined);
    if(old!==undefined){const previous=ProjectDocument.parse(old);if(previous.projectId!==project.projectId)throw new StoreError('validation','当前项目身份与路径不一致');
      for(const a of project.assetSnapshots){const same=previous.assetSnapshots.find(p=>p.assetId===a.assetId&&p.revision===a.revision);if(same&&canonical(same)!==canonical(a))throw new StoreError('conflict',`项目内同资产修订内容不能覆盖 ${a.assetId}@${a.revision}`);}
    }
    const diagnostics=validateProject(project).filter(d=>d.severity==='error');if(diagnostics.length)throw new StoreError('reference',diagnostics.map(d=>d.message).join('; '));
    const unchanged=old!==undefined&&canonical({...ProjectDocument.parse(old),projectRevision:0})===canonical({...project,projectRevision:0});
    const saved=ProjectDocument.parse({...project,projectRevision:unchanged?current:(current??0)+1});
    if(Buffer.byteLength(serializeJsonFile(saved))>32*1024*1024)throw new StoreError('validation','项目文件超过32 MiB，未发布正式修订');
    const revisionPath=join(this.root,'projects','revisions',fileKey(project.projectId),saved.projectRevision+'.json'),orphan=await maybe(revisionPath);
    if(orphan!==undefined&&canonical(orphan)!==canonical(saved))throw new StoreError('conflict','存在同项目修订不同内容的恢复文件');
    if(orphan===undefined)await this.atomic(revisionPath,saved);
    if(beforeReceiptCheckpoint)await this.checkpoint?.(beforeReceiptCheckpoint);
    const receipt=ProjectReceipt.parse({schemaVersion:1,requestId,requestFingerprint:fingerprint,expectedRevision,project:saved,...(draft===undefined?{}:{draft})});
    await this.atomic(this.projectReceiptPath(requestId),receipt);return this.finishProject(receipt);
  }
  private async finishProject(receipt:z.infer<typeof ProjectReceipt>):Promise<ProjectDocument>{
    const project=receipt.project,path=join(this.root,'projects',fileKey(project.projectId)+'.json'),raw=await maybe(path);assertVersion(raw);
    const current=raw===undefined?null:ProjectDocument.parse(raw).projectRevision;
    const stored=await readContract(join(this.root,'projects','revisions',fileKey(project.projectId),project.projectRevision+'.json'),ProjectDocument);
    if(canonical(stored)!==canonical(project))throw new StoreError('conflict','项目回执与修订不一致');
    if(current!==null&&current>=project.projectRevision){if(current===project.projectRevision&&canonical(raw)!==canonical(project))throw new StoreError('conflict','同项目修订的当前内容已变化');}
    else if(current===receipt.expectedRevision&&project.projectRevision===(current??0)+1){
      const diagnostics=validateProject(project).filter(d=>d.severity==='error');if(diagnostics.length)throw new StoreError('reference',diagnostics.map(d=>d.message).join('; '));
      await this.checkpoint?.('before_project_publish');await this.atomic(path,project);
    }else throw new StoreError('conflict','项目回执与当前基线不一致',current??undefined);
    if(receipt.draft){const draftRaw=await maybe(this.projectDraftPath(receipt.draft.draftId));if(draftRaw!==undefined){const d=ProjectDraft.parse(draftRaw);if(d.projectId===project.projectId&&d.draftGeneration===receipt.draft.generation&&d.baseProjectRevision===receipt.expectedRevision)await unlink(this.projectDraftPath(d.draftId)).catch(()=>undefined);}}
    return project;
  }
  recoverRevision(id:string,revision:number,expectedRevision:number|null):Promise<AssetDocument>{return this.serialized(async()=>{
    const library=await scanFiles(this.root,this.builtinRoot,'revisions');
    if(library.builtinRevisions.some(a=>a.assetId===id))throw new StoreError('conflict','内置资产须先创建用户副本，不能恢复为原内置 ID');
    const head=await readAssetHead(this.assetDir(id),id),current=head?.revision??null;
    if(current!==expectedRevision)throw new StoreError('conflict','当前修订已变化',current??undefined);
    if(isPublished(head,revision))throw new StoreError('conflict','该修订已经正式发布');
    const {asset}=await this.requireAssetRevision(id,revision);
    if(asset.assetId!==id||asset.revision!==revision)throw new StoreError('validation','修订身份不符');
    const diagnostics=validateAssets([asset],[...library.revisions,asset]).filter(d=>d.severity==='error');
    if(diagnostics.length)throw new StoreError('reference',diagnostics.map(d=>d.message).join('; '));
    await publishRevisionHead(this.assetDir(id),id,revision,current);return asset;
  });}
  async snapshot(refs:AssetRef[]):Promise<AssetDocument[]>{const all=await this.revisions(),result=new Map<string,AssetDocument>();
    const {collectRefs}=await import('../../../packages/contracts/src/validation.js');
    const visit=(ref:AssetRef)=>{const key=`${ref.assetId}@${ref.revision}`;if(result.has(key))return;const asset=all.find(a=>a.assetId===ref.assetId&&a.revision===ref.revision);if(!asset)throw new StoreError('reference',`缺少 ${key}`);result.set(key,asset);for(const dep of assetDependencies(asset))visit(dep);};
    for(const ref of refs)visit(ref);return [...result.values()];}
  private async prepareUpgrade(input:unknown):Promise<z.infer<typeof DependencyUpgradePlan>>{
    const intent=DependencyUpgradeIntent.parse(input),project=await this.readProject(intent.projectId),scan=await scanFiles(this.root,this.builtinRoot);
    if(scan.projectDrafts.some(d=>d.projectId===project.projectId))throw new StoreError('conflict','项目有未提交草稿，请先保存或恢复编辑');
    if(await maybe(this.projectReceiptPath('dependency-upgrade:'+intent.requestId))!==undefined)throw new StoreError('conflict','升级关联请求 ID 已被使用，请重新预览');
    if((await this.dependencyUpgradeHistory()).operations.some(o=>o.status==='prepared'&&o.plan.intent.projectId===project.projectId&&o.requestId!==intent.requestId))throw new StoreError('conflict','项目有未完成依赖升级，请先恢复或停止该操作');
    try{const proposal=proposeDependencyUpgrade(project,intent,scan.revisions,scan.assets,base=>'user:upgrade:'+upgradeHash([intent.requestId,base]).slice(0,32));
      for(const c of proposal.changes)if(c.action==='revision'&&scan.drafts.some(d=>d.assetId===c.target.assetId))throw new StoreError('conflict','父资产有未提交草稿，请先处理：'+c.name);
      return DependencyUpgradePlan.parse({...proposal,planHash:upgradeHash(proposal)});
    }catch(e){if(e instanceof UpgradePlanningError)throw new StoreError(e.code,e.message);throw e;}
  }
  previewDependencyUpgrade(input:unknown){return this.serialized(async()=>{const intent=DependencyUpgradeIntent.parse(input),prior=await maybe(this.upgradePath(intent.requestId));if(prior!==undefined){const r=upgradeReceipt(prior,intent.requestId);if(canonical(r.operation.plan.intent)!==canonical(intent))throw new StoreError('conflict','升级请求 ID 已用于不同内容');return r.operation.plan;}return this.prepareUpgrade(intent);});}
  applyDependencyUpgrade(input:unknown){return this.serialized(async()=>{const request=ApplyDependencyUpgradeRequest.parse(input),fingerprint=canonical(request),prior=await maybe(this.upgradePath(request.requestId));if(prior!==undefined){const receipt=upgradeReceipt(prior,request.requestId);if(receipt.requestFingerprint!==fingerprint)throw new StoreError('conflict','升级请求 ID 已用于不同内容');return this.finishUpgrade(receipt);}
    const {planHash,...intent}=request,plan=await this.prepareUpgrade(intent);if(plan.planHash!==planHash)throw new StoreError('conflict','依赖、库头或项目已变化，请重新预览，未发布此次升级');
    const receipt=UpgradeReceipt.parse({schemaVersion:1,requestFingerprint:fingerprint,operation:{requestId:request.requestId,status:'prepared',plan}});await this.atomic(this.upgradePath(request.requestId),receipt);await this.checkpoint?.('upgrade_prepared');return this.finishUpgrade(receipt);
  });}
  resumeDependencyUpgrade(requestId:string){return this.serialized(async()=>{const raw=await maybe(this.upgradePath(requestId));if(raw===undefined)throw new StoreError('not_found','升级回执不存在');const receipt=upgradeReceipt(raw,requestId);if(receipt.operation.requestId!==requestId)throw new StoreError('validation','升级回执身份不符');return this.finishUpgrade(receipt);});}
  cancelDependencyUpgrade(requestId:string){return this.serialized(async()=>{const raw=await maybe(this.upgradePath(requestId));if(raw===undefined)throw new StoreError('not_found','升级回执不存在');const receipt=upgradeReceipt(raw,requestId),op=receipt.operation;if(op.requestId!==requestId)throw new StoreError('validation','升级回执身份不符');if(op.status==='complete')throw new StoreError('conflict','升级已经完成，不能撤销历史修订');if(op.status==='cancelled')return op;
    const history=await maybe(join(this.root,'projects','revisions',fileKey(op.plan.intent.projectId),op.plan.project.projectRevision+'.json'));if(await maybe(this.projectReceiptPath('dependency-upgrade:'+requestId))!==undefined||history!==undefined&&canonical(history)===canonical(op.plan.project))throw new StoreError('conflict','项目修订已准备，请恢复发布此操作；现有和新草稿仍保留');op.status='cancelled';await this.atomic(this.upgradePath(requestId),receipt);return op;
  });}
  async dependencyUpgradeHistory(projectId?:string){const history:z.infer<typeof DependencyUpgradeHistory>={operations:[],issues:[]};let entries;try{entries=await readdir(join(this.root,'dependency-upgrades'),{withFileTypes:true});}catch(e){if(absent(e))return history;throw e;}for(const entry of entries)if(entry.isFile()&&entry.name.endsWith('.json')){try{const raw=await maybe(join(this.root,'dependency-upgrades',entry.name));const receipt=upgradeReceipt(raw);if(fileKey(receipt.operation.requestId)+'.json'!==entry.name)throw new StoreError('validation','升级回执路径与 ID 不符');if(!projectId||receipt.operation.plan.intent.projectId===projectId)history.operations.push(receipt.operation);}catch(e){history.issues.push({file:'dependency-upgrades/'+entry.name,code:e instanceof StoreError&&e.code==='unsupported_version'?'unsupported_version':e instanceof StoreError&&e.code==='conflict'?'conflict':e instanceof z.ZodError||e instanceof SyntaxError||e instanceof StoreError&&e.code==='validation'?'validation':'io',message:e instanceof Error?e.message:'升级回执不可读'});}}return DependencyUpgradeHistory.parse(history);}
  private async finishUpgrade(receipt:z.infer<typeof UpgradeReceipt>):Promise<z.infer<typeof DependencyUpgradeOperation>>{
    const op=receipt.operation,plan=op.plan,{planHash,...proposal}=plan;if(op.requestId!==plan.intent.requestId||upgradeHash(proposal)!==planHash)throw new StoreError('conflict','升级回执与预览不一致');if(op.status==='cancelled')throw new StoreError('conflict','升级已停止，已生成修订保留');
    const unique=new Map<string,AssetDocument>();for(const c of plan.changes)if(c.action!=='reuse'){const asset=c.asset;if(!asset||canonical(upgradeRef(asset))!==canonical(c.target)||!plan.project.assetSnapshots.some(a=>canonical(a)===canonical(asset)))throw new StoreError('validation','升级回执缺少一致的目标资产');unique.set(canonical(c.target),asset);}
    if(op.status==='complete'){for(const asset of unique.values())if(canonical((await this.requirePublishedRevision(asset.assetId,asset.revision)).asset)!==canonical(asset))throw new StoreError('conflict','完成回执的资产修订已损坏');if(canonical(await this.readProject(plan.intent.projectId,plan.project.projectRevision))!==canonical(plan.project)||(await this.readProject(plan.intent.projectId)).projectRevision<plan.project.projectRevision)throw new StoreError('conflict','完成回执的项目修订或当前头异常');return op;}
    for(const asset of unique.values()){
      const change=plan.changes.find(c=>c.target.assetId===asset.assetId&&c.target.revision===asset.revision);if(!change)throw new StoreError('validation','升级创建项缺失');const dir=this.assetDir(asset.assetId),headRaw=await maybe(join(dir,'head.json'));assertVersion(headRaw);const head=headRaw===undefined?undefined:Head.parse(headRaw);if(head&&head.assetId!==asset.assetId)throw new StoreError('validation','资产头身份不符');const current=head?.revision??null,prior=await this.assetRevision(asset.assetId,asset.revision);
      if(prior!==undefined&&canonical(prior.asset)!==canonical(asset))throw new StoreError('conflict','升级目标修订已有不同内容，原文保留');if(isPublished(head,asset.revision)){if(prior===undefined)throw new StoreError('reference','已发布升级修订缺失');continue;}
      const expected=change.action==='revision'?change.base.revision:null;if(current!==expected)throw new StoreError('conflict','升级父资产基线已变化，未覆盖新头');if((await this.drafts()).some(d=>d.assetId===asset.assetId))throw new StoreError('conflict','父资产出现新草稿，未覆盖编辑');const diagnostics=validateAssets([asset],[...(await this.revisions()),asset]).filter(d=>d.severity==='error');if(diagnostics.length)throw new StoreError('reference',diagnostics.map(d=>d.message).join('; '));
      const format=change.action==='revision'?(await this.requireAssetRevision(change.base.assetId,change.base.revision)).format:'json';await this.writeAssetRevision(asset,format);await this.checkpoint?.('upgrade_before_head');await publishRevisionHead(dir,asset.assetId,asset.revision,current);await this.checkpoint?.('upgrade_after_head');
    }
    const projectRequestId='dependency-upgrade:'+op.requestId,projectPrior=await maybe(this.projectReceiptPath(projectRequestId)),history=await maybe(join(this.root,'projects','revisions',fileKey(plan.intent.projectId),plan.project.projectRevision+'.json')),projectPrepared=history!==undefined&&canonical(history)===canonical(plan.project);
    if(projectPrior===undefined&&!projectPrepared&&(await this.projectDrafts()).some(d=>d.projectId===plan.intent.projectId))throw new StoreError('conflict','项目出现新草稿，未覆盖编辑；可停止此升级后处理草稿');
    const current=await this.readProject(plan.intent.projectId),alreadyPublished=current.projectRevision>=plan.project.projectRevision&&projectPrepared;
    const saved=alreadyPublished?plan.project:await this.saveProjectUnlocked(plan.project,plan.intent.expectedProjectRevision,projectRequestId,canonical({kind:'dependency_upgrade',requestId:op.requestId,planHash}),undefined,'upgrade_before_project_receipt');if(canonical(saved)!==canonical(plan.project))throw new StoreError('conflict','升级项目与预览不一致');await this.checkpoint?.('upgrade_project_published');op.status='complete';await this.atomic(this.upgradePath(op.requestId),receipt);return op;
  }
}
