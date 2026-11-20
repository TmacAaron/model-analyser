import { it,expect } from 'vitest';
import { mkdtemp,mkdir,readFile,writeFile,readdir,rename,rm } from 'node:fs/promises';
import { resolve,join,sep } from 'node:path';
import { stringify } from 'yaml';
import { AssetDocument,AssetDraft,type ProjectDocument } from '@model-analyser/contracts';
import { assetDependencies,canonical } from '../packages/contracts/src/validation.js';
import { analyzeScenario } from '@model-analyser/core';
import { FileStore,decodeDocument } from '../apps/local/src/store.js';
import { storageKey } from '../apps/local/src/scan.js';
import { atomicWriteDocument } from '../apps/local/src/atomic-file.js';
import { fixture } from './fixtures.js';
import { makeUpgradeProject } from '../scripts/upgrade-project.js';
import { upgradeRef } from '../packages/contracts/src/dependency-upgrade.js';

type Format=NonNullable<AssetDraft['storageFormat']>;
const draft=(asset:AssetDocument,baseRevision:number|null,generation=1,storageFormat?:Format)=>AssetDraft.parse({documentType:'asset_draft',schemaVersion:1,draftId:asset.assetId+':draft',assetId:asset.assetId,assetKind:asset.definition.kind,baseRevision,draftGeneration:generation,updatedAt:'2026-11-15T00:00:00.000Z',candidate:asset,...(storageFormat?{storageFormat}:{})});
async function publish(store:FileStore,a:AssetDocument,base:number|null=null,storageFormat?:Format,generation=1,requestId?:string){const d=draft(a,base,generation,storageFormat);await store.saveDraft(d);return store.commit(d.draftId,generation,base,requestId);}
async function workspace(fn:(store:FileStore,root:string,builtin:string)=>Promise<void>){const parent=resolve('data');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'yaml-storage-')),builtin=join(root,'builtin');try{await mkdir(builtin);await fn(new FileStore(root,builtin),root,builtin);}finally{if(!resolve(root).startsWith(parent+sep))throw Error('Unsafe cleanup');await rm(root,{recursive:true,force:true});}}
const asset=()=>AssetDocument.parse({...fixture(),assetId:'yaml:formula',name:'true: # 中文 001'});
const dir=(root:string,id:string)=>join(root,'assets','user',storageKey(id));

it('keeps one YAML authority, round trips scalar types and inherits YAML for subsequent semantic edits',async()=>workspace(async(store,root,builtin)=>{
  const a=asset();await publish(store,a,null,'yaml');const first=await readFile(join(dir(root,a.assetId),'1.yaml'),'utf8');expect(AssetDocument.parse(decodeDocument(first,'yaml'))).toEqual(a);expect(first).not.toBe(JSON.stringify(a));expect((await store.list())[0]?.format).toBe('yaml');
  const restarted=new FileStore(root,builtin);await publish(restarted,{...a,name:'Edited name'},1,undefined,2);expect((await restarted.read(a.assetId)).revision).toBe(2);expect((await restarted.list())[0]?.format).toBe('yaml');expect((await readdir(dir(root,a.assetId))).sort()).toEqual(['1.yaml','2.yaml','head.json']);expect(await readFile(join(dir(root,a.assetId),'1.yaml'),'utf8')).toBe(first);
}));

it('defaults new assets to JSON, permits a new semantic revision in another format and replays old JSON receipts after a YAML head',async()=>workspace(async(store,root,builtin)=>{
  const a=asset();await publish(store,a,null,undefined,1,'old-json-request');const receiptPath=join(root,'operations',storageKey('old-json-request')+'.json'),receipt=JSON.parse(await readFile(receiptPath,'utf8')) as Record<string,unknown>;delete receipt.storageFormat;await writeFile(receiptPath,JSON.stringify(receipt));const before=await readFile(join(dir(root,a.assetId),'1.json'),'utf8');await publish(store,{...a,name:'YAML new semantics'},1,'yaml',2,'new-yaml-request');const restarted=new FileStore(root,builtin);expect((await restarted.commit(draft(a,null).draftId,1,null,'old-json-request')).revision).toBe(1);expect((await restarted.read(a.assetId)).revision).toBe(2);expect((await restarted.list())[0]?.format).toBe('yaml');expect(await readFile(join(dir(root,a.assetId),'1.json'),'utf8')).toBe(before);
  await publish(restarted,{...a,name:'JSON new semantics'},2,'json',3);expect((await restarted.list())[0]?.format).toBe('json');expect((await readdir(dir(root,a.assetId))).sort()).toEqual(['1.json','2.yaml','3.json','head.json']);
}));

it('never rewrites or duplicates an unchanged revision merely to change serialization',async()=>workspace(async(store,root)=>{
  const a=asset();await publish(store,a,null,'yaml');const before=await readFile(join(dir(root,a.assetId),'1.yaml'),'utf8');expect((await publish(store,a,1,'json',2,'unchanged-format-request')).revision).toBe(1);expect((await store.list())[0]?.format).toBe('yaml');expect((await readdir(dir(root,a.assetId))).sort()).toEqual(['1.yaml','head.json']);expect(await readFile(join(dir(root,a.assetId),'1.yaml'),'utf8')).toBe(before);expect((await store.commit(draft(a,1,2).draftId,2,1,'unchanged-format-request')).revision).toBe(1);
}));

it('restores the chosen format with incomplete drafts and preserves the last valid definition',async()=>workspace(async(store,root,builtin)=>{
  const a=asset();await publish(store,a,null,'yaml');const d={...draft(a,1,2,'yaml'),candidate:'{ incomplete'};await store.saveDraft(d);await expect(store.commit(d.draftId,2,1)).rejects.toThrow();const restarted=new FileStore(root,builtin);expect(await restarted.drafts()).toEqual([d]);expect(await restarted.read(a.assetId)).toEqual(a);expect((await readdir(dir(root,a.assetId))).sort()).toEqual(['1.yaml','head.json']);
}));

it('replays a failed YAML publication across restart without losing a newer draft or moving an old head backwards',async()=>workspace(async(store,root,builtin)=>{
  const a=asset();await publish(store,a);const before=await readFile(join(dir(root,a.assetId),'1.json'),'utf8'),next={...a,name:'Pending YAML'},failing=new FileStore(root,builtin,async stage=>{if(stage==='before_head')throw Error('injected publication failure');});await expect(publish(failing,next,1,'yaml',2,'resume-yaml')).rejects.toThrow('injected');const restarted=new FileStore(root,builtin);expect((await restarted.read(a.assetId)).revision).toBe(1);expect((await restarted.scan()).recoveries).toMatchObject([{revision:2}]);const newer={...draft(next,1,3,'yaml'),candidate:'newer incomplete input'};await restarted.saveDraft(newer);expect((await restarted.commit(draft(next,1,2).draftId,2,1,'resume-yaml')).revision).toBe(2);expect(await restarted.drafts()).toEqual([newer]);expect((await restarted.list())[0]?.format).toBe('yaml');expect(await readFile(join(dir(root,a.assetId),'1.json'),'utf8')).toBe(before);
}));

it('explicitly recovers one orphan .yml authority and keeps its original bytes',async()=>workspace(async(store,root)=>{
  const a=asset(),path=join(dir(root,a.assetId),'1.yml'),source=stringify(a);await mkdir(dir(root,a.assetId),{recursive:true});await writeFile(path,source);expect((await store.scan()).recoveries).toMatchObject([{assetId:a.assetId,revision:1,expectedRevision:null}]);expect((await store.recoverRevision(a.assetId,1,null)).revision).toBe(1);expect((await store.list())[0]?.format).toBe('yaml');expect(await readFile(path,'utf8')).toBe(source);await publish(store,{...a,name:'New canonical YAML'},1,undefined,2);expect((await readdir(dir(root,a.assetId))).sort()).toEqual(['1.yml','2.yaml','head.json']);
}));

it('isolates even identical duplicate authorities and refuses commits or recovery without touching either file',async()=>workspace(async(store,root)=>{
  const a=asset();await publish(store,a,null,'yaml');const yaml=await readFile(join(dir(root,a.assetId),'1.yaml'),'utf8'),json=JSON.stringify(a);await writeFile(join(dir(root,a.assetId),'1.json'),json);const scan=await store.scan();expect(scan.assets).toEqual([]);expect(scan.recoveries).toEqual([]);expect(scan.issues.filter(i=>i.code==='conflict')).toHaveLength(2);await expect(store.read(a.assetId)).rejects.toThrow();await expect(publish(store,{...a,name:'Never publish'},1,undefined,2)).rejects.toMatchObject({code:'conflict'});expect(await readFile(join(dir(root,a.assetId),'1.yaml'),'utf8')).toBe(yaml);expect(await readFile(join(dir(root,a.assetId),'1.json'),'utf8')).toBe(json);await expect(store.recoverRevision(a.assetId,2,1)).rejects.toThrow();expect((await readdir(dir(root,a.assetId))).sort()).toEqual(['1.json','1.yaml','head.json']);
}));

it('isolates malformed and future managed YAML while leaving a valid prior revision and unrelated assets usable',async()=>workspace(async(store,root,builtin)=>{
  const a=asset();await publish(store,a);const malformed='documentType: !javascript unsafe';await writeFile(join(dir(root,a.assetId),'2.yaml'),malformed);await writeFile(join(builtin,'valid.yaml'),stringify({...a,assetId:'unrelated'}));const scan=await store.scan();expect(scan.assets.map(a=>a.assetId).sort()).toEqual(['unrelated',a.assetId].sort());expect(scan.issues.some(i=>i.file.endsWith('2.yaml')&&i.code==='validation')).toBe(true);expect(await readFile(join(dir(root,a.assetId),'2.yaml'),'utf8')).toBe(malformed);const future=stringify({...a,revision:2,schemaVersion:2});await writeFile(join(dir(root,a.assetId),'2.yaml'),future);expect((await store.scan()).issues.some(i=>i.code==='unsupported_version')).toBe(true);await expect(publish(store,{...a,name:'Blocked future revision'},1,'yaml',2)).rejects.toMatchObject({code:'unsupported_version'});expect(await readFile(join(dir(root,a.assetId),'2.yaml'),'utf8')).toBe(future);
}));

it('uses the same atomic replacement protection for YAML and cleans a failed temporary write',async()=>workspace(async(_store,root)=>{
  const path=join(root,'sample.yaml'),before='previous: true\n';await writeFile(path,before);const delays:number[]=[];await expect(atomicWriteDocument(path,{next:true},'yaml',{platform:'win32',replace:async()=>{throw Object.assign(Error('locked'),{code:'EPERM'});},wait:async ms=>{delays.push(ms);expect(await readFile(path,'utf8')).toBe(before);}})).rejects.toThrow('locked');expect(delays).toEqual([50,100,200,400]);expect((await readdir(root)).sort()).toEqual(['builtin','sample.yaml']);
}));

it('rejects an oversized serialized YAML revision before publication while keeping its smaller JSON recovery draft readable',async()=>workspace(async(store,root)=>{
  const a=AssetDocument.parse({...asset(),sources:[{kind:'note',text:'a\n'.repeat(800000)}]});await expect(publish(store,a,null,'yaml')).rejects.toMatchObject({code:'validation'});expect((await store.list())).toEqual([]);expect((await store.drafts())[0]?.storageFormat).toBe('yaml');await expect(readdir(dir(root,a.assetId))).rejects.toMatchObject({code:'ENOENT'});
}));

it('rejects identical JSON/YAML orphan and builtin duplicates as ambiguous instead of choosing by directory order',async()=>workspace(async(store,root,builtin)=>{
  const a=asset(),d=dir(root,a.assetId);await mkdir(d,{recursive:true});await writeFile(join(d,'1.json'),JSON.stringify(a));await writeFile(join(d,'1.yaml'),stringify(a));await writeFile(join(builtin,'one.json'),JSON.stringify({...a,assetId:'builtin:duplicate'}));await writeFile(join(builtin,'two.yaml'),stringify({...a,assetId:'builtin:duplicate'}));const scan=await store.scan();expect(scan.assets).toEqual([]);expect(scan.recoveries).toEqual([]);expect(scan.issues.filter(i=>i.code==='conflict')).toHaveLength(3);await expect(store.recoverRevision(a.assetId,1,null)).rejects.toMatchObject({code:'conflict'});expect((await readdir(d)).sort()).toEqual(['1.json','1.yaml']);
}));

it('does not silently reinterpret a YAML commit receipt after its immutable file format was externally changed',async()=>workspace(async(store,root)=>{
  const a=asset();await publish(store,a,null,'yaml',1,'yaml-receipt');await rename(join(dir(root,a.assetId),'1.yaml'),join(dir(root,a.assetId),'1.json'));await writeFile(join(dir(root,a.assetId),'1.json'),JSON.stringify(a));await expect(store.commit(draft(a,null).draftId,1,null,'yaml-receipt')).rejects.toMatchObject({code:'conflict'});expect(await readFile(join(dir(root,a.assetId),'1.json'),'utf8')).toBe(JSON.stringify(a));
}));

async function analyze(p:ProjectDocument){const a=await analyzeScenario(p.scenarios[0]!,p.assetSnapshots);if(a.status!=='available')throw Error(JSON.stringify(a.diagnostics));return a.result;}
async function publishClosure(store:FileStore,assets:AssetDocument[],format:Format){const seen=new Set<string>();async function visit(a:AssetDocument){const key=a.assetId+'@'+a.revision;if(seen.has(key))return;for(const ref of assetDependencies(a)){const child=assets.find(c=>c.assetId===ref.assetId&&c.revision===ref.revision);if(!child)throw Error('Missing test closure');await visit(child);}await publish(store,a,null,format);seen.add(key);}for(const a of assets)await visit(a);}

it('round trips a complete YAML model closure into JSON project snapshots with identical independent math and input hash',async()=>workspace(async(store)=>{
  const {project}=makeUpgradeProject(),before=await analyze(project);await publishClosure(store,project.assetSnapshots,'yaml');const assets=await store.snapshot([project.scenarios[0]!.model,...project.scenarios[0]!.deviceTopology.devices.map(d=>d.hardware)]),portable={...project,assetSnapshots:assets};const after=await analyze(portable);expect(after.inputHash).toBe(before.inputHash);expect(after.total.seconds).toMatchObject({status:'available',quantity:{value:4.48}});expect(after.total.hbmBytes).toMatchObject({status:'available',quantity:{value:448}});const saved=await store.saveProject(portable,null);expect((await analyze(await store.readProject(saved.projectId))).inputHash).toBe(before.inputHash);expect((await store.list()).every(a=>a.format==='yaml')).toBe(true);
}));

it('preserves YAML ancestor formats across interrupted dependency upgrade, complete replay and old project reconstruction',async()=>workspace(async(store,root,builtin)=>{
  const {project,formula,updated}=makeUpgradeProject();await publishClosure(store,project.assetSnapshots,'yaml');await publish(store,updated,1,undefined,2);await store.saveProject(project,null,'old-project');const before=await analyze(project),intent={requestId:'yaml-upgrade',projectId:project.projectId,expectedProjectRevision:1,scenarioId:project.scenarios[0]!.scenarioId,selections:[{from:upgradeRef(formula),to:upgradeRef(updated)}]},plan=await store.previewDependencyUpgrade(intent),failing=new FileStore(root,builtin,async stage=>{if(stage==='upgrade_before_head')throw Error('interrupted YAML ancestor');});await expect(failing.applyDependencyUpgrade({...intent,planHash:plan.planHash})).rejects.toThrow('interrupted YAML');const restarted=new FileStore(root,builtin);expect((await restarted.resumeDependencyUpgrade(intent.requestId)).status).toBe('complete');expect((await restarted.resumeDependencyUpgrade(intent.requestId)).status).toBe('complete');const next=await analyze(await restarted.readProject(project.projectId));expect(next.total.seconds).toMatchObject({status:'available',quantity:{value:10.24}});expect((await analyze(await restarted.readProject(project.projectId,1))).inputHash).toBe(before.inputHash);for(const c of plan.changes.filter(c=>c.action==='revision')){expect((await readdir(dir(root,c.target.assetId))).filter(n=>n.startsWith(c.target.revision+'.'))).toEqual([c.target.revision+'.yaml']);expect((await restarted.list()).find(a=>a.assetId===c.target.assetId)?.format).toBe('yaml');}expect(canonical(await restarted.readProject(project.projectId))).toBe(canonical(plan.project));
}));
