import { useEffect,useRef,useState } from 'react';
import { RooflineStudyAttempt,type AssetDocument,type RooflineStudyRequest,type Scenario } from '@model-analyser/contracts';
import { ENGINE_VERSION,stableStringify } from '@model-analyser/core';
import type { RooflineWorkerRequest,RooflineWorkerResponse } from './roofline-study-worker.js';

type Run={worker:Worker;key:string;ready:boolean;exportId?:number};
type ExportState={kind:'running'|'cancelled'}|{kind:'error';message:string};

export function useRooflineStudy(key:string){
  const live=useRef<Run|undefined>(undefined);
  const latest=useRef(key),exportSequence=useRef(0);
  latest.current=key;
  const [cached,setCached]=useState<{key:string;attempt:RooflineStudyAttempt}>();
  const [hasResult,setHasResult]=useState(false);
  const [busy,setBusy]=useState(false),[cancelling,setCancelling]=useState(false),[error,setError]=useState('');
  const [progress,setProgress]=useState({completed:0,total:0});
  const [exportState,setExportState]=useState<ExportState>();
  const attempt=cached?.key===key?cached.attempt:undefined;
  const report=attempt?.status==='available'?attempt.result:undefined;

  function stop(){
    live.current?.worker.terminate();
    live.current=undefined;
  }
  useEffect(()=>{
    stop();setBusy(false);setCancelling(false);setError('');setExportState(undefined);
    setCached(old=>old?.key===key?old:undefined);
  },[key]);
  useEffect(()=>stop,[]);

  function start(scenario:Scenario,assets:AssetDocument[],request:RooflineStudyRequest,inputHash:string){
    stop();setBusy(true);setCancelling(false);setError('');setCached(undefined);setHasResult(false);
    setProgress({completed:0,total:0});setExportState(undefined);
    try{
      const worker=new Worker(new URL('./roofline-study-worker.ts',import.meta.url),{type:'module'});
      const run:Run={worker,key,ready:false};
      live.current=run;
      const current=()=>live.current===run&&latest.current===run.key;
      const fail=(message:string)=>{
        if(!current())return;
        if(run.exportId!==undefined)setExportState({kind:'error',message:'后台 Roofline 线程已关闭，请重新计算后导出'});
        else setError(message);
        stop();setBusy(false);setCancelling(false);
      };
      worker.onmessage=({data}:MessageEvent<RooflineWorkerResponse>)=>{
        if(!current())return;
        if(!data||typeof data!=='object'){fail('后台 Roofline 结果无效');return;}
        if(data.kind==='exported'){
          if(data.jobId!==run.exportId)return;
          delete run.exportId;
          try{
            if('message'in data)throw Error(data.message);
            if(!(data.blob instanceof Blob)||data.blob.type!=='application/json'||data.blob.size===0)throw Error('后台返回了无效的 Roofline 文件');
            const url=URL.createObjectURL(data.blob);
            try{
              const link=document.createElement('a');
              link.href=url;link.download='roofline-study.json';link.click();
            }finally{URL.revokeObjectURL(url);}
            setExportState(undefined);
          }catch(failure){
            setExportState({kind:'error',message:failure instanceof Error?failure.message:'无法下载 Roofline 研究文件'});
          }
          return;
        }
        if(run.ready)return;
        if(data.kind==='progress'){setProgress({completed:data.completed,total:data.total});return;}
        if(data.kind==='failed'){fail(data.message);return;}
        if(data.kind!=='result'){fail('后台 Roofline 结果无效');return;}
        try{
          const result=RooflineStudyAttempt.parse(data.attempt);
          if(result.status==='available'){
            const {engineVersion,scenario:pinned,request:actual,analysis}=result.result;
            if(engineVersion!==ENGINE_VERSION||pinned.scenarioId!==scenario.scenarioId||stableStringify(actual)!==stableStringify(request)||
              (analysis.status==='available'&&analysis.result.inputHash!==inputHash)){
              throw Error('后台 Roofline 结果与当前计算输入不同');
            }
            run.ready=true;
          }else stop();
          setCached({key,attempt:result});setHasResult(true);
          setBusy(false);setCancelling(false);
        }catch(failure){fail(failure instanceof Error?failure.message:'后台 Roofline 结果无效');}
      };
      worker.onerror=()=>fail('后台 Roofline 分析失败，请缩小范围后重试');
      worker.onmessageerror=()=>fail('无法读取后台 Roofline 回复');
      worker.postMessage({kind:'start',scenario,assets,request} satisfies RooflineWorkerRequest);
    }catch(failure){
      stop();setBusy(false);
      setError(failure instanceof Error?failure.message:'无法启动后台 Roofline 研究');
    }
  }

  function cancel(){
    const run=live.current;
    if(!run||run.ready||run.key!==key)return;
    setCancelling(true);
    try{run.worker.postMessage({kind:'cancel'} satisfies RooflineWorkerRequest);}
    catch{stop();setBusy(false);setCancelling(false);setError('后台 Roofline 线程已关闭，请重试');}
  }

  function exportFile(){
    if(!report)return;
    const run=live.current;
    if(!run?.ready||run.key!==key){
      setExportState({kind:'error',message:'后台 Roofline 线程已关闭，请重新计算后导出'});
      return;
    }
    if(run.exportId!==undefined)return;
    const jobId=++exportSequence.current;
    run.exportId=jobId;
    setExportState({kind:'running'});
    try{run.worker.postMessage({kind:'export',jobId} satisfies RooflineWorkerRequest);}
    catch{delete run.exportId;setExportState({kind:'error',message:'无法开始后台 Roofline 导出，请重试'});}
  }

  function cancelExport(){
    const run=live.current,jobId=run?.exportId;
    if(!run||jobId===undefined)return;
    delete run.exportId;
    try{run.worker.postMessage({kind:'cancel-export',jobId} satisfies RooflineWorkerRequest);}
    catch{stop();}
    setExportState({kind:'cancelled'});
  }

  return {attempt,report,busy,cancelling,error,setError,progress,previous:hasResult&&!attempt,start,cancel,
    exportFile,cancelExport,exportState:report?exportState:undefined};
}
