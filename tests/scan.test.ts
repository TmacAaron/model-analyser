import { describe,it,expect } from 'vitest';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { stringify } from 'yaml';
import { FileStore } from '../apps/local/src/store.js';
import { storageKey,scanFiles } from '../apps/local/src/scan.js';
import { AssetDraft,AssetDocument } from '@model-analyser/contracts';
import { fixture } from './fixtures.js';
async function workspace(fn:(root:string,builtin:string)=>Promise<void>){const root=await mkdtemp(resolve('data-test-'));const builtin=join(root,'builtin');await mkdir(builtin);try{await fn(root,builtin);}finally{await rm(root,{recursive:true,force:true});}}
const draft=(asset:AssetDocument,revision:number|null,generation:number)=>AssetDraft.parse({documentType:'asset_draft',schemaVersion:1,draftId:'d',assetId:asset.assetId,assetKind:asset.definition.kind,baseRevision:revision,draftGeneration:generation,updatedAt:new Date().toISOString(),candidate:asset});
describe('file isolation and explicit recovery',()=>{
  it('uses the same fresh revision closure for commits without consuming unrelated project snapshots, retaining full rescan diagnostics',async()=>workspace(async(root,builtin)=>{
    const a=fixture();await writeFile(join(builtin,'valid.json'),JSON.stringify(a));await mkdir(join(root,'projects'),{recursive:true});const badProject='{ incomplete';await writeFile(join(root,'projects','broken.json'),badProject);
    const full=await scanFiles(root,builtin),selected=await scanFiles(root,builtin,'revisions');expect(selected.revisions).toEqual(full.revisions);expect(selected.builtinRevisions).toEqual(full.builtinRevisions);expect(full.issues.some(i=>i.file.includes('projects'))).toBe(true);
    const store=new FileStore(root,builtin),custom=AssetDocument.parse({...a,assetId:'fresh-user-formula'});await store.saveDraft(draft(custom,null,1));expect((await store.commit('d',1,null)).revision).toBe(1);expect(await readFile(join(root,'projects','broken.json'),'utf8')).toBe(badProject);
    const updated=AssetDocument.parse({...a,name:a.name+' changed externally'});await writeFile(join(builtin,'valid.json'),JSON.stringify(updated));expect((await store.builtins()).find(v=>v.assetId===a.assetId)?.name).toBe(updated.name);expect((await store.revisions()).find(v=>v.assetId===a.assetId)?.name).toBe(updated.name);expect((await store.scan()).issues.some(i=>i.file.includes('projects'))).toBe(true);
  }));
  it('isolates malformed, future-version and semantically invalid files without touching source bytes',async()=>workspace(async(root,builtin)=>{
    const valid=fixture();await writeFile(join(builtin,'valid.yaml'),stringify(valid));
    const bad='{ incomplete',future=JSON.stringify({...valid,assetId:'future',schemaVersion:2});
    await writeFile(join(builtin,'broken.json'),bad);await writeFile(join(builtin,'future.json'),future);
    const invalid=structuredClone(valid);invalid.assetId=AssetDocument.shape.assetId.parse('invalid');if(invalid.definition.kind==='formula')invalid.definition.formula.expression='1 + missing';
    await writeFile(join(builtin,'invalid.json'),JSON.stringify(invalid));
    const store=new FileStore(root,builtin),scan=await store.scan();expect(scan.assets).toHaveLength(1);expect(scan.assets[0]?.format).toBe('yaml');
    expect(scan.issues.map(i=>i.code).sort()).toEqual(['reference','unsupported_version','validation']);expect(await readFile(join(builtin,'broken.json'),'utf8')).toBe(bad);expect(await readFile(join(builtin,'future.json'),'utf8')).toBe(future);
    const custom=AssetDocument.parse({...valid,assetId:'custom'});await store.saveDraft(draft(custom,null,1));expect((await store.commit('d',1,null)).revision).toBe(1);
  }));
  it('never treats an orphan as a committed dependency and permits explicit validated recovery',async()=>workspace(async(root,builtin)=>{
    const asset=AssetDocument.parse({...fixture(),assetId:'custom'});
    const failing=new FileStore(root,builtin,async()=>{throw Error('power loss');});await failing.saveDraft(draft(asset,null,1));await expect(failing.commit('d',1,null)).rejects.toThrow('power loss');
    const restarted=new FileStore(root,builtin);expect(await restarted.revisions()).toEqual([]);expect(await restarted.list()).toEqual([]);await expect(restarted.snapshot([{assetId:asset.assetId,revision:1,kind:'formula'}])).rejects.toThrow('缺少');
    const scan=await restarted.scan();expect(scan.recoveries).toEqual([{assetId:'custom',revision:1,name:asset.name,expectedRevision:null}]);
    expect((await restarted.recoverRevision('custom',1,null)).revision).toBe(1);expect((await restarted.list())[0]?.assetId).toBe('custom');expect((await restarted.scan()).recoveries).toEqual([]);
    await expect(restarted.recoverRevision('custom',1,null)).rejects.toThrow('已变化');
  }));
  it('refuses to overwrite future data in a draft or a project',async()=>workspace(async(root,builtin)=>{
    const asset=AssetDocument.parse({...fixture(),assetId:'custom'}),d=draft(asset,null,1);await new FileStore(root,builtin).saveDraft({...d,candidate:{...asset,schemaVersion:2}});
    const store=new FileStore(root,builtin);await expect(store.commit('d',1,null)).rejects.toMatchObject({code:'unsupported_version'});expect((await store.drafts())[0]?.candidate).toMatchObject({schemaVersion:2});
    await expect(store.saveProject({schemaVersion:2},null)).rejects.toMatchObject({code:'unsupported_version'});
  }));
  it('keeps both conflicting files and excludes ambiguous builtin revisions',async()=>workspace(async(root,builtin)=>{
    const asset=fixture();await writeFile(join(builtin,'one.json'),JSON.stringify(asset));await writeFile(join(builtin,'two.yaml'),stringify({...asset,name:'conflicting'}));
    const store=new FileStore(root,builtin);expect(await store.list()).toEqual([]);expect((await store.scan()).issues.some(i=>i.code==='conflict')).toBe(true);
    expect(await readFile(join(builtin,'one.json'),'utf8')).toBe(JSON.stringify(asset));
  }));
  it('does not silently recover through a corrupt head or lose valid drafts/projects to unrelated broken files',async()=>workspace(async(root,builtin)=>{
    const store=new FileStore(root,builtin),asset=AssetDocument.parse({...fixture(),assetId:'custom'});await store.saveDraft(draft(asset,null,1));
    const dir=join(root,'assets','user',storageKey('custom'));await mkdir(dir,{recursive:true});await writeFile(join(dir,'1.json'),JSON.stringify(asset));await writeFile(join(dir,'head.json'),'{');
    await writeFile(join(root,'assets','drafts','bad.json'),'{');await mkdir(join(root,'projects'),{recursive:true});await writeFile(join(root,'projects','future.json'),JSON.stringify({schemaVersion:2}));
    const scan=await store.scan();expect(scan.drafts).toHaveLength(1);expect(scan.recoveries).toEqual([]);expect(scan.assets).toEqual([]);expect(scan.issues).toHaveLength(4);
    await expect(store.recoverRevision('custom',1,null)).rejects.toThrow();expect(await readFile(join(dir,'head.json'),'utf8')).toBe('{');
  }));
});
