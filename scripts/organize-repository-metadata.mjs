import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {resolve,relative,dirname,sep} from 'node:path';
const root=process.cwd(),manifest=JSON.parse((await readFile('_local/history/relocation-manifest.json','utf8')).replace(/^\uFEFF/,''));
let checked=0;for(const entry of manifest){const path=resolve(entry.archived);if(!path.startsWith(root+sep))throw Error('Archive path escaped workspace');if(createHash('sha256').update(await readFile(path)).digest('hex')!==entry.sha256)throw Error('Archived content changed: '+entry.original);checked++;}
const movedRoots=new Set(manifest.map(entry=>entry.original.split('/')[0]));let updated=0;
for(const file of ['README.md',...(await readdir('docs',{recursive:true})).filter(f=>f.endsWith('.md')).map(f=>'docs/'+f)]){
 const original=await readFile(file,'utf8');const next=original.replace(/(!?\[[^\]\n]*\]\()(<[^>]+>|[^)\s]+)(\))/g,(all,before,target,after)=>{
  const bare=target.replace(/^<|>$/g,''),[path,anchor]=bare.split('#');if(!path||/^(https?:|mailto:|#)/.test(path))return all;
  const absolute=resolve(dirname(resolve(file)),path),from=relative(root,absolute).split(sep).join('/');if(!movedRoots.has(from.split('/')[0]))return all;
  const destination=relative(dirname(resolve(file)),resolve('_local/history',from)).split(sep).join('/');return before+destination+(anchor?'#'+anchor:'')+after;
 });if(next!==original){await writeFile(file,next);updated++;}
}
console.log(JSON.stringify({archivedFilesVerified:checked,markdownFilesUpdated:updated}));
