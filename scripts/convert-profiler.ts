import { readFile,writeFile,stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { TraceMappingRequest } from '@model-analyser/contracts';
import { decodeChromeTrace,decodeRocmCsv,prepareTraceMeasurements,traceByteLimit } from '@model-analyser/core';
import { encodeMeasurements } from '../packages/contracts/src/measurement-file.js';
export async function convertProfiler(format:'chrome'|'rocm',args:string[]){
  const [inputPath,scopePath,outputPath]=args;if(!inputPath||!scopePath||!outputPath||args.length!==3)throw Error(`Usage: npm run convert:${format==='chrome'?'chrome-trace':'rocm-csv'} -- input explicit-scope.json output.json`);
  if((await stat(inputPath)).size>traceByteLimit)throw Error('Profiler文件超过64 MiB');if((await stat(scopePath)).size>1024*1024)throw Error('范围/规则文件超过1 MiB');
  const bytes=await readFile(inputPath),decoded=inputPath.toLowerCase().endsWith('.gz')?gunzipSync(bytes,{maxOutputLength:traceByteLimit}):bytes,text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(decoded),sourceName=inputPath.split(/[\\/]/).at(-1)??inputPath,trace=await(format==='rocm'?decodeRocmCsv(text,sourceName):decodeChromeTrace(text,sourceName)),scope:unknown=JSON.parse(await readFile(scopePath,'utf8')) as unknown;
  if(!scope||typeof scope!=='object'||Array.isArray(scope)||'trace' in scope)throw Error('范围/规则文件必须是对象，不能替换源Profiler数据');
  const prepared=prepareTraceMeasurements(TraceMappingRequest.parse({...scope,trace}));await writeFile(outputPath,encodeMeasurements(prepared.records,'json'),{flag:'wx'});console.log(JSON.stringify({records:prepared.records.length,matched:prepared.rows.filter(r=>r.status==='matched').length,unmatched:prepared.rows.filter(r=>r.status==='unmatched').length,ambiguous:prepared.rows.filter(r=>r.status==='ambiguous').length,cumulativeSeconds:prepared.cumulativeSeconds,spanSeconds:prepared.spanSeconds,overlapping:prepared.overlapping,inputBinding:'pending explicit workbench confirmation',outputPath}));
}
