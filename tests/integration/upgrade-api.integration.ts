import {listenForFetch} from './http-listener.js';
import { it,expect } from 'vitest';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { z } from 'zod';
import { AssetDraft,DependencyUpgradePlan,DependencyUpgradeOperation,DependencyUpgradeHistory,ProjectDocument,apiResponse } from '@model-analyser/contracts';
import { createApp } from '../../apps/local/src/server.js';
import { FileStore } from '../../apps/local/src/store.js';
import { makeUpgradeProject } from '../../scripts/upgrade-project.js';
import { upgradeRef } from '../../packages/contracts/src/dependency-upgrade.js';

it('serves typed upgrade previews/recovery with validation, same-origin checks, retained future data and idempotent results',async()=>{
  const prefix=resolve('data-test-upgrade-api-'),root=await mkdtemp(prefix),f=makeUpgradeProject(),store=new FileStore(root,join(root,'none'));let server:ReturnType<typeof createApp>|undefined;
  try{
    for(const a of [...f.project.assetSnapshots,f.updated]){const expected=a.revision===1?null:1,d=AssetDraft.parse({documentType:'asset_draft',schemaVersion:1,draftId:a.assetId+':'+a.revision,assetId:a.assetId,assetKind:a.definition.kind,baseRevision:expected,draftGeneration:1,updatedAt:'2026-11-14T00:00:00.000Z',candidate:a});await store.saveDraft(d);await store.commit(d.draftId,1,expected);}await store.saveProject(f.project,null);
    let interrupted=false;const failing=new FileStore(root,join(root,'none'),async stage=>{if(stage==='upgrade_prepared'&&!interrupted){interrupted=true;throw Error('injected interruption');}});server=createApp(failing);await listenForFetch(server);const address=server.address();if(!address||typeof address==='string')throw Error();const url='http://127.0.0.1:'+address.port+'/api/v1/',intent={requestId:'http-upgrade',projectId:f.project.projectId,expectedProjectRevision:1,scenarioId:f.project.scenarios[0]!.scenarioId,selections:[{from:upgradeRef(f.formula),to:upgradeRef(f.updated)}]};
    const post=async(path:string,value:unknown,origin?:string)=>{const r=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(value)});return {status:r.status,body:apiResponse(z.unknown()).parse(await r.json() as unknown)};};
    let r=await post('dependency-upgrade-preview',{...intent,extra:true});expect(r.status).toBe(400);expect(r.body.ok).toBe(false);if(!r.body.ok)expect(r.body.error.fieldIssues.length).toBeGreaterThan(0);r=await post('dependency-upgrade-preview',intent);expect(r.body.ok).toBe(true);if(!r.body.ok)throw Error();const plan=DependencyUpgradePlan.parse(r.body.data);expect((await store.readProject(f.project.projectId)).projectRevision).toBe(1);
    r=await post('dependency-upgrade-apply',{...intent,planHash:plan.planHash});expect(r.status).toBe(400);if(!r.body.ok)expect(r.body.error.code).toBe('io');expect(interrupted).toBe(true);const history=apiResponse(DependencyUpgradeHistory).parse(await (await fetch(url+'dependency-upgrades?projectId='+f.project.projectId)).json() as unknown);if(!history.ok)throw Error();expect(history.data.operations[0]?.status).toBe('prepared');
    r=await post('dependency-upgrade-resume',{requestId:intent.requestId});if(!r.body.ok)throw Error(r.body.error.message);expect(DependencyUpgradeOperation.parse(r.body.data).status).toBe('complete');r=await post('dependency-upgrade-apply',{...intent,planHash:plan.planHash});if(!r.body.ok)throw Error();expect(DependencyUpgradeOperation.parse(r.body.data).status).toBe('complete');const project=apiResponse(ProjectDocument).parse(await (await fetch(url+'project?id='+f.project.projectId)).json() as unknown);if(!project.ok)throw Error();expect(project.data.projectRevision).toBe(2);
    expect((await post('dependency-upgrade-cancel',{requestId:intent.requestId})).status).toBe(409);expect((await post('dependency-upgrade-preview',intent,'https://unrelated.test')).status).toBe(400);
    await writeFile(join(root,'dependency-upgrades','future.json'),JSON.stringify({schemaVersion:2,operation:{}}));const issues=await store.dependencyUpgradeHistory();expect(issues.issues.some(i=>i.code==='unsupported_version')).toBe(true);expect(issues.operations).toHaveLength(1);
  }finally{if(server)await new Promise<void>((resolve,reject)=>server!.close(e=>e?reject(e):resolve()));if(!root.startsWith(prefix))throw Error('Unsafe cleanup');await rm(root,{recursive:true,force:true});}
},15000);
