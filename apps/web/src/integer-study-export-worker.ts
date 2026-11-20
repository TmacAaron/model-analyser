import type { StudySerialization } from './integer-study-protocol.js';

const endpoint=globalThis as unknown as {
  onmessage:((event:MessageEvent<object>)=>void)|null;
  postMessage:(reply:StudySerialization)=>void;
};

endpoint.onmessage=({data:report})=>{
  try{
    endpoint.postMessage({blob:new Blob([JSON.stringify(report,null,2)],{type:'application/json'})});
  }catch(error){
    endpoint.postMessage({message:error instanceof Error?error.message:'无法生成研究文件'});
  }
};
