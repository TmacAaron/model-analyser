import {listenForFetch} from './http-listener.js';
import { it,expect } from 'vitest';
import { mkdtemp,rm,readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { ProjectDocument } from '@model-analyser/contracts';
import { decodeAscendDescription } from '../../packages/contracts/src/ascend-quantization.js';
import { createApp } from '../../apps/local/src/server.js';
import { FileStore } from '../../apps/local/src/store.js';
import { storageKey } from '../../apps/local/src/scan.js';
import { decodeDocument } from '../../apps/local/src/documents.js';
import { makeQwenProject } from '../../scripts/model-project.js';

it('saves the complete real descriptor beyond 4 MiB through project decode, commit, scan and reopening while asset bounds stay unchanged',async()=>{
  const prefix=resolve('data-test-ascend-api-'),root=await mkdtemp(prefix),store=new FileStore(root,join(root,'none')),server=createApp(store);try{
    await listenForFetch(server);const address=server.address();if(!address||typeof address==='string')throw Error();const url='http://127.0.0.1:'+address.port+'/api/v1/',post=(path:string,body:unknown)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),text=await readFile('references/ascend-quantization/qwen3-30b-a3b-w8a8/quant_model_description.json','utf8'),source=decodeAscendDescription(text,'real.json'),p=makeQwenProject();p.quantizationSources=[source];p.scenarios[0]!.ascendQuantizationImports=[{importId:'api-import',sourceId:source.sourceId,draft:{sourceKey:'',storageId:'',specificationText:'invalid draft is retained',note:''},mappings:[],appliedMappings:[],confirmationNote:''}];
    expect(Buffer.byteLength(text)).toBeGreaterThan(4*1024*1024);expect(()=>decodeDocument(text,'json')).toThrow('4 MiB');let response=await post('decode-project',{format:'json',text:JSON.stringify(p)});expect(response.status,await response.clone().text()).toBe(200);const decoded=await response.json() as {ok:boolean;data:unknown};expect(ProjectDocument.parse(decoded.data).quantizationSources?.[0]?.text).toBe(text);
    response=await post('projects',{requestId:'real-source-save',expectedRevision:null,project:p});expect(response.status,await response.clone().text()).toBe(200);const read=await fetch(url+'project?id='+encodeURIComponent(p.projectId)),saved=await read.json() as {data:unknown};expect(ProjectDocument.parse(saved.data).quantizationSources?.[0]?.sha256).toBe(source.sha256);const reopened=new FileStore(root,join(root,'none'));expect((await reopened.projects())[0]?.quantizationSources?.[0]?.text).toBe(text);expect((await reopened.scan()).issues).toEqual([]);
    const damaged=structuredClone(p);damaged.quantizationSources![0]!.text+=' ';const headPath=join(root,'projects',storageKey(p.projectId)+'.json');await writeFile(headPath,JSON.stringify(damaged));expect((await fetch(url+'project?id='+encodeURIComponent(p.projectId))).status).toBe(400);const scan=await reopened.scan();expect(scan.projects).toHaveLength(0);expect(scan.issues.some(i=>i.message.includes('SHA256'))).toBe(true);expect(await readFile(headPath,'utf8')).toBe(JSON.stringify(damaged));
    const padding='\t'.repeat(8*1024*1024-7),oversized=ProjectDocument.parse({...p,projectId:'oversized-source-project',scenarios:[],assetSnapshots:[],quantizationSources:[decodeAscendDescription(padding+'{"a":0}','a.json'),decodeAscendDescription(padding+'{"b":0}','b.json')]});expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(32*1024*1024);await expect(store.saveProject(oversized,null,'oversized')).rejects.toThrow('32 MiB');await expect(store.readProject(oversized.projectId)).rejects.toMatchObject({code:'not_found'});
  }finally{await new Promise<void>((done,reject)=>server.close(e=>e?reject(e):done()));if(!root.startsWith(prefix))throw Error('Unsafe cleanup');await rm(root,{recursive:true,force:true});}
},30000);
