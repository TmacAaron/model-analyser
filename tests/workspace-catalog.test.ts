import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {ProjectDocument,ProjectDraft,AssetDraft,WorkspaceCatalog} from '@model-analyser/contracts';
import {FileStore} from '../apps/local/src/store.js';
import {CatalogFileCache} from '../apps/local/src/catalog-cache.js';
import {storageKey} from '../apps/local/src/scan.js';
import {fixture} from './fixtures.js';
export const emptyProject=(projectId='catalog-project')=>ProjectDocument.parse({documentType:'project',schemaVersion:1,projectId,projectRevision:1,name:'Catalog project',scenarios:[],assetSnapshots:[],measurements:[],viewState:{nodes:[]}});
async function isolated(run:(root:string,store:FileStore)=>Promise<void>){const root=await mkdtemp(resolve('data-test-catalog-'));const safe=()=>{if(dirname(resolve(root))!==resolve('.')||!basename(root).startsWith('data-test-catalog-'))throw Error('Unsafe test cleanup');};try{await run(root,new FileStore(root,join(root,'absent-builtins')));}finally{safe();await rm(root,{recursive:true,force:true});}}
it('catalog excludes large project snapshots and raw candidates while full selected reads and diagnostic scan retain them',async()=>isolated(async(root,store)=>{
 const project=emptyProject(),asset=fixture();asset.sources=[];asset.name='embedded large snapshot';asset.tags=['x'.repeat(1024*1024)];project.assetSnapshots=[asset];await store.saveProject(project,null,'catalog-save');
 const raw='{ invalid '+ 'z'.repeat(17*1024*1024),draft=ProjectDraft.parse({documentType:'project_draft',schemaVersion:1,draftId:'large-draft',projectId:project.projectId,baseProjectRevision:1,draftGeneration:1,updatedAt:'2026-11-16T00:00:00.000Z',candidate:raw});await store.saveProjectDraft(draft);
 const ad=AssetDraft.parse({documentType:'asset_draft',schemaVersion:1,draftId:'asset-draft',assetId:asset.assetId,assetKind:'formula',baseRevision:null,draftGeneration:1,updatedAt:draft.updatedAt,candidate:asset});await store.saveDraft(ad);
 const catalog=WorkspaceCatalog.parse(await store.catalog());expect(JSON.stringify(catalog).length).toBeLessThan(3000);expect(catalog.projects[0]).toMatchObject({projectId:project.projectId,assetSnapshotCount:1,scenarios:[]});expect(catalog.projects[0]).not.toHaveProperty('assetSnapshots');expect(catalog.projectDrafts[0]).not.toHaveProperty('candidate');expect(catalog.drafts[0]).not.toHaveProperty('candidate');
 expect((await store.readProject(project.projectId)).assetSnapshots[0]?.tags[0]?.length).toBe(1024*1024);expect((await store.readProjectDraft(draft.draftId)).candidate).toBe(raw);expect((await store.readAssetDraft(ad.draftId)).candidate).toEqual(asset);
 const full=await store.scan();expect(full.projectDrafts[0]?.candidate).toBe(raw);expect(full.projects[0]?.assetSnapshots[0]?.tags[0]?.length).toBe(1024*1024);
}),20000);
it('catalog cache reuses detached metadata, observes external changes, and supports forced fresh validation',async()=>isolated(async(root)=>{
 const cache=new CatalogFileCache(),file=join(root,'project.json'),project=emptyProject();await writeFile(file,JSON.stringify(project));let reads=0;const summarize=(value:ProjectDocument)=>{reads++;return {name:value.name};};
 expect(await cache.read('project',file,ProjectDocument,summarize)).toEqual({name:project.name});expect(await cache.read('project',file,ProjectDocument,summarize)).toEqual({name:project.name});expect(reads).toBe(1);
 await cache.read('project',file,ProjectDocument,summarize,true);expect(reads).toBe(2);await writeFile(file,JSON.stringify({...project,name:'external change'}));expect(await cache.read('project',file,ProjectDocument,summarize)).toEqual({name:'external change'});expect(reads).toBe(3);
 await writeFile(file,'{ corrupt');await expect(cache.read('project',file,ProjectDocument,summarize)).rejects.toThrow();expect(await readFile(file,'utf8')).toBe('{ corrupt');
}));
it('catalog keeps malformed, future and mismatched identity diagnostics; selected drafts never use cached bodies',async()=>isolated(async(root,store)=>{
 const project=emptyProject();await store.saveProject(project,null,'save');const dir=join(root,'projects','drafts');await mkdir(dir,{recursive:true});const draft=ProjectDraft.parse({documentType:'project_draft',schemaVersion:1,draftId:'selected',projectId:project.projectId,baseProjectRevision:1,draftGeneration:1,updatedAt:'2026-11-16T00:00:00.000Z',candidate:'old raw'});await store.saveProjectDraft(draft);await store.catalog();
 const file=join(dir,storageKey(draft.draftId)+'.json');await writeFile(file,JSON.stringify({...draft,candidate:'fresh raw',draftGeneration:2}));expect((await store.readProjectDraft(draft.draftId)).candidate).toBe('fresh raw');expect((await store.catalog()).projectDrafts[0]?.draftGeneration).toBe(2);
 await writeFile(file,JSON.stringify({...draft,draftId:'mismatched'}));await expect(store.readProjectDraft(draft.draftId)).rejects.toMatchObject({code:'validation'});await writeFile(join(root,'projects','bad.json'),'{');await writeFile(join(root,'projects','future.json'),JSON.stringify({schemaVersion:2}));const catalog=await store.catalog(true);expect(catalog.projectDrafts).toEqual([]);expect(catalog.issues.map(i=>i.code).sort()).toEqual(['unsupported_version','validation','validation']);await expect(store.readProjectDraft('missing')).rejects.toMatchObject({code:'not_found'});
}));
it('a commit replaces catalog metadata and removes its completed draft',async()=>isolated(async(root,store)=>{
 const project=emptyProject();await store.saveProject(project,null,'save');const draft=ProjectDraft.parse({documentType:'project_draft',schemaVersion:1,draftId:'commit-draft',projectId:project.projectId,baseProjectRevision:1,draftGeneration:1,updatedAt:'2026-11-16T00:00:00.000Z',candidate:{...project,name:'renamed'}});await store.saveProjectDraft(draft);const first=store.catalog(),joined=store.catalog();expect(first).toBe(joined);expect((await first).projectDrafts).toHaveLength(1);await store.commitProjectDraft(draft.draftId,1,1,'commit');const next=await store.catalog();expect(next.projects[0]).toMatchObject({projectRevision:2,name:'renamed'});expect(next.projectDrafts).toEqual([]);
}));
