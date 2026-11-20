import {listenForFetch} from './http-listener.js';
import {it,expect} from 'vitest';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {resolve,dirname,basename,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ProjectDocument,ProjectDraft} from '@model-analyser/contracts';
import {FileStore} from '../../apps/local/src/store.js';
import {createApp} from '../../apps/local/src/server.js';
import {storageKey} from '../../apps/local/src/scan.js';
import {projectAtFileBoundary} from '../project-export-fixture.js';
import {PROJECT_TEXT_BYTES} from '../../packages/contracts/src/project-limits.js';
import {analyzeScenario} from '@model-analyser/core';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
async function isolated(run:(root:string,store:FileStore,url:string)=>Promise<void>){
 const root=await mkdtemp(resolve('data-test-project-export-size-'));const safe=()=>dirname(resolve(root))===resolve('.')&&basename(root).startsWith('data-test-project-export-size-');if(!safe())throw Error('Unexpected test root');
 const store=new FileStore(root,join(root,'absent-builtins')),server=createApp(store);await listenForFetch(server);const address=server.address();if(!address||typeof address==='string')throw Error('Missing server address');
 try{await run(root,store,'http://127.0.0.1:'+address.port);}finally{await new Promise<void>((done,reject)=>server.close(e=>e?reject(e):done()));if(!safe())throw Error('Unsafe cleanup');await rm(root,{recursive:true,force:true});}
}
async function files(root:string,prefix=''):Promise<string[]>{const result:string[]=[];for(const entry of await readdir(join(root,prefix),{withFileTypes:true})){const path=join(prefix,entry.name);if(entry.isDirectory())result.push(...await files(root,path));else result.push(path);}return result.sort();}
it('an exact32MiB Unicode/escaped formal file exports below the source cap, reopens in an empty library and recomputes from its snapshots',async()=>isolated(async(root,store,url)=>{
 const project=projectAtFileBoundary(),requestId=randomUUID(),saved=await store.saveProject(project,null,requestId),path=join(root,'projects',storageKey(project.projectId)+'.json'),disk=await readFile(path,'utf8');expect(Buffer.byteLength(disk)).toBe(PROJECT_TEXT_BYTES);
 const exported=JSON.stringify(saved,null,2);expect(Buffer.byteLength(exported)).toBe(PROJECT_TEXT_BYTES-1);expect(digest(exported+'\n')).toBe(digest(disk));
 const response=await fetch(url+'/api/v1/decode-project-text?format=json',{method:'POST',body:exported});expect(response.status).toBe(200);const decoded=ProjectDocument.parse((await response.json()).data);expect(digest(JSON.stringify(decoded))).toBe(digest(JSON.stringify(saved)));
 await isolated(async(_offlineRoot,offline)=>{expect(await offline.list()).toHaveLength(0);const portable=await offline.saveProject(decoded,null,randomUUID());expect(digest(JSON.stringify(portable))).toBe(digest(JSON.stringify(saved)));const scenario=portable.scenarios[0];if(!scenario)throw Error('Missing scenario');const result=await analyzeScenario(scenario,portable.assetSnapshots),original=await analyzeScenario(scenario,project.assetSnapshots);expect(result).toEqual(original);expect(result.status).toBe('available');});
 const reopened=new FileStore(root,join(root,'absent-builtins'));expect(digest(JSON.stringify(await reopened.readProject(project.projectId)))).toBe(digest(JSON.stringify(saved)));const beforeReplay=await files(root);expect(digest(JSON.stringify(await reopened.saveProject(project,null,requestId)))).toBe(digest(JSON.stringify(saved)));expect(await files(root)).toEqual(beforeReplay);
}),60000);
it('one byte beyond the formal file boundary rejects before receipt/revision writes and preserves a failed raw draft and the previous exact-size revision',async()=>isolated(async(root,store)=>{
 const project=projectAtFileBoundary(),saved=await store.saveProject(project,null,randomUUID()),path=join(root,'projects',storageKey(project.projectId)+'.json'),prior=digest(await readFile(path,'utf8')),over={...saved,name:saved.name+'x'},before=await files(root);
 expect(Buffer.byteLength(JSON.stringify(over,null,2)+'\n')).toBe(PROJECT_TEXT_BYTES+1);await expect(store.saveProject(over,1,'formal-one-byte-over')).rejects.toThrow('32 MiB');expect(await files(root)).toEqual(before);
 const candidate=JSON.stringify(over),draft=ProjectDraft.parse({documentType:'project_draft',schemaVersion:1,draftId:randomUUID(),projectId:project.projectId,baseProjectRevision:1,draftGeneration:1,updatedAt:new Date().toISOString(),candidate,editorFormat:'json'});expect(Buffer.byteLength(candidate)).toBeLessThan(PROJECT_TEXT_BYTES);await store.saveProjectDraft(draft);const withDraft=await files(root);await expect(store.commitProjectDraft(draft.draftId,1,1,'draft-one-byte-over')).rejects.toThrow('32 MiB');expect(await files(root)).toEqual(withDraft);expect(digest(await readFile(path,'utf8'))).toBe(prior);
 const reopened=new FileStore(root,join(root,'absent-builtins'));expect((await reopened.readProject(project.projectId)).projectRevision).toBe(1);expect(digest(String((await reopened.projectDrafts())[0]?.candidate))).toBe(digest(candidate));await expect(reopened.readProject(project.projectId,2)).rejects.toThrow('不存在');
}),60000);
