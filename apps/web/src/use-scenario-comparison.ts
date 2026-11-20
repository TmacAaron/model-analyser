import { useEffect,useRef,useState } from 'react';
import type { ScenarioComparisonAttempt,AssetDocument,Scenario,ScenarioComparisonRequest } from '@model-analyser/contracts';
import { stableStringify } from '@model-analyser/core';
import { comparisonExportFiles,type ComparisonExportSelection } from './comparison-export.js';
import type { ComparisonExportReply,ComparisonWorkerRequest,ComparisonWorkerResponse } from './comparison-worker.js';
import {readComparisonCompletion,type ComparisonPreview} from './comparison-result-transport.js';

type ExportJob={id:number;selection:ComparisonExportSelection};
type Run={id:number;worker:Worker;key:string;ready:boolean;job?:ExportJob};
type ExportStatus={kind:'running'|'cancelled'|'error';selection:ComparisonExportSelection;message?:string};

function download(blob:Blob,name:string){
  const url=URL.createObjectURL(blob);
  try{
    const link=document.createElement('a');
    link.href=url;link.download=name;link.click();
  }finally{URL.revokeObjectURL(url);}
}

export function useScenarioComparison(key:string){
  const live=useRef<Run|undefined>(undefined);
  const nonce=useRef(0),latest=useRef(key);
  latest.current=key;
  const [cached,setCached]=useState<{key:string;attempt:ScenarioComparisonAttempt;preview?:ComparisonPreview}>();
  const [hasResult,setHasResult]=useState(false);
  const [busy,setBusy]=useState(false),[cancelling,setCancelling]=useState(false),[error,setError]=useState('');
  const [progress,setProgress]=useState({completed:0,total:0});
  const [exportStatus,setExportStatus]=useState<ExportStatus>();
  const attempt=cached?.key===key?cached.attempt:undefined;
  const preview=cached?.key===key?cached.preview:undefined;
  const report=attempt?.status==='available'?attempt.result:undefined;

  function stop(){
    live.current?.worker.terminate();
    live.current=undefined;
  }
  useEffect(()=>{
    stop();setBusy(false);setCancelling(false);setError('');setExportStatus(undefined);
    setCached(old=>old?.key===key?old:undefined);
  },[key]);
  useEffect(()=>stop,[]);

  function receiveExport(run:Run,data:ComparisonExportReply){
    const job=run.job;
    if(!job||data.jobId!==job.id)return;
    delete run.job;
    const {selection}=job,file=comparisonExportFiles[selection.kind];
    try{
      if(data.runId!==run.id||stableStringify(data.selection)!==stableStringify(selection))throw Error('导出回复与当前比较或所选范围不同');
      if('message'in data&&typeof data.message==='string')throw Error(data.message);
      if(!('blob'in data)||!(data.blob instanceof Blob)||data.blob.type!==file.type||data.blob.size===0)throw Error('后台返回了无效的比较文件');
      download(data.blob,file.name);
      setExportStatus(undefined);
    }catch(failure){
      setExportStatus({kind:'error',selection,message:failure instanceof Error?failure.message:'无法下载比较文件'});
    }
  }

  function start(scenarios:Scenario[],assets:AssetDocument[],request:ScenarioComparisonRequest){
    stop();setCached(undefined);setHasResult(false);setError('');setExportStatus(undefined);
    setBusy(true);setCancelling(false);setProgress({completed:0,total:0});
    try{
      const worker=new Worker(new URL('./comparison-worker.ts',import.meta.url),{type:'module'});
      const run:Run={id:++nonce.current,worker,key,ready:false};
      live.current=run;
      const current=()=>live.current===run&&latest.current===run.key;
      const fail=(message:string)=>{
        if(!current())return;
        if(run.job)setExportStatus({kind:'error',selection:run.job.selection,message:'比较线程已关闭，请重新计算后导出'});
        else setError(message);
        stop();setBusy(false);setCancelling(false);
      };
      worker.onmessage=({data}:MessageEvent<ComparisonWorkerResponse>)=>{
        if(!current())return;
        if(!data||typeof data!=='object'){
          fail('比较线程返回无效结果');return;
        }
        if(data.kind==='exported'){receiveExport(run,data);return;}
        if(run.ready)return;
        if(data.runId!==run.id){fail('比较回复的任务身份不同');return;}
        if(data.kind==='progress'){setProgress({completed:data.completed,total:data.total});return;}
        if(data.kind==='failed'){fail(data.message);return;}
        if(data.kind!=='result'){fail('比较线程返回无效结果');return;}
        try{
          const parsed=readComparisonCompletion(data,run.id,request,scenarios);
          setCached({key:run.key,...parsed});setHasResult(true);
          setBusy(false);setCancelling(false);
          if(parsed.attempt.status==='available')run.ready=true;
          else stop();
        }catch(failure){fail(failure instanceof Error?failure.message:'比较线程返回无效结果');}
      };
      worker.onerror=()=>fail('后台比较失败，请缩小范围后重试');
      worker.onmessageerror=()=>fail('无法读取比较线程回复');
      worker.postMessage({kind:'start',runId:run.id,scenarios,assets,request} satisfies ComparisonWorkerRequest);
    }catch(failure){
      stop();setBusy(false);setError(failure instanceof Error?failure.message:'无法启动后台比较');
    }
  }

  function cancel(){
    const run=live.current;
    if(!run||run.ready)return;
    setCancelling(true);
    try{run.worker.postMessage({kind:'cancel',runId:run.id} satisfies ComparisonWorkerRequest);}
    catch{stop();setBusy(false);setCancelling(false);setError('比较线程已关闭，请重新计算');}
  }

  function exportFile(selection:ComparisonExportSelection){
    if(!report)return;
    const run=live.current;
    if(!run?.ready||run.key!==key){
      setExportStatus({kind:'error',selection,message:'比较线程已关闭，请重新计算后导出'});
      return;
    }
    if(run.job)return;
    const job={id:++nonce.current,selection};
    run.job=job;
    setExportStatus({kind:'running',selection});
    try{run.worker.postMessage({kind:'export',runId:run.id,jobId:job.id,selection} satisfies ComparisonWorkerRequest);}
    catch{delete run.job;setExportStatus({kind:'error',selection,message:'无法开始后台导出，请重试'});}
  }

  function cancelExport(){
    const run=live.current,job=run?.job;
    if(!run||!job)return;
    delete run.job;
    try{run.worker.postMessage({kind:'cancel-export',runId:run.id,jobId:job.id} satisfies ComparisonWorkerRequest);}
    catch{stop();}
    setExportStatus({kind:'cancelled',selection:job.selection});
  }

  return {attempt,report,preview,busy,cancelling,error,setError,progress,previous:hasResult&&!attempt,start,cancel,exportFile,cancelExport,
    exportStatus:report?exportStatus:undefined};
}
