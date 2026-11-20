import { parseDocument } from 'yaml';
import { z } from 'zod';
export class StoreError extends Error {
  constructor(public readonly code:'validation'|'reference'|'conflict'|'io'|'not_found'|'unsupported_version',message:string,public readonly currentRevision?:number){super(message);}
}
export function decodeDocument(text:string,format:'json'|'yaml',maxBytes=4*1024*1024):unknown {
  if(Buffer.byteLength(text)>maxBytes)throw new StoreError('validation','文件超过 '+maxBytes/(1024*1024)+' MiB');
  if(format==='json'){try{return JSON.parse(text) as unknown;}catch{throw new StoreError('validation','JSON 无法解析');}}
  const doc=parseDocument(text,{version:'1.2',uniqueKeys:true,strict:true,customTags:[]});
  if(doc.errors.length||doc.warnings.length)throw new StoreError('validation',[...doc.errors,...doc.warnings].map(e=>e.message).join('; '));
  return z.json().parse(doc.toJS({maxAliasCount:50}));
}
