import type { ScenarioComparisonResult } from '@model-analyser/contracts';
import { serializeComparison,type ComparisonExportSelection } from './comparison-export.js';

export type ComparisonSerializationRequest={report:ScenarioComparisonResult;selection:ComparisonExportSelection};
export type ComparisonSerializationReply={blob:Blob}|{message:string};
const endpoint=globalThis as unknown as {
  onmessage:((event:MessageEvent<ComparisonSerializationRequest>)=>void)|null;
  postMessage:(reply:ComparisonSerializationReply)=>void;
};

endpoint.onmessage=({data:{report,selection}})=>{
  try{endpoint.postMessage({blob:serializeComparison(report,selection)});}
  catch(error){endpoint.postMessage({message:error instanceof Error?error.message:'无法生成比较文件'});}
};
