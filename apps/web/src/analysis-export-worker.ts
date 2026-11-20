import {serializeAnalysisExport,type ExportContents} from './analysis-export.js';

export type AnalysisSerializationReply={blob:Blob}|{message:string};
const endpoint=globalThis as unknown as {onmessage:((event:MessageEvent<ExportContents>)=>void)|null;postMessage:(reply:AnalysisSerializationReply)=>void};
endpoint.onmessage=({data:contents})=>{
  try{endpoint.postMessage({blob:serializeAnalysisExport(contents)});}
  catch(e){endpoint.postMessage({message:e instanceof Error?e.message:'无法序列化此分析结果'});}
};
