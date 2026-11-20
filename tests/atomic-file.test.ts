import { it,expect } from 'vitest';
import { mkdtemp,readFile,readdir,rename,rm,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { atomicWriteJson } from '../apps/local/src/atomic-file.js';

it('retries transient Windows sharing failures without deleting or exposing a partial destination',async()=>{
  const root=await mkdtemp(resolve('data-test-atomic-')),path=join(root,'draft.json'),delays:number[]=[];let attempts=0;
  try{await writeFile(path,'{"previous":true}\n');await atomicWriteJson(path,{next:true},{platform:'win32',replace:async(from,to)=>{attempts++;if(attempts<3)throw Object.assign(Error('temporarily locked'),{code:'EPERM'});await rename(from,to);},wait:async ms=>{delays.push(ms);expect(JSON.parse(await readFile(path,'utf8'))).toEqual({previous:true});}});expect(attempts).toBe(3);expect(delays).toEqual([50,100]);expect(JSON.parse(await readFile(path,'utf8'))).toEqual({next:true});expect(await readdir(root)).toEqual(['draft.json']);}finally{await rm(root,{recursive:true,force:true});}
});
it('bounds persistent Windows failures, cleans its temporary file and preserves the previous JSON',async()=>{
  const root=await mkdtemp(resolve('data-test-atomic-')),path=join(root,'draft.json'),delays:number[]=[];let attempts=0;
  try{await writeFile(path,'{"previous":true}\n');await expect(atomicWriteJson(path,{next:true},{platform:'win32',replace:async()=>{attempts++;throw Object.assign(Error('still locked'),{code:'EACCES'});},wait:async ms=>{delays.push(ms);}})).rejects.toThrow('still locked');expect(attempts).toBe(5);expect(delays).toEqual([50,100,200,400]);expect(JSON.parse(await readFile(path,'utf8'))).toEqual({previous:true});expect(await readdir(root)).toEqual(['draft.json']);}finally{await rm(root,{recursive:true,force:true});}
});
it('surfaces unrelated IO errors immediately and never retries non-Windows replacements',async()=>{
  const root=await mkdtemp(resolve('data-test-atomic-')),path=join(root,'draft.json');
  try{for(const [platform,code] of [['win32','ENOSPC'],['linux','EPERM']] as const){let attempts=0;await expect(atomicWriteJson(path,{next:true},{platform,replace:async()=>{attempts++;throw Object.assign(Error(code),{code});},wait:async()=>{throw Error('must not wait');}})).rejects.toThrow(code);expect(attempts).toBe(1);expect(await readdir(root)).toEqual([]);}}finally{await rm(root,{recursive:true,force:true});}
});
