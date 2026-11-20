import { decodeChromeTrace,decodeRocmCsv,traceByteLimit } from '@model-analyser/core';

self.onmessage=(event:MessageEvent<{file:File;format:'chrome'|'rocm'}>)=>{void(async()=>{try{
  const file=event.data.file;if(file.size>traceByteLimit)throw Error('Trace 文件超过 64 MiB');
  const stream=file.name.toLowerCase().endsWith('.gz')?file.stream().pipeThrough(new DecompressionStream('gzip')):file.stream(),reader=stream.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>traceByteLimit)throw Error('Trace 解压后超过 64 MiB');chunks.push(next.value);}}finally{await reader.cancel();}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),format=event.data.format;if(format!=='chrome'&&format!=='rocm')throw Error('请选择明确的profiler格式');self.postMessage({ok:true,data:await(format==='rocm'?decodeRocmCsv(text,file.name):decodeChromeTrace(text,file.name))});
}catch(e){self.postMessage({ok:false,message:e instanceof Error?e.message:'Trace 解析失败'});}})();};
