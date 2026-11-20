import { describe,it,expect } from 'vitest';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ProjectDocument,ProjectDraft } from '@model-analyser/contracts';
import { FileStore } from '../apps/local/src/store.js';
import { validateProject } from '../packages/contracts/src/validation.js';
async function example(){return ProjectDocument.parse(JSON.parse(await readFile('examples/contracts/project.json','utf8')) as unknown);}
async function workspace(fn:(root:string,store:FileStore)=>Promise<void>){const root=await mkdtemp(resolve('data-test-'));try{await fn(root,new FileStore(root,resolve('absent-builtins')));}finally{await rm(root,{recursive:true,force:true});}}
function draft(p:ProjectDocument,base:number|null,generation:number){return ProjectDraft.parse({documentType:'project_draft',schemaVersion:1,draftId:'project-draft',projectId:p.projectId,baseProjectRevision:base,draftGeneration:generation,updatedAt:'2026-11-14T00:00:00.000Z',candidate:p});}
describe('recoverable project editing and idempotent saves',()=>{
  it('opens a portable project without a library, preserves formal data during invalid edits, and recovers the draft',async()=>workspace(async(root,store)=>{
    const p=await example();await store.saveProjectDraft(draft(p,null,1));await store.commitProjectDraft('project-draft',1,null,'create-project');
    await store.saveProjectDraft({...draft(p,1,2),candidate:'{ incomplete project JSON'});await expect(store.commitProjectDraft('project-draft',2,1,'invalid-project')).rejects.toThrow();
    const restarted=new FileStore(root,resolve('no-library'));expect((await restarted.readProject(p.projectId)).assetSnapshots).toEqual(p.assetSnapshots);
    expect((await restarted.projectDrafts())[0]?.candidate).toBe('{ incomplete project JSON');
    const changed={...p,name:'renamed project'};await restarted.saveProjectDraft(draft(changed,1,3));expect((await restarted.commitProjectDraft('project-draft',3,1,'changed-project')).projectRevision).toBe(2);expect(await restarted.projectDrafts()).toEqual([]);
  }));
  it('replays direct writes across restart and refuses request ID reuse for different content',async()=>workspace(async(root,store)=>{
    const p=await example();const saved=await store.saveProject(p,null,'project-save-request');
    const restarted=new FileStore(root,resolve('no-library'));expect(await restarted.saveProject(p,null,'project-save-request')).toEqual(saved);
    await expect(restarted.saveProject({...p,name:'different'},null,'project-save-request')).rejects.toThrow('请求 ID');
    await restarted.saveProject({...p,name:'revision 2'},1,'new-save');expect((await restarted.saveProject(p,null,'project-save-request')).projectRevision).toBe(1);expect((await restarted.readProject(p.projectId)).projectRevision).toBe(2);expect((await restarted.readProject(p.projectId,1)).name).toBe(p.name);
  }));
  it('replays prepared draft commits after publication failure and does not delete newer drafts',async()=>workspace(async(root,store)=>{
    const p=await example();await store.saveProject(p,null);
    const failing=new FileStore(root,resolve('no-library'),async(stage)=>{if(stage==='before_project_publish')throw Error('disk interrupted');});
    await failing.saveProjectDraft(draft({...p,name:'next'},1,2));await expect(failing.commitProjectDraft('project-draft',2,1,'request-next')).rejects.toThrow('disk interrupted');
    const restarted=new FileStore(root,resolve('no-library'));expect((await restarted.readProject(p.projectId)).projectRevision).toBe(1);
    await restarted.saveProjectDraft({...draft(p,1,3),candidate:'newer edit'});
    expect((await restarted.commitProjectDraft('project-draft',2,1,'request-next')).projectRevision).toBe(2);
    expect((await restarted.projectDrafts())[0]?.draftGeneration).toBe(3);
  }));
  it('detects stale generations, project revisions and mutation of an existing snapshot revision',async()=>workspace(async(_root,store)=>{
    const p=await example();await store.saveProjectDraft(draft(p,null,2));await expect(store.saveProjectDraft(draft(p,null,1))).rejects.toThrow('代次');
    await store.commitProjectDraft('project-draft',2,null,'first');await expect(store.saveProject(p,null)).rejects.toThrow('项目已变化');
    const bad=structuredClone(p);if(bad.assetSnapshots[0])bad.assetSnapshots[0].name='same revision changed';await expect(store.saveProject(bad,1)).rejects.toThrow('同资产修订');
    expect((await store.readProject(p.projectId)).projectRevision).toBe(1);
  }));
  it('does not create a new revision when the normalized project content is unchanged',async()=>workspace(async(_root,store)=>{
    const p=await example();await store.saveProject(p,null);expect((await store.saveProject({...p,projectRevision:999},1)).projectRevision).toBe(1);
  }));
  it('rejects duplicate scenario identity without losing the draft and preserves historical measurement scope',async()=>workspace(async(_root,store)=>{
    const p=await example();if(!p.scenarios[0])throw Error();p.scenarios.push(structuredClone(p.scenarios[0]));await store.saveProjectDraft(draft(p,null,1));await expect(store.commitProjectDraft('project-draft',1,null)).rejects.toThrow('scenarios ID');
    p.scenarios.pop();if(p.measurements[0])p.measurements[0].phase='prefill';await store.saveProjectDraft(draft(p,null,2));expect(validateProject(p).some(d=>d.code==='unknown_measurement_scope'&&d.severity==='warning')).toBe(true);const saved=await store.commitProjectDraft('project-draft',2,null);expect(saved.measurements[0]?.phase).toBe('prefill');expect(saved.measurements[0]?.inputHash).toBe(p.measurements[0]?.inputHash);
  }));
});
