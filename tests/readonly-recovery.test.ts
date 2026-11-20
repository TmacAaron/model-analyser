import { it,expect } from 'vitest';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { resolve,join,sep } from 'node:path';
import { FileStore } from '../apps/local/src/store.js';
import { storageKey } from '../apps/local/src/scan.js';
import { fixture } from './fixtures.js';

it('refuses prepared builtin-ID revisions without changing files and still recovers a distinct user copy',async()=>{
  const parent=resolve('data'),root=await mkdtemp(join(parent,'readonly-recovery-')),builtin=join(root,'builtin'),a=fixture(),dir=join(root,'assets','user',storageKey(a.assetId)),original=JSON.stringify(a),prepared=new Map([1,7].map(revision=>[revision,JSON.stringify({...a,revision,name:'Prepared '+revision})]));
  try{await mkdir(builtin);await mkdir(dir,{recursive:true});await writeFile(join(builtin,'baseline.json'),original);for(const [revision,text]of prepared)await writeFile(join(dir,revision+'.json'),text);const store=new FileStore(root,builtin);
    for(const [revision,text]of prepared){await expect(store.recoverRevision(a.assetId,revision,null)).rejects.toMatchObject({code:'conflict',message:expect.stringContaining('内置')});await expect(readFile(join(dir,'head.json'),'utf8')).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(join(dir,revision+'.json'),'utf8')).toBe(text);expect(await readFile(join(builtin,'baseline.json'),'utf8')).toBe(original);}
    expect(await store.read(a.assetId)).toEqual(a);const copy={...a,assetId:'readonly:distinct-user-copy',revision:7},copyDir=join(root,'assets','user',storageKey(copy.assetId));await mkdir(copyDir,{recursive:true});await writeFile(join(copyDir,'7.json'),JSON.stringify(copy));expect(await store.recoverRevision(copy.assetId,7,null)).toEqual(copy);expect(await store.read(copy.assetId)).toEqual(copy);expect(JSON.parse(await readFile(join(copyDir,'head.json'),'utf8'))).toMatchObject({revision:7,publishedRevisions:[7]});
  }finally{if(!resolve(root).startsWith(parent+sep))throw Error('Unsafe cleanup');await rm(root,{recursive:true,force:true});}
});
