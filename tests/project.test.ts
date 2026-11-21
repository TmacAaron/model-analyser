import { it,expect } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FileStore } from '../apps/local/src/store.js';
import { AssetDocument,AssetDraft,ProjectDocument,StorageId } from '@model-analyser/contracts';
import { fixture } from './fixtures.js';
it('C06 project dependency snapshots remain unchanged after library updates and reopen without library',async()=>{
  const root=await mkdtemp(resolve('data-test-'));
  try {
    const store=new FileStore(root,resolve(root,'builtins'));
    const a=AssetDocument.parse({...fixture(),assetId:'a'});
    if(a.definition.kind==='formula')a.definition.formula.output.unit='byte';
    const graph={inputs:[],outputs:[],nodes:[],edges:[],dependencies:[],tensors:[],storages:[],states:[]};
    const b=AssetDocument.parse({...fixture(),assetId:'b',definition:{kind:'module',graph}});
    const c=AssetDocument.parse({...fixture(),assetId:'c',definition:{kind:'model',family:'test',variant:'C06',graph:{...graph,nodes:[{nodeId:'module-b',name:'B',phases:['decode'],portBindings:[],stateBindings:[],body:{kind:'module',asset:{assetId:'b',revision:1,kind:'module'},bindings:[]}}]}}});
    // Formula dependency is stored in a typed ValueExpr, not inferred from names.
    if(b.definition.kind!=='module')throw Error();
    b.definition.graph.storages.push({storageId:StorageId.parse('capacity'),name:'formula capacity',category:'state',sharingDomain:'request',allocation:{kind:'bytes',value:{kind:'formula',call:{formula:{assetId:a.assetId,revision:1,kind:'formula'},bindings:{M:{kind:'literal',quantity:{value:4,unit:'count'}},N:{kind:'literal',quantity:{value:8,unit:'count'}},K:{kind:'literal',quantity:{value:16,unit:'count'}}}}}}});
    for(const asset of [a,b,c]){const d=AssetDraft.parse({documentType:'asset_draft',schemaVersion:1,draftId:asset.assetId,assetId:asset.assetId,assetKind:asset.definition.kind,baseRevision:null,draftGeneration:1,updatedAt:new Date().toISOString(),candidate:asset});await store.saveDraft(d);await store.commit(d.draftId,1,null);}
    const snapshots=await store.snapshot([{assetId:c.assetId,revision:1,kind:'model'}]);expect(snapshots.map(a=>a.assetId).sort()).toEqual(['a','b','c']);
    const project=ProjectDocument.parse({documentType:'project',schemaVersion:1,projectId:'p',projectRevision:1,name:'旧项目',scenarios:[],assetSnapshots:snapshots,measurements:[],viewState:{nodes:[]}});
    await store.saveProject(project,null);
    const changed=AssetDocument.parse({...a,name:'A 新名称'});await store.saveDraft(AssetDraft.parse({documentType:'asset_draft',schemaVersion:1,draftId:'a',assetId:'a',assetKind:'formula',baseRevision:1,draftGeneration:2,updatedAt:new Date().toISOString(),candidate:changed}));await store.commit('a',2,1);
    const isolated=new FileStore(root,resolve(root,'isolated-builtins'));expect((await isolated.projects())[0]?.assetSnapshots).toEqual(snapshots);
    expect((await store.read('b',1)).revision).toBe(1);await expect(store.saveProject(project,null)).rejects.toThrow('项目已变化');
  } finally {await rm(root,{force:true,recursive:true});}
});
