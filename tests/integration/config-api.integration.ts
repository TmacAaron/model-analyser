import {listenForFetch} from './http-listener.js';
import { it,expect } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { ConfigSource,apiResponse } from '@model-analyser/contracts';
import { createApp } from '../../apps/local/src/server.js';
import { FileStore } from '../../apps/local/src/store.js';

it('decodes config objects through the typed bounded JSON/YAML API without coercion or executing remote metadata',async()=>{
  const prefix=resolve('data-test-config-api-'),root=await mkdtemp(prefix),server=createApp(new FileStore(root,join(root,'absent')));try{await listenForFetch(server);const address=server.address();if(!address||typeof address==='string')throw Error();const url='http://127.0.0.1:'+address.port+'/api/v1/decode-config',post=(body:unknown,origin?:string)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(body)}),body={sourceName:'foreign.yaml',format:'yaml',text:'model_type: unknown\nhidden_size: "1024"\nauto_map:\n  AutoModel: untrusted.local\nquantization_config:\n  bits: 4\n'};
    let response=await post(body);expect(response.status).toBe(200);const parsed=apiResponse(ConfigSource).parse(await response.json() as unknown);if(!parsed.ok)throw Error();expect(parsed.data.rawConfig).toEqual({model_type:'unknown',hidden_size:'1024',auto_map:{AutoModel:'untrusted.local'},quantization_config:{bits:4}});
    for(const text of ['[1,2]','null','true']){response=await post({...body,format:'json',text});expect(response.status).toBe(400);}response=await post({...body,extra:true});expect(response.status).toBe(400);response=await post({...body,text:'x: 1\nx: 2'});expect(response.status).toBe(400);response=await post(body,'https://foreign.invalid');expect(response.status).toBe(400);response=await post({...body,format:'json',text:'{"schemaVersion":999,"model_type":"external"}'});expect(response.status).toBe(200);
  }finally{await new Promise<void>((done,reject)=>server.close(e=>e?reject(e):done()));if(!root.startsWith(prefix))throw Error('Unsafe cleanup');await rm(root,{recursive:true,force:true});}
});
