import type { RooflineStudyResult } from '@model-analyser/contracts';

export type RooflineSerializationReply={blob:Blob}|{message:string};
const endpoint=globalThis as unknown as {
  onmessage:((event:MessageEvent<RooflineStudyResult>)=>void)|null;
  postMessage:(reply:RooflineSerializationReply)=>void;
};

endpoint.onmessage=({data:report})=>{
  try{
    endpoint.postMessage({blob:new Blob([JSON.stringify(report,null,2)],{type:'application/json'})});
  }catch(error){
    endpoint.postMessage({message:error instanceof Error?error.message:'无法生成 Roofline 研究文件'});
  }
};
