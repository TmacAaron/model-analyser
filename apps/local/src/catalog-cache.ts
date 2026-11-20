import {stat} from 'node:fs/promises';import {z} from 'zod';
import {jsonBytes} from '../../../packages/contracts/src/json-size.js';
import {readContract} from './scan.js';import {StoreError} from './documents.js';
const maxBytes=16*1024*1024,maxEntries=4096;
/** Keeps detached metadata only; no cached project snapshots or candidate text. */
export class CatalogFileCache{
 private values=new Map<string,{signature:string;value:unknown;bytes:number}>();private bytes=0;
 private async signature(file:string){const s=await stat(file,{bigint:true});return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');}
 async read<T extends z.ZodType,S>(kind:string,file:string,schema:T,project:(value:z.infer<T>)=>S,fresh=false):Promise<S>{
  const key=kind+':'+file;let before=await this.signature(file);const cached=this.values.get(key);
  if(!fresh&&cached?.signature===before){this.values.delete(key);this.values.set(key,cached);return cached.value as S;}
  for(let attempt=0;attempt<3;attempt++){
   const value=project(await readContract(file,schema)),after=await this.signature(file);if(after!==before){before=after;continue;}
   let bytes:number;try{bytes=jsonBytes(value,maxBytes);}catch{return value;}
   // A parser's string slice could retain the large original input buffer. A
   // metadata-only serialization gives the cache its own small backing data.
   const detached:unknown=JSON.parse(JSON.stringify(value));const previous=this.values.get(key);if(previous){this.bytes-=previous.bytes;this.values.delete(key);}
   while(this.values.size&&(this.values.size>=maxEntries||this.bytes+bytes>maxBytes)){const oldest=this.values.keys().next().value;if(oldest===undefined)break;const entry=this.values.get(oldest);if(entry)this.bytes-=entry.bytes;this.values.delete(oldest);}
   this.values.set(key,{signature:after,value:detached,bytes});this.bytes+=bytes;return detached as S;
  }
  throw new StoreError('conflict','目录读取期间文件持续变化，请重新扫描；原文件保留');
 }
}
