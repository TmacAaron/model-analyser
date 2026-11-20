import type { AssetDocument,Scenario } from '@model-analyser/contracts';
import type { CapacitySearchControl } from '@model-analyser/core';
import type { StudyAttempt,StudyReply,StudyRequest,StudySerialization } from './integer-study-protocol.js';

export function serveIntegerStudy<Request,Attempt extends StudyAttempt>(
  compute:(scenario:Scenario,assets:AssetDocument[],request:Request,control:CapacitySearchControl)=>Promise<Attempt>,
){
  const endpoint=globalThis as unknown as {
    onmessage:((event:MessageEvent<StudyRequest<Request>>)=>void)|null;
    postMessage:(message:StudyReply<Attempt>)=>void;
  };
  type Run={cancelled:boolean;report?:object};
  let active:Run|undefined;
  let exporter:{worker:Worker;jobId:number}|undefined;

  function stopExport(){
    exporter?.worker.terminate();
    exporter=undefined;
  }

  function exportReport(jobId:number){
    const identity={kind:'exported' as const,jobId};
    const report=active?.report;
    if(!report){
      endpoint.postMessage({...identity,message:'原结果已失效，请重新计算'});
      return;
    }
    stopExport();
    try{
      const worker=new Worker(new URL('./integer-study-export-worker.ts',import.meta.url),{type:'module'});
      exporter={worker,jobId};
      worker.onmessage=({data}:MessageEvent<StudySerialization>)=>{
        if(exporter?.worker!==worker)return;
        stopExport();
        endpoint.postMessage({...identity,...data});
      };
      const failed=()=>{
        if(exporter?.worker!==worker)return;
        stopExport();
        endpoint.postMessage({...identity,message:'后台导出失败，请重试'});
      };
      worker.onerror=failed;
      worker.onmessageerror=failed;
      worker.postMessage(report);
    }catch{
      stopExport();
      endpoint.postMessage({...identity,message:'无法启动后台导出，请重试'});
    }
  }

  endpoint.onmessage=({data})=>{
    switch(data.kind){
      case 'start':{
        if(active)active.cancelled=true;
        stopExport();
        const run:Run={cancelled:false};
        active=run;
        void compute(data.scenario,data.assets,data.request,{
          isCancelled:()=>run.cancelled,
          onProgress:(completed,total)=>{
            if(active===run)endpoint.postMessage({kind:'progress',completed,total});
          },
          // Give the worker a chance to handle cancellation between analyses.
          yieldControl:()=>new Promise(resolve=>setTimeout(resolve,0)),
        }).then(attempt=>{
          if(active!==run)return;
          if(attempt.status==='available')run.report=attempt.result;
          endpoint.postMessage({kind:'result',attempt});
        }).catch(error=>{
          if(active===run)endpoint.postMessage({kind:'failed',message:error instanceof Error?error.message:'后台计算失败'});
        });
        break;
      }
      case 'cancel':if(active)active.cancelled=true;break;
      case 'export':exportReport(data.jobId);break;
      case 'cancel-export':if(exporter?.jobId===data.jobId)stopExport();break;
    }
  };
}
