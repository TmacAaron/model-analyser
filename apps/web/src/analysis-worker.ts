import { analyzeScenario } from '@model-analyser/core';
import type { Scenario,AssetDocument,AnalysisResult } from '@model-analyser/contracts';
import {selectExportContents,type AnalysisExportRequest,type AnalysisExportReply} from './analysis-export.js';
import type {AnalysisSerializationReply} from './analysis-export-worker.js';
import type {AnalysisCompletion} from './analysis-result-transport.js';

export type AnalysisWorkerRequest={kind:'analyze';taskId:number;scenario:Scenario;assets:AssetDocument[]}|AnalysisExportRequest|{kind:'cancel_export';taskId:number};
const endpoint=globalThis as unknown as {onmessage:((event:MessageEvent<AnalysisWorkerRequest>)=>void)|null;postMessage:(reply:AnalysisCompletion|AnalysisExportReply)=>void};
let result:AnalysisResult|undefined;
let activeExport:{worker:Worker;taskId:number}|undefined;

function stopExport(){activeExport?.worker.terminate();activeExport=undefined;}

function exportResult(request:AnalysisExportRequest){
  stopExport();
  const {taskId,inputHash,engineVersion,selection}=request;
  const identity={kind:'exported' as const,taskId,inputHash,engineVersion,selection};
  const fail=(message:string)=>endpoint.postMessage({...identity,status:'error',message});
  try{
    if(!result||result.inputHash!==inputHash||result.engineVersion!==engineVersion)throw Error('导出请求与已计算的结果不同，请重新计算');
    const contents=selectExportContents(result,selection);
    const worker=new Worker(new URL('./analysis-export-worker.ts',import.meta.url),{type:'module'});
    activeExport={worker,taskId};
    worker.onmessage=({data}:MessageEvent<AnalysisSerializationReply>)=>{
      if(activeExport?.worker!==worker)return;
      stopExport();
      if('blob'in data)endpoint.postMessage({...identity,status:'available',blob:data.blob});
      else fail(data.message);
    };
    const failed=()=>{if(activeExport?.worker===worker){stopExport();fail('后台导出失败，请重试');}};
    worker.onerror=failed;
    worker.onmessageerror=failed;
    worker.postMessage(contents);
  }catch(e){stopExport();fail(e instanceof Error?e.message:'无法开始后台导出');}
}

endpoint.onmessage=({data:request})=>{
  switch(request.kind){
    case 'analyze':
      void analyzeScenario(request.scenario,request.assets).then(attempt=>{
        result=attempt.status==='available'?attempt.result:undefined;
        endpoint.postMessage({kind:'analyzed',taskId:request.taskId,attempt});
      });
      break;
    case 'export':exportResult(request);break;
    case 'cancel_export':if(activeExport?.taskId===request.taskId)stopExport();break;
  }
};
