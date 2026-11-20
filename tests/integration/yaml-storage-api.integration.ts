import {listenForFetch} from './http-listener.js';
import { it,expect } from 'vitest';
import { mkdtemp,mkdir,readFile,rm } from 'node:fs/promises';
import { resolve,join,sep } from 'node:path';
import { stringify } from 'yaml';
import { AssetDocument,AssetDraft,CommitResponse,ScanReport,SaveDraftResponse,apiResponse } from '@model-analyser/contracts';
import { FileStore } from '../../apps/local/src/store.js';
import { storageKey } from '../../apps/local/src/scan.js';
import { createApp } from '../../apps/local/src/server.js';
import { fixture } from '../fixtures.js';

it('uses strict HTTP drafts to persist YAML, retains chosen format after a failed publication and replays through a restarted service',async()=>{
  const parent=resolve('data');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(join(parent,'yaml-http-')),builtin=join(root,'builtin');await mkdir(builtin);let fail=true,server=createApp(new FileStore(root,builtin,async stage=>{if(stage==='before_head'&&fail){fail=false;throw Error('injected unavailable disk');}}));
  async function listen(){await listenForFetch(server);const address=server.address();if(!address||typeof address==='string')throw Error();return 'http://127.0.0.1:'+address.port+'/api/v1/';}
  const close=()=>new Promise<void>((done,reject)=>server.close(e=>e?reject(e):done()));
  try{
    let url=await listen();const post=(path:string,data:unknown)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),a=AssetDocument.parse({...fixture(),assetId:'http:yaml'}),d=AssetDraft.parse({documentType:'asset_draft',schemaVersion:1,draftId:'http-yaml-draft',assetId:a.assetId,assetKind:'formula',baseRevision:null,draftGeneration:1,updatedAt:'2026-11-15T00:00:00.000Z',candidate:a,storageFormat:'yaml'});
    let response=await post('decode-asset',{format:'yaml',text:stringify(a)});expect(response.status).toBe(200);response=await post('drafts',{requestId:'draft-1',draft:d});expect(response.status).toBe(200);expect(apiResponse(SaveDraftResponse).parse(await response.json()).ok).toBe(true);for(const storageFormat of ['toml',1])expect((await post('drafts',{requestId:'invalid',draft:{...d,storageFormat}})).status).toBe(400);
    const commit={requestId:'yaml-http-commit',draftId:d.draftId,draftGeneration:1,expectedRevision:null};response=await post('commit',commit);expect(response.status).toBe(400);expect(await response.json()).toMatchObject({ok:false,error:{code:'io',message:'injected unavailable disk'}});expect(await readFile(join(root,'assets','user',storageKey(a.assetId),'1.yaml'),'utf8')).toContain('documentType: asset');await close();server=createApp(new FileStore(root,builtin));url=await listen();response=await post('commit',commit);expect(response.status).toBe(200);const saved=apiResponse(CommitResponse).parse(await response.json());expect(saved).toMatchObject({ok:true,data:{asset:a}});response=await fetch(url+'scan');const scan=apiResponse(ScanReport).parse(await response.json());if(!scan.ok)throw Error();expect(scan.data.assets).toMatchObject([{assetId:a.assetId,format:'yaml',revision:1}]);expect(scan.data.drafts).toEqual([]);expect(scan.data.issues).toEqual([]);expect((await post('commit',commit)).status).toBe(200);expect((await post('commit',{...commit,storageFormat:'json'})).status).toBe(400);
  }finally{if(server.listening)await close();if(!resolve(root).startsWith(parent+sep))throw Error('Unsafe cleanup');await rm(root,{recursive:true,force:true});}
});
