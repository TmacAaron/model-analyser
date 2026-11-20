import { studyRoofline } from '@model-analyser/core';
import type { AssetDocument,Scenario,RooflineStudyRequest,RooflineStudyAttempt,RooflineStudyResult } from '@model-analyser/contracts';
import type { RooflineSerializationReply } from './roofline-study-export-worker.js';

type ExportRequest={kind:'export';jobId:number};
export type RooflineWorkerRequest=
  |{kind:'start';scenario:Scenario;assets:AssetDocument[];request:RooflineStudyRequest}
  |{kind:'cancel'}
  |ExportRequest
  |{kind:'cancel-export';jobId:number};
export type RooflineWorkerResponse=
  |{kind:'progress';completed:number;total:number}
  |{kind:'result';attempt:RooflineStudyAttempt}
  |{kind:'failed';message:string}
  |({kind:'exported';jobId:number}&RooflineSerializationReply);

const endpoint=globalThis as unknown as {
  onmessage:((event:MessageEvent<RooflineWorkerRequest>)=>void)|null;
  postMessage:(message:RooflineWorkerResponse)=>void;
};
let active:{cancelled:boolean;report?:RooflineStudyResult}|undefined;
let exporter:{worker:Worker;jobId:number}|undefined;

function stopExport(){
  exporter?.worker.terminate();
  exporter=undefined;
}

function exportResult(jobId:number){
  const identity={kind:'exported' as const,jobId};
  const report=active?.report;
  if(!report){
    endpoint.postMessage({...identity,message:'原 Roofline 研究已失效，请重新计算'});
    return;
  }
  stopExport();
  try{
    const worker=new Worker(new URL('./roofline-study-export-worker.ts',import.meta.url),{type:'module'});
    exporter={worker,jobId};
    worker.onmessage=({data}:MessageEvent<RooflineSerializationReply>)=>{
      if(exporter?.worker!==worker)return;
      stopExport();
      endpoint.postMessage({...identity,...data});
    };
    const failed=()=>{
      if(exporter?.worker!==worker)return;
      stopExport();
      endpoint.postMessage({...identity,message:'后台 Roofline 导出失败，请重试'});
    };
    worker.onerror=failed;
    worker.onmessageerror=failed;
    worker.postMessage(report);
  }catch{
    stopExport();
    endpoint.postMessage({...identity,message:'无法启动后台 Roofline 导出，请重试'});
  }
}

endpoint.onmessage=({data})=>{
  switch(data.kind){
    case 'start':{
      if(active)active.cancelled=true;
      stopExport();
      const run:NonNullable<typeof active>={cancelled:false};
      active=run;
      void studyRoofline(data.scenario,data.assets,data.request,{
        isCancelled:()=>run.cancelled,
        onProgress:(completed,total)=>{
          if(active===run)endpoint.postMessage({kind:'progress',completed,total});
        },
        yieldControl:()=>new Promise(resolve=>setTimeout(resolve,0)),
      }).then(attempt=>{
        if(active!==run)return;
        if(attempt.status==='available')run.report=attempt.result;
        endpoint.postMessage({kind:'result',attempt});
      }).catch(error=>{
        if(active===run)endpoint.postMessage({kind:'failed',message:error instanceof Error?error.message:'后台 Roofline 分析失败'});
      });
      break;
    }
    case 'cancel':if(active)active.cancelled=true;break;
    case 'export':exportResult(data.jobId);break;
    case 'cancel-export':if(exporter?.jobId===data.jobId)stopExport();break;
  }
};
