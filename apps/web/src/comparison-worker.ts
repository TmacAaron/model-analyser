import { compareScenarios } from '@model-analyser/core';
import type { AssetDocument,Scenario,ScenarioComparisonAttempt,ScenarioComparisonRequest,ScenarioComparisonResult } from '@model-analyser/contracts';
import type { ComparisonExportSelection } from './comparison-export.js';
import type { ComparisonSerializationReply,ComparisonSerializationRequest } from './comparison-export-worker.js';

type ExportRequest={kind:'export';runId:number;jobId:number;selection:ComparisonExportSelection};
export type ComparisonWorkerRequest=
  |{kind:'start';runId:number;scenarios:Scenario[];assets:AssetDocument[];request:ScenarioComparisonRequest}
  |{kind:'cancel';runId:number}
  |ExportRequest
  |{kind:'cancel-export';runId:number;jobId:number};
export type ComparisonExportReply={kind:'exported';runId:number;jobId:number;selection:ComparisonExportSelection}&ComparisonSerializationReply;
export type ComparisonWorkerResponse=
  |{kind:'progress';runId:number;completed:number;total:number}
  |{kind:'result';runId:number;attempt:ScenarioComparisonAttempt}
  |{kind:'failed';runId:number;message:string}
  |ComparisonExportReply;

type Run={id:number;cancelled:boolean;report?:ScenarioComparisonResult};
const endpoint=globalThis as unknown as {
  onmessage:((event:MessageEvent<ComparisonWorkerRequest>)=>void)|null;
  postMessage:(message:ComparisonWorkerResponse)=>void;
};
let active:Run|undefined;
let exporter:{worker:Worker;runId:number;jobId:number}|undefined;

function stopExport(){
  exporter?.worker.terminate();
  exporter=undefined;
}

function exportReport({runId,jobId,selection}:ExportRequest){
  const identity={kind:'exported' as const,runId,jobId,selection};
  const fail=(message:string)=>endpoint.postMessage({...identity,message});
  if(active?.id!==runId||!active.report){
    fail('原比较结果已失效，请重新计算');
    return;
  }
  stopExport();
  try{
    const worker=new Worker(new URL('./comparison-export-worker.ts',import.meta.url),{type:'module'});
    exporter={worker,runId,jobId};
    worker.onmessage=({data}:MessageEvent<ComparisonSerializationReply>)=>{
      if(exporter?.worker!==worker)return;
      stopExport();
      endpoint.postMessage({...identity,...data});
    };
    const failed=()=>{
      if(exporter?.worker!==worker)return;
      stopExport();
      fail('后台导出失败，请重试');
    };
    worker.onerror=failed;
    worker.onmessageerror=failed;
    worker.postMessage({report:active.report,selection} satisfies ComparisonSerializationRequest);
  }catch(error){
    stopExport();
    fail(error instanceof Error?error.message:'无法启动后台导出');
  }
}

endpoint.onmessage=({data})=>{
  switch(data.kind){
    case 'start':{
      if(active)active.cancelled=true;
      stopExport();
      const run:Run={id:data.runId,cancelled:false};
      active=run;
      void compareScenarios(data.scenarios,data.assets,data.request,{
        isCancelled:()=>run.cancelled,
        onProgress:(completed,total)=>{
          if(active===run)endpoint.postMessage({kind:'progress',runId:run.id,completed,total});
        },
        yieldControl:()=>new Promise(resolve=>setTimeout(resolve,0)),
      }).then(attempt=>{
        if(active!==run)return;
        if(attempt.status==='available')run.report=attempt.result;
        endpoint.postMessage({kind:'result',runId:run.id,attempt});
      }).catch(error=>{
        if(active===run)endpoint.postMessage({kind:'failed',runId:run.id,message:error instanceof Error?error.message:'后台比较失败'});
      });
      break;
    }
    case 'cancel':if(active?.id===data.runId)active.cancelled=true;break;
    case 'export':exportReport(data);break;
    case 'cancel-export':
      if(exporter?.runId===data.runId&&exporter.jobId===data.jobId)stopExport();
      break;
  }
};
