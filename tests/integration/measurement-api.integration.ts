import {listenForFetch} from './http-listener.js';
import { it,expect } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { MeasurementFile,apiResponse } from '@model-analyser/contracts';
import { encodeMeasurements } from '../../packages/contracts/src/measurement-file.js';
import { createApp } from '../../apps/local/src/server.js';
import { FileStore } from '../../apps/local/src/store.js';
import { c01Project } from '../model-fixtures.js';

it('decodes bounded normalized measurement CSV/JSON through a same-origin API and rejects malformed scopes, time and future formats',async()=>{
  const prefix=resolve('data-test-measurement-api-'),root=await mkdtemp(prefix),server=createApp(new FileStore(root,join(root,'absent')));try{await listenForFetch(server);const address=server.address();if(!address||typeof address==='string')throw Error();const url='http://127.0.0.1:'+address.port+'/api/v1/decode-measurements',post=(body:unknown,origin?:string)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(body)}),record=c01Project().measurements[0]!;
    for(const format of ['csv','json'] as const){const response=await post({sourceName:'measurements.'+format,format,text:encodeMeasurements([record],format)});expect(response.status).toBe(200);const result=apiResponse(MeasurementFile).parse(await response.json() as unknown);if(!result.ok)throw Error();expect(result.data.records[0]).toMatchObject({...record,source:{...record.source,importedFrom:'measurements.'+format}});}
    const body={sourceName:'bad.json',format:'json',text:encodeMeasurements([record],'json')};for(const change of [{format:'yaml'},{extra:true},{text:'[]'},{text:'{invalid'},{text:JSON.stringify({documentType:'measurements',schemaVersion:2,records:[record]})},{text:JSON.stringify({documentType:'measurements',schemaVersion:1,records:[{...record,count:2,time:{kind:'single',seconds:5}}]})},{text:JSON.stringify({documentType:'measurements',schemaVersion:1,records:[record,record]})},{format:'csv',text:'unknown\nvalue'},{text:'x'.repeat(2*1024*1024+1)}]){const response=await post({...body,...change});expect(response.status).toBe(400);const parsed=apiResponse(MeasurementFile).parse(await response.json() as unknown);expect(parsed.ok).toBe(false);if(!parsed.ok)expect(parsed.error.code).toBe('validation');}
    expect((await post(body,'https://foreign.invalid')).status).toBe(400);
  }finally{await new Promise<void>((done,reject)=>server.close(e=>e?reject(e):done()));if(!root.startsWith(prefix))throw Error('Unsafe cleanup');await rm(root,{recursive:true,force:true});}
});
