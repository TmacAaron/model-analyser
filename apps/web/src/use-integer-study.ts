import { useEffect,useRef,useState } from 'react';
import type { StudyAttempt,StudyReply,StudyRequest,StudyStart } from './integer-study-protocol.js';

type Run={worker:Worker;key:string;received:boolean;exportId?:number};
type ExportState={kind:'running'|'cancelled'}|{kind:'error';message:string};
type Options={createWorker:()=>Worker;label:string;filename:string};
export function useIntegerStudy<Request,Result extends object>(key:string,{createWorker,label,filename}:Options){
  type Attempt=StudyAttempt<Result>;
  const live=useRef<Run|undefined>(undefined);
  const latest=useRef(key),exportSequence=useRef(0);
  latest.current=key;
  const [cached,setCached]=useState<{key:string;attempt:Attempt}>();
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

  function start(input:StudyStart<Request>,readAttempt:(value:unknown)=>Attempt|Promise<Attempt>,total=0){
    stop();setBusy(true);setCancelling(false);setError('');setCached(undefined);setHasResult(false);
    setProgress({completed:0,total});setExportState(undefined);
    try{
      const worker=createWorker();
      const run:Run={worker,key,received:false};
      live.current=run;
      const current=()=>live.current===run&&latest.current===run.key;
      const fail=(message:string)=>{
        if(!current())return;
        if(run.exportId!==undefined)setExportState({kind:'error',message:`后台${label}线程已关闭，请重新计算后导出`});
        else setError(message);
        stop();setBusy(false);setCancelling(false);
      };
      async function receiveAttempt(value:unknown){
        try{
          const attempt=await readAttempt(value);
          if(!current())return;
          if(attempt.status!=='available')stop();
          setCached({key,attempt});setHasResult(true);
          setBusy(false);setCancelling(false);
        }catch(failure){fail(failure instanceof Error?failure.message:`后台${label}结果无效`);}
      }
      worker.onmessage=({data}:MessageEvent<StudyReply<Attempt>>)=>{
        if(!current())return;
        if(!data||typeof data!=='object'){fail(`后台${label}结果无效`);return;}
        if(data.kind==='exported'){
          if(run.exportId===undefined||data.jobId!==run.exportId)return;
          delete run.exportId;
          try{
            if('message'in data)throw Error(data.message);
            if(!(data.blob instanceof Blob)||data.blob.type!=='application/json'||data.blob.size===0)throw Error(`后台返回了无效的${label}文件`);
            const url=URL.createObjectURL(data.blob);
            try{
              const link=document.createElement('a');
              link.href=url;link.download=filename;link.click();
            }finally{URL.revokeObjectURL(url);}
            setExportState(undefined);
          }catch(failure){
            setExportState({kind:'error',message:failure instanceof Error?failure.message:`无法下载${label}文件`});
          }
          return;
        }
        if(run.received)return;
        if(data.kind==='progress'){setProgress({completed:data.completed,total:data.total});return;}
        if(data.kind==='failed'){fail(data.message);return;}
        if(data.kind!=='result'){fail(`后台${label}结果无效`);return;}
        run.received=true;
        void receiveAttempt(data.attempt);
      };
      worker.onerror=()=>fail(`后台${label}失败，请缩小范围后重试`);
      worker.onmessageerror=()=>fail(`无法读取后台${label}回复`);
      worker.postMessage({kind:'start',...input} satisfies StudyRequest<Request>);
    }catch(failure){
      stop();setBusy(false);
      setError(failure instanceof Error?failure.message:`无法启动后台${label}`);
    }
  }

  function cancel(){
    const run=live.current;
    if(!run||run.received||run.key!==key)return;
    setCancelling(true);
    try{run.worker.postMessage({kind:'cancel'} satisfies StudyRequest<Request>);}
    catch{stop();setBusy(false);setCancelling(false);setError(`后台${label}线程已关闭，请重试`);}
  }

  function exportFile(){
    if(!report)return;
    const run=live.current;
    if(!run?.received||run.key!==key){
      setExportState({kind:'error',message:`后台${label}线程已关闭，请重新计算后导出`});
      return;
    }
    if(run.exportId!==undefined)return;
    const jobId=++exportSequence.current;
    run.exportId=jobId;
    setExportState({kind:'running'});
    try{run.worker.postMessage({kind:'export',jobId} satisfies StudyRequest<Request>);}
    catch{delete run.exportId;setExportState({kind:'error',message:`无法开始后台${label}导出，请重试`});}
  }

  function cancelExport(){
    const run=live.current,jobId=run?.exportId;
    if(!run||jobId===undefined)return;
    delete run.exportId;
    try{run.worker.postMessage({kind:'cancel-export',jobId} satisfies StudyRequest<Request>);}
    catch{stop();}
    setExportState({kind:'cancelled'});
  }

  return {attempt,report,busy,cancelling,error,setError,progress,previous:hasResult&&!attempt,start,cancel,
    exportFile,cancelExport,exportState:report?exportState:undefined};
}
