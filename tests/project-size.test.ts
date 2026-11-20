import {it,expect} from 'vitest';
import {c01Project} from './model-fixtures.js';
import {ProjectDraft,ProjectRecoveryDocument} from '@model-analyser/contracts';
import {jsonBytes} from '../packages/contracts/src/json-size.js';
import {utf8Bytes,PROJECT_TEXT_BYTES} from '../packages/contracts/src/project-limits.js';
import {serializeProjectRecovery,validateProjectRecovery,validateProjectDraftSize} from '../packages/contracts/src/project-recovery.js';
import {decodeProjectImport} from '../apps/local/src/project-import.js';
it('matches native UTF8 compact and pretty JSON bytes, including controls, escaping, holes and surrogate pairs',()=>{
 const cases:unknown[]=[null,true,false,0,-0,1e20,1e-8,'ASCII','中文😀','\ud800','\udfff','\\"\b\f\t\r\n\0\u001f',[],[1,undefined,null],{omit:undefined,keep:false},{nested:[{x:'\uFEFF# note\r\n{broken'}]}];let seed=9;
 for(let n=0;n<200;n++){let s='';for(let i=0;i<100;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;s+=String.fromCharCode(seed&65535);}cases.push({s,n});}
 for(const value of cases)for(const pretty of [false,true]){const native=Buffer.byteLength(JSON.stringify(value,null,pretty?2:undefined));expect(jsonBytes(value,native,pretty)).toBe(native);expect(()=>jsonBytes(value,native-1,pretty)).toThrow();}
 for(const text of ['abc','中文😀','\ud800','\udfff','\uFEFF\0\r\n'])expect(utf8Bytes(text)).toBe(Buffer.byteLength(text));
});
it('counts aliases per serialized occurrence and rejects cycles/depth before creating a huge flattened string',()=>{
 const repeated={text:'x'.repeat(1024)},shared=Array.from({length:1000},()=>repeated);expect(()=>jsonBytes(shared,100*1024)).toThrow('字节限额');expect(jsonBytes([repeated,repeated],10000)).toBe(Buffer.byteLength(JSON.stringify([repeated,repeated])));const cyclic:{self?:unknown}={};cyclic.self=cyclic;expect(()=>jsonBytes(cyclic,100000)).toThrow('cyclic');let deep:unknown=0;for(let i=0;i<514;i++)deep=[deep];expect(()=>jsonBytes(deep,100000)).toThrow('深度');expect(()=>jsonBytes(new Date(),10000)).toThrow('non_json_object');
});
it('a permitted17MiB source and baseline export a complete recovery above32MiB and decode without losing any content',()=>{
 const p=c01Project();p.assetSnapshots[0]!.description='x'.repeat(17*1024*1024);const raw=JSON.stringify({...p,name:''}),recovery=ProjectRecoveryDocument.parse({documentType:'project_recovery',schemaVersion:1,status:'draft',projectId:p.projectId,baseProjectRevision:1,formalProject:p,editorText:raw,editorFormat:'json'}),text=serializeProjectRecovery(recovery);expect(Buffer.byteLength(raw)).toBeLessThan(PROJECT_TEXT_BYTES);expect(Buffer.byteLength(text)).toBeGreaterThan(PROJECT_TEXT_BYTES);const decoded=decodeProjectImport(text,'json');expect(decoded.ordinaryRecovery).toBe(false);expect(decoded.document).toEqual(recovery);expect(jsonBytes(p,Number.MAX_SAFE_INTEGER,true)+1).toBe(Buffer.byteLength(JSON.stringify(p,null,2)+'\n'));
});
it('bounded recovery preflight refuses a mismatched baseline, unknown fields and future versions before publication',()=>{
 const p=c01Project(),r={documentType:'project_recovery',schemaVersion:1,status:'draft',projectId:p.projectId,baseProjectRevision:1,formalProject:p,editorText:'{broken',editorFormat:'json'};expect(()=>validateProjectRecovery({...r,formalProject:{...p,projectId:'other'}})).toThrow('身份');expect(()=>validateProjectRecovery({...r,extra:true})).toThrow();expect(()=>decodeProjectImport(JSON.stringify({...r,schemaVersion:2}),'json')).toThrow('schemaVersion');expect(()=>decodeProjectImport(' '.repeat(PROJECT_TEXT_BYTES+1),'json')).toThrow('32 MiB');
});
it('preserves legacy object candidates and new raw candidates without weakening strict future-version commit checks',()=>{
 const p=c01Project(),draft=ProjectDraft.parse({documentType:'project_draft',schemaVersion:1,draftId:'size-test',projectId:p.projectId,baseProjectRevision:null,draftGeneration:1,updatedAt:new Date().toISOString(),candidate:p});expect(()=>validateProjectDraftSize(draft)).not.toThrow();expect(()=>validateProjectDraftSize({...draft,candidate:'{broken'})).not.toThrow();
});
