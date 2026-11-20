import {PROJECT_TEXT_BYTES,utf8Bytes} from './project-limits.js';
import {parseDocument} from 'yaml';
import {z} from 'zod';
function rejectCycles(value:unknown){
 const active=new WeakSet<object>(),done=new WeakSet<object>(),stack:{value:unknown;leave:boolean}[]=[{value,leave:false}];
 while(stack.length){const frame=stack.pop();if(!frame||!frame.value||typeof frame.value!=='object')continue;const object=frame.value;if(frame.leave){active.delete(object);done.add(object);continue;}if(active.has(object))throw Error('YAML包含循环引用，保留原文待修复');if(done.has(object))continue;active.add(object);stack.push({value:object,leave:true});for(const child of Object.values(object))stack.push({value:child,leave:false});}
}
/** Decode only data, preserving unknown keys for the strict project validator. */
export function parseProjectText(text:string,format:'json'|'yaml'='json',maxBytes=PROJECT_TEXT_BYTES):unknown{
 if(utf8Bytes(text)>maxBytes)throw Error('项目正文超过'+maxBytes/(1024*1024)+' MiB');
 if(format==='json')return JSON.parse(text.replace(/^\uFEFF/,'')) as unknown;
 const doc=parseDocument(text,{version:'1.2',uniqueKeys:true,strict:true,customTags:[]});
 if(doc.errors.length||doc.warnings.length)throw Error([...doc.errors,...doc.warnings].map(e=>e.message).join('; '));
 const value:unknown=doc.toJS({maxAliasCount:50});rejectCycles(value);return z.json().parse(value);
}
/** Explicit identity edit; YAML document comments remain attached to the syntax tree. */
export function rewriteProjectTextIdentity(text:string,format:'json'|'yaml',projectId:string):string{
 const value=parseProjectText(text,format);
 if(!value||typeof value!=='object'||Array.isArray(value)||!('documentType'in value)||value.documentType!=='project'||!('schemaVersion'in value)||value.schemaVersion!==1)throw Error('先修复为已识别的v1项目正文，再修改身份');
 if(format==='json')return JSON.stringify({...value,projectId},null,2);
 const doc=parseDocument(text,{version:'1.2',uniqueKeys:true,strict:true,customTags:[]});doc.set('projectId',projectId);return doc.toString();
}
