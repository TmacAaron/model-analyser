import { readdir,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteJson } from './atomic-file.js';
import { StoreError,decodeDocument } from './documents.js';

const revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const Head=z.strictObject({assetId:z.string().min(1),revision,publishedRevisions:z.array(revision).min(1).optional()}).refine(h=>!h.publishedRevisions||(new Set(h.publishedRevisions).size===h.publishedRevisions.length&&h.publishedRevisions.includes(h.revision)&&h.publishedRevisions.every(n=>n<=h.revision)),'已发布修订必须唯一且最大值等于head');
export type AssetHead=z.infer<typeof Head>;
export const revisionFilePattern=/^(\d+)\.(json|ya?ml)$/i;
export const isPublished=(head:AssetHead|undefined,value:number)=>!!head&&(head.publishedRevisions?head.publishedRevisions.includes(value):value<=head.revision);
export async function readAssetHead(dir:string,id:string):Promise<AssetHead|undefined>{
  let raw:unknown;try{raw=decodeDocument(await readFile(join(dir,'head.json'),'utf8'),'json');}catch(e){if(typeof e==='object'&&e!==null&&'code' in e&&e.code==='ENOENT')return undefined;throw e;}
  const head=Head.parse(raw);if(head.assetId!==id)throw new StoreError('validation','资产头身份与目录不符');return head;
}
/** Freeze the legacy <=head rule once; later head jumps publish only the requested member. */
export async function publishRevisionHead(dir:string,id:string,value:number,expected:number|null):Promise<AssetHead>{
  const old=await readAssetHead(dir,id);if((old?.revision??null)!==expected)throw new StoreError('conflict','资产头在发布前已变化',old?.revision);
  let published=old?.publishedRevisions??[];
  if(old&&!old.publishedRevisions){const files=await readdir(dir);published=files.flatMap(name=>{const match=revisionFilePattern.exec(name),n=Number(match?.[1]);return match&&String(n)===match[1]&&Number.isSafeInteger(n)&&n>0&&n<=old.revision?[n]:[];});published.push(old.revision);}
  const head=Head.parse({assetId:id,revision:Math.max(old?.revision??0,value),publishedRevisions:[...new Set([...published,value])].sort((a,b)=>a-b)});await atomicWriteJson(join(dir,'head.json'),head);return head;
}
