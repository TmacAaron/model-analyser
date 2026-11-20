import { describe,it,expect } from 'vitest';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { FileStore } from '../apps/local/src/store.js';
import { AssetDraft, AssetDocument } from '@model-analyser/contracts';
import { fixture } from './fixtures.js';
const builtin=(root:string)=>join(root,'builtin-fixtures');
const candidate=(expression='2 * M * N * K')=>{const a=fixture();if(a.definition.kind!=='formula')throw Error();return AssetDocument.parse({...a,assetId:'user:formula:a',definition:{kind:'formula',formula:{...a.definition.formula,expression}}});};
const draft=(a:AssetDocument,baseRevision:number|null,generation=1)=>AssetDraft.parse({documentType:'asset_draft',schemaVersion:1,draftId:'draft-a',assetId:a.assetId,assetKind:a.definition.kind,baseRevision,draftGeneration:generation,updatedAt:'2026-11-13T12:00:00.000Z',candidate:a});
async function withStore(fn:(store:FileStore,root:string)=>Promise<void>){const root=await mkdtemp(resolve('data-test-'));try{await mkdir(builtin(root));await fn(new FileStore(root,builtin(root)),root);}finally{await rm(root,{recursive:true,force:true});}}
describe('recoverable file persistence',()=>{
  it('persists drafts and immutable revisions across restart; archive preserves references',async()=>withStore(async(store,root)=>{
    await store.saveDraft(draft(candidate(),null));await store.commit('draft-a',1,null);
    const next=candidate('M * N * K');await store.saveDraft(draft(next,1,2));await store.commit('draft-a',2,1);
    const restarted=new FileStore(root,builtin(root));expect((await restarted.read(next.assetId)).revision).toBe(2);
    expect(await restarted.read(next.assetId,1)).toEqual(candidate());
    await restarted.archive(next.assetId,true);expect((await restarted.list()).some(a=>a.assetId===next.assetId)).toBe(false);expect((await restarted.read(next.assetId,1)).revision).toBe(1);
  }));
  it('detects stale generations and concurrent revisions',async()=>withStore(async(store)=>{
    const d=draft(candidate(),null,2);await store.saveDraft(d);await expect(store.saveDraft({...d,draftGeneration:1})).rejects.toThrow('草稿');
    await store.commit(d.draftId,2,null);await store.saveDraft({...d,draftGeneration:3});await expect(store.commit(d.draftId,3,null)).rejects.toThrow('资产已被修改');
  }));
  it('keeps old head and new draft on failed head replacement; retry recovers orphan revision',async()=>withStore(async(store,root)=>{
    await store.saveDraft(draft(candidate(),null));await store.commit('draft-a',1,null);
    const failing=new FileStore(root,builtin(root),async()=>{throw Error('injected disk failure');});
    await failing.saveDraft(draft(candidate('M*N*K'),1,2));await expect(failing.commit('draft-a',2,1)).rejects.toThrow('disk failure');
    const restarted=new FileStore(root,builtin(root));expect((await restarted.read(candidate().assetId)).revision).toBe(1);expect((await restarted.drafts())[0]?.draftGeneration).toBe(2);
    expect((await restarted.commit('draft-a',2,1)).revision).toBe(2);
  }));
  it('invalid edit remains draft while old formal definition remains usable',async()=>withStore(async(store)=>{
    await store.saveDraft(draft(candidate(),null));await store.commit('draft-a',1,null);
    await store.saveDraft(draft(candidate('2 ** M'),1,2));await expect(store.commit('draft-a',2,1)).rejects.toThrow();expect((await store.read(candidate().assetId)).revision).toBe(1);
  }));
  it('does not mint a new revision for unchanged normalized content',async()=>withStore(async(store)=>{
    await store.saveDraft(draft(candidate(),null));await store.commit('draft-a',1,null);await store.saveDraft(draft(candidate(),1,2));expect((await store.commit('draft-a',2,1)).revision).toBe(1);
  }));
  it('replays a lost successful commit response after restart without minting or moving revisions',async()=>withStore(async(store,root)=>{
    await store.saveDraft(draft(candidate(),null));await store.commit('draft-a',1,null,'request-1');
    const restarted=new FileStore(root,builtin(root));expect((await restarted.commit('draft-a',1,null,'request-1')).revision).toBe(1);
    await restarted.saveDraft(draft(candidate('M*N*K'),1,2));await restarted.commit('draft-a',2,1,'request-2');
    expect((await restarted.commit('draft-a',1,null,'request-1')).revision).toBe(1);expect((await restarted.read(candidate().assetId)).revision).toBe(2);
    await expect(restarted.commit('different-draft',1,null,'request-1')).rejects.toThrow('请求 ID');
  }));
  it('recovers a prepared request interrupted before head publication',async()=>withStore(async(store,root)=>{
    await store.saveDraft(draft(candidate(),null));await store.commit('draft-a',1,null);
    const failing=new FileStore(root,builtin(root),async()=>{throw Error('interrupted');});await failing.saveDraft(draft(candidate('M*N*K'),1,2));
    await expect(failing.commit('draft-a',2,1,'request-resume')).rejects.toThrow('interrupted');
    const restarted=new FileStore(root,builtin(root));expect((await restarted.read(candidate().assetId)).revision).toBe(1);
    expect((await restarted.commit('draft-a',2,1,'request-resume')).revision).toBe(2);expect(await restarted.drafts()).toEqual([]);
  }));
});
