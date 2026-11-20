import { RocmTraceImport,type RocmTraceEvent } from '@model-analyser/contracts';
import { parseCsv } from '../../contracts/src/csv.js';
export const rocmCsvRequired=['Dispatch_ID','Kernel_Name','GPU_ID','queue-id','pid','tid','Start_Timestamp','End_Timestamp'] as const;
export const rocmCsvColumns=[...rocmCsvRequired,'queue-index','Grid_Size','Workgroup_Size','LDS_Per_Workgroup','Scratch_Per_Workitem','Arch_VGPR','Accum_VGPR','SGPR','wave_size','sig','obj','DispatchNs','CompleteNs'] as const;
const uint64Max=(1n<<64n)-1n,relativeMax=BigInt(Number.MAX_SAFE_INTEGER);
export function parseNanoseconds(value:string,label:string):bigint{if(!/^(0|[1-9]\d{0,19})$/.test(value))throw Error(label+' 必须是规范无符号十进制整数（纳秒/ID），不接受小数、指数或单位后缀');const n=BigInt(value);if(n>uint64Max)throw Error(label+' 超过 uint64');return n;}
export function relativeNanosecondsToSeconds(value:bigint):number{if(value<0n||value>relativeMax)throw Error('相对时间、时长或累计值超过精确纳秒范围（2^53−1 ns）');return Number(value)/1e9;}
export async function decodeRocmCsv(text:string,sourceName:string):Promise<RocmTraceImport>{
  const bytes=new TextEncoder().encode(text);if(bytes.length>64*1024*1024)throw Error('ROCm CSV 解压后超过64 MiB');
  const table=parseCsv(text.replace(/^\uFEFF/,''),{maxRows:100001,maxColumns:rocmCsvColumns.length,maxCellLength:1024*1024}),header=table[0]?.cells;if(!header)throw Error('ROCm CSV 缺少表头');
  if(new Set(header).size!==header.length)throw Error('ROCm CSV 表头重复');const allowed=new Set<string>(rocmCsvColumns);if(header.some(c=>!allowed.has(c)))throw Error('ROCm CSV 未知列：'+header.filter(c=>!allowed.has(c)).join(', '));if(rocmCsvRequired.some(c=>!header.includes(c)))throw Error('ROCm CSV 缺少列：'+rocmCsvRequired.filter(c=>!header.includes(c)).join(', '));
  if(table.length<2)throw Error('ROCm CSV 没有数据行');const events:RocmTraceEvent[]=[],seen=new Set<string>();let origin:bigint|undefined,zeroDurationCount=0;
  for(const [index,row] of table.slice(1).entries()){
    try{if(row.cells.length!==header.length)throw Error('列数与表头不一致');const fields=new Map(header.map((c,i)=>[c,row.cells[i]??''])),get=(k:string)=>fields.get(k)??'',uint=(k:string)=>{const v=get(k);parseNanoseconds(v,k);return v;};
      const dispatchId=uint('Dispatch_ID'),pid=uint('pid'),tid=uint('tid'),sourceDevice=uint('GPU_ID'),sourceQueue=uint('queue-id'),start=parseNanoseconds(get('Start_Timestamp'),'Start_Timestamp'),end=parseNanoseconds(get('End_Timestamp'),'End_Timestamp'),key=JSON.stringify([pid,sourceDevice,dispatchId]);if(seen.has(key))throw Error('重复dispatch身份（pid/GPU_ID/Dispatch_ID），可能是重复counter行；不能重复计调用');seen.add(key);
      const name=get('Kernel_Name');if(!name)throw Error('Kernel_Name 不能为空');if(end<start)throw Error('End_Timestamp 早于 Start_Timestamp');
      const rawDispatchNanoseconds=header.includes('DispatchNs')?uint('DispatchNs'):undefined,rawCompleteNanoseconds=header.includes('CompleteNs')?uint('CompleteNs'):undefined;if(rawDispatchNanoseconds!==undefined&&BigInt(rawDispatchNanoseconds)>start||rawCompleteNanoseconds!==undefined&&BigInt(rawCompleteNanoseconds)<end)throw Error('DispatchNs/CompleteNs 与kernel起止顺序不一致');
      if(end===start){zeroDurationCount++;continue;}
      const seconds=relativeNanosecondsToSeconds(end-start);events.push({index,name,category:'ROCm kernel',pid,tid,sourceDevice,sourceQueue,dispatchId,csvLine:row.line,rawStartNanoseconds:get('Start_Timestamp'),rawEndNanoseconds:get('End_Timestamp'),seconds,startSeconds:0,...(rawDispatchNanoseconds!==undefined?{rawDispatchNanoseconds}:{}),...(rawCompleteNanoseconds!==undefined?{rawCompleteNanoseconds}:{})});if(origin===undefined||start<origin)origin=start;
    }catch(error){throw Error(`ROCm CSV 第 ${row.line} 行：${error instanceof Error?error.message:String(error)}`);}
  }
  if(origin===undefined||!events.length)throw Error('ROCm CSV 没有正时长kernel事件；零时长不生成测量');for(const e of events){e.startSeconds=relativeNanosecondsToSeconds(BigInt(e.rawStartNanoseconds)-origin);relativeNanosecondsToSeconds(BigInt(e.rawEndNanoseconds)-origin);}
  const hash=await globalThis.crypto.subtle.digest('SHA-256',bytes),contentHash=[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('');
  return RocmTraceImport.parse({version:'rocm-timestamps.1',sourceName,contentHash,originNanoseconds:String(origin),rawEventCount:table.length-1,zeroDurationCount,ignoredColumns:header.filter(c=>!rocmCsvRequired.includes(c as typeof rocmCsvRequired[number])&&!['DispatchNs','CompleteNs'].includes(c)),events});
}
