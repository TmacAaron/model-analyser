import { mkdir,rename,writeFile,unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { stringify } from 'yaml';

type Options={replace?:typeof rename;wait?:(milliseconds:number)=>Promise<unknown>;platform?:NodeJS.Platform};
export const serializeJsonFile=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
export const serializeDocumentFile=(value:unknown,format:'json'|'yaml')=>format==='json'?serializeJsonFile(value):stringify(value,{aliasDuplicateObjects:false,lineWidth:0});
/** Keep the old destination intact until one atomic replacement succeeds. Never unlink it as a fallback. */
export async function atomicWriteJson(path:string,value:unknown,options:Options={}):Promise<void>{
  return atomicWriteText(path,serializeJsonFile(value),options);
}
export async function atomicWriteDocument(path:string,value:unknown,format:'json'|'yaml',options:Options={}):Promise<void>{
  return atomicWriteText(path,serializeDocumentFile(value,format),options);
}
async function atomicWriteText(path:string,text:string,options:Options):Promise<void>{
  await mkdir(dirname(path),{recursive:true});const temp=path+'.'+randomUUID()+'.tmp',replace=options.replace??rename,wait=options.wait??pause;
  try{
    await writeFile(temp,text,{encoding:'utf8',flag:'wx'});
    const delays=[50,100,200,400];let attempt=0;
    while(true){try{await replace(temp,path);return;}catch(error){
      const code=typeof error==='object'&&error!==null&&'code' in error?error.code:undefined,delay=delays[attempt++];
      if((options.platform??process.platform)!=='win32'||!['EPERM','EACCES','EBUSY'].includes(String(code))||delay===undefined)throw error;
      await wait(delay);
    }}
  }catch(error){await unlink(temp).catch(()=>undefined);throw error;}
}
