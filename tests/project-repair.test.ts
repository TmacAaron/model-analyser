import {it,expect,afterAll} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {basename,dirname,resolve} from 'node:path';import {stringify} from 'yaml';
import {ProjectDocument,ProjectDraft} from '@model-analyser/contracts';
import {decodeProjectImport} from '../apps/local/src/project-import.js';
import {FileStore} from '../apps/local/src/store.js';
import {analyzeScenario} from '@model-analyser/core';
import {parseProjectText,rewriteProjectTextIdentity} from '../packages/contracts/src/project-text.js';
const roots:string[]=[];
async function newStore(){const root=await mkdtemp(resolve('data-test-project-repair-'));roots.push(root);return new FileStore(root,resolve('absent-builtins'));}
afterAll(async()=>{for(const root of roots){if(dirname(resolve(root))!==resolve('.')||!basename(root).startsWith('data-test-project-repair-'))throw Error('Unexpected test directory');await rm(root,{recursive:true,force:true});}});
const original=async()=>ProjectDocument.parse(JSON.parse(await readFile('examples/contracts/project.json','utf8')));
it.each(['json','yaml'] as const)('preserves exact invalid %s source, then commits the repaired raw draft through normal revision guards',async format=>{
 const p=await original(),broken=JSON.parse(JSON.stringify(p));delete broken.scenarios[0].deviceTopology.groups;
 const text=format==='yaml'?'# preserve source comment\r\n'+stringify(broken):JSON.stringify(broken,null,3)+'\r\n',decoded=decodeProjectImport(text,format);expect(decoded.ordinaryRecovery).toBe(true);expect(decoded.document).toMatchObject({documentType:'project_recovery',projectId:p.projectId,editorText:text,editorFormat:format});
 const store=await newStore(),draft=ProjectDraft.parse({documentType:'project_draft',schemaVersion:1,draftId:'raw-project',projectId:p.projectId,baseProjectRevision:null,draftGeneration:1,updatedAt:new Date().toISOString(),candidate:text,editorFormat:format});await store.saveProjectDraft(draft);expect((await store.projectDrafts())[0]?.candidate).toBe(text);await expect(store.commitProjectDraft(draft.draftId,1,null,'invalid')).rejects.toThrow();expect(await store.projects()).toHaveLength(0);
 const fixed=format==='yaml'?stringify(p):JSON.stringify(p);await store.saveProjectDraft({...draft,draftGeneration:2,candidate:fixed});const saved=await store.commitProjectDraft(draft.draftId,2,null,'fixed');expect(saved).toEqual(p);expect(await store.projectDrafts()).toHaveLength(0);expect(await store.commitProjectDraft(draft.draftId,2,null,'fixed')).toEqual(saved);expect(await analyzeScenario(saved.scenarios[0]!,saved.assetSnapshots)).toEqual(await analyzeScenario(p.scenarios[0]!,p.assetSnapshots));
});
it('keeps unknown keys and semantic reference failures as recovery text, without accepting future versions or non-project documents',async()=>{
 const p=await original();expect(decodeProjectImport(JSON.stringify({...p,unknown:{keep:null}}),'json').document.documentType).toBe('project_recovery');const q=structuredClone(p);q.assetSnapshots=q.assetSnapshots.filter(a=>a.definition.kind!=='formula');expect(decodeProjectImport(JSON.stringify(q),'json').document.documentType).toBe('project_recovery');expect(()=>decodeProjectImport(JSON.stringify({...p,schemaVersion:2}),'json')).toThrow(/schemaVersion/);expect(()=>decodeProjectImport(JSON.stringify(p.assetSnapshots[0]),'json')).toThrow();
});
it('retains undecoded text as an opaque draft with a temporary identity and never turns it into a formal project',()=>{
 for(const format of ['json','yaml'] as const){const raw=format==='json'?'{ unfinished':'documentType: project\nschemaVersion: 1\nschemaVersion: 1\n',r=decodeProjectImport(raw,format);expect(r.document).toMatchObject({documentType:'project_recovery',editorText:raw,editorFormat:format});expect(ProjectDocument.safeParse(r.document).success).toBe(false);}
});
it('raw draft submission cannot bypass future-version or identity guards',async()=>{
 const p=await original(),store=await newStore();
 for(const [i,value] of [{...p,schemaVersion:2},{...p,projectId:'other-project'}].entries()){const d=ProjectDraft.parse({documentType:'project_draft',schemaVersion:1,draftId:'guard'+i,projectId:p.projectId,baseProjectRevision:null,draftGeneration:1,updatedAt:new Date().toISOString(),editorFormat:'yaml',candidate:stringify(value)});await store.saveProjectDraft(d);await expect(store.commitProjectDraft(d.draftId,1,null,'guard'+i)).rejects.toThrow();}
 expect(await store.projects()).toEqual([]);
});
it('raw repaired drafts retain their captured CAS baseline when the formal project changes elsewhere',async()=>{
 const p=await original(),store=await newStore();await store.saveProject(p,null,'first');const d=ProjectDraft.parse({documentType:'project_draft',schemaVersion:1,draftId:'stale-raw',projectId:p.projectId,baseProjectRevision:1,draftGeneration:1,updatedAt:new Date().toISOString(),candidate:JSON.stringify({...p,name:'local repair'})});await store.saveProjectDraft(d);await store.saveProject({...p,name:'external edit'},1,'external');await expect(store.commitProjectDraft(d.draftId,1,1,'stale')).rejects.toThrow(/变化/);expect((await store.readProject(p.projectId)).name).toBe('external edit');expect((await store.projectDrafts())[0]).toEqual(d);
});
it('cyclic YAML stays opaque rather than reaching the project validator or executable graph',()=>{
 const raw='documentType: project\nschemaVersion: 1\nloop: &loop\n  again: *loop\n';expect(()=>parseProjectText(raw,'yaml')).toThrow();expect(decodeProjectImport(raw,'yaml').document).toMatchObject({documentType:'project_recovery',editorText:raw});
});
it('explicit identity repair preserves YAML comments and unknown fields, and refuses to reinterpret a future version',()=>{
 const text='# original source note\ndocumentType: project\nschemaVersion: 1\nprojectId: 123 # identity note\nunknown:\n  keep: null\n',edited=rewriteProjectTextIdentity(text,'yaml','new-project');expect(edited).toContain('# original source note');expect(edited).toContain('# identity note');expect(parseProjectText(edited,'yaml')).toEqual({documentType:'project',schemaVersion:1,projectId:'new-project',unknown:{keep:null}});expect(()=>rewriteProjectTextIdentity(text.replace('schemaVersion: 1','schemaVersion: 2'),'yaml','new')).toThrow(/v1/);
});
it('oversized text is rejected before recovery classification or identity generation',()=>{
 const text=' '.repeat(32*1024*1024+1);expect(()=>decodeProjectImport(text,'json')).toThrow(/32 MiB/);expect(()=>parseProjectText(text,'json')).toThrow(/32 MiB/);
});
it('a UTF8 BOM is accepted for decoding while the exact invalid original text is retained for recovery',async()=>{
 const p=await original(),raw='\uFEFF'+JSON.stringify({...p,name:''})+'\r\n';expect(decodeProjectImport(raw,'json').document).toMatchObject({documentType:'project_recovery',editorText:raw});expect(parseProjectText('\uFEFF'+JSON.stringify(p),'json')).toEqual(p);
});
