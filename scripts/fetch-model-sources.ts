import { mkdir,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Explicit authoring command. Never fetch a moving main branch or a weight payload.
const pins={qwen:'c1899de289a04d12100db370d81485cdf75e47ca',deepseek:'604d5664dddd88a0433dbae533b7fe9472482de0',transformers:'0720e206c6ba28887e4d60ef60a6a089f6c1cc76'};
const records:{path:string;url:string;sha256:string;bytes:number}[]=[];
async function download(url:string,limit:number,range?:string){const response=await fetch(url,{headers:range?{Range:range,'Accept-Encoding':'identity'}:{},signal:AbortSignal.timeout(30000)});if(!response.ok||range&&response.status!==206){await response.body?.cancel();throw Error('Refuse unexpected response '+response.status+' from '+url);}const reader=response.body?.getReader();if(!reader)throw Error('Missing body');const parts:Uint8Array[]= [];let length=0;while(true){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;if(length>limit){await reader.cancel();throw Error('Source exceeds byte budget; weight payloads are forbidden');}parts.push(next.value);}return {bytes:Buffer.concat(parts),contentRange:response.headers.get('content-range')};}
async function save(path:string,url:string,bytes:Buffer){await mkdir(path.slice(0,path.lastIndexOf('/')),{recursive:true});await writeFile(path,bytes);records.push({path,url,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.byteLength});}
const root='references/models',q='https://huggingface.co/Qwen/Qwen3-0.6B/resolve/'+pins.qwen+'/',d='https://huggingface.co/deepseek-ai/DeepSeek-V2-Lite/resolve/'+pins.deepseek+'/',t='https://raw.githubusercontent.com/huggingface/transformers/'+pins.transformers+'/';
for(const [path,url,limit] of [
  [root+'/qwen3-0.6b/config.json',q+'config.json',16384],
  [root+'/qwen3-0.6b/modeling_qwen3.py',t+'src/transformers/models/qwen3/modeling_qwen3.py',200000],
  [root+'/qwen3-0.6b/LICENSE',q+'LICENSE',50000],
  [root+'/deepseek-v2-lite/config.json',d+'config.json',16384],
  [root+'/deepseek-v2-lite/modeling_deepseek.py',d+'modeling_deepseek.py',200000],
  [root+'/deepseek-v2-lite/model.safetensors.index.json',d+'model.safetensors.index.json',2000000],
] as const){const result=await download(url,limit);await save(path,url,result.bytes);}
// Safetensors header only. Abort if a server ignores Range, never read tensor data.
const url=q+'model.safetensors',prefix=await download(url,8,'bytes=0-7');if(prefix.bytes.length!==8||!prefix.contentRange?.startsWith('bytes 0-7/'))throw Error('Invalid header prefix range');const length=Number(prefix.bytes.readBigUInt64LE());if(!Number.isSafeInteger(length)||length<1||length>2000000)throw Error('Safetensors header exceeds metadata budget');const header=await download(url,length,`bytes=8-${7+length}`);if(header.bytes.length!==length||!header.contentRange?.startsWith(`bytes 8-${7+length}/`))throw Error('Invalid header metadata range');JSON.parse(header.bytes.toString('utf8'));await save(root+'/qwen3-0.6b/safetensors-header.json',url+'#metadata-only-range-8-'+(7+length),header.bytes);
await writeFile(root+'/source-lock.json',JSON.stringify({schemaVersion:1,checkedOn:new Date().toISOString().slice(0,10),pins,records},null,2)+'\n');console.log('Pinned '+records.length+' public metadata/source files. No tensor weight payload downloaded.');
