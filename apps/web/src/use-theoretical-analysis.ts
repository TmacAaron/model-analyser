import {useEffect,useRef,useState} from 'react';
import {AnalysisAttempt,type AnalysisResult,type AssetDocument,type Scenario} from '@model-analyser/contracts';
import {analysisExportFilename,type AnalysisExportRequest,type AnalysisExportSelection} from './analysis-export.js';
import type {AnalysisWorkerRequest} from './analysis-worker.js';

export type AnalysisExportState={owner:AnalysisResult;selection:AnalysisExportSelection}&(
  {status:'running'|'cancelled'}|{status:'error';message:string}
);
type ActiveExport={owner:AnalysisResult;request:AnalysisExportRequest};
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
function matchesSelection(reply:unknown,selection:AnalysisExportSelection){
  return record(reply)&&reply.kind===selection.kind&&
    (selection.kind!=='step'||reply.index===selection.index&&reply.inputHash===selection.inputHash);
}

function downloadBlob(blob:Blob,name:string){
  const url=URL.createObjectURL(blob);
  try{
    const link=document.createElement('a');
    link.href=url;link.download=name;link.click();
  }finally{URL.revokeObjectURL(url);}
}

export function useTheoreticalAnalysis(scenario:Scenario,assets:AssetDocument[],key:string){
  const worker=useRef<Worker|null>(null),completed=useRef(false),latest=useRef(key),exportId=useRef(0),activeExport=useRef<ActiveExport|undefined>(undefined);
  latest.current=key;
  const [cached,setCached]=useState<{key:string;attempt:AnalysisAttempt}>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [exportState,setExportState]=useState<AnalysisExportState>();
  const attempt=cached?.key===key?cached.attempt:null,result=attempt?.status==='available'?attempt.result:null;

  function stop(){worker.current?.terminate();worker.current=null;activeExport.current=undefined;completed.current=false;}
  function stopExport(job:ActiveExport){
    activeExport.current=undefined;
    try{worker.current?.postMessage({kind:'cancel_export',taskId:job.request.taskId} satisfies AnalysisWorkerRequest);}
    catch{stop();}
  }
  useEffect(()=>{
    if(!completed.current)stop();
    else if(activeExport.current)stopExport(activeExport.current);
    setBusy(false);setError('');setExportState(undefined);
  },[key]);
  useEffect(()=>stop,[]);

  function exportFailed({owner,request:{selection}}:ActiveExport,message:string){setExportState({owner,selection,status:'error',message});}

  function receiveExport(data:Record<string,unknown>){
    const job=activeExport.current;
    if(!job||data.taskId!==job.request.taskId)return;
    activeExport.current=undefined;
    const {owner,request}=job,{selection}=request;
    if(data.inputHash!==request.inputHash||data.engineVersion!==request.engineVersion||!matchesSelection(data.selection,selection)){
      exportFailed(job,'导出回复与当前结果或实际步骤不同，请重试');return;
    }
    if(data.status==='error'&&typeof data.message==='string'){exportFailed(job,data.message);return;}
    const expectedType=selection.kind==='csv'?'text/csv':'application/json';
    if(data.status!=='available'||!(data.blob instanceof Blob)||data.blob.type!==expectedType||data.blob.size===0){
      exportFailed(job,'后台返回了无效的导出文件，请重试');return;
    }
    try{downloadBlob(data.blob,analysisExportFilename(owner,selection));setExportState(undefined);}
    catch{exportFailed(job,'无法下载导出文件，请重试');}
  }

  function run(){
    stop();setBusy(true);setCached(undefined);setError('');setExportState(undefined);
    let instance:Worker|undefined;
    const current=()=>instance!==undefined&&worker.current===instance&&latest.current===key;
    let awaitingAnalysis=true;
    const onError=()=>{
      if(!current())return;
      if(activeExport.current)exportFailed(activeExport.current,'分析线程已关闭，请重新计算后导出');
      else setError('分析失败，请检查配置或缩小展开规模');
      setBusy(false);stop();
    };
    try{
      instance=new Worker(new URL('./analysis-worker.ts',import.meta.url),{type:'module'});worker.current=instance;
      instance.onmessage=({data}:MessageEvent<unknown>)=>{
        if(!current())return;
        if(record(data)&&data.kind==='exported'){receiveExport(data);return;}
        if(!awaitingAnalysis){
          const job=activeExport.current;
          if(job){stopExport(job);exportFailed(job,'后台返回了无效的导出回复，请重试');}
          return;
        }
        awaitingAnalysis=false;
        const parsed=AnalysisAttempt.safeParse(data);
        if(parsed.success)setCached({key,attempt:parsed.data});
        else setError('分析线程返回了无效结果');
        setBusy(false);
        if(!parsed.success||parsed.data.status!=='available')stop();
        else completed.current=true;
      };
      instance.onerror=onError;
      instance.onmessageerror=onError;
      instance.postMessage({kind:'analyze',scenario,assets} satisfies AnalysisWorkerRequest);
    }catch(e){stop();setBusy(false);setError(e instanceof Error?e.message:'分析失败');}
  }
  function cancel(){stop();setBusy(false);setError('分析已取消');}

  function exportFile(selection:AnalysisExportSelection){
    if(!result||activeExport.current)return;
    const {inputHash,engineVersion}=result,request:AnalysisExportRequest={kind:'export',taskId:++exportId.current,inputHash,engineVersion,selection};
    const job={owner:result,request},instance=worker.current;
    if(!instance){exportFailed(job,'分析线程已关闭，请重新计算后导出');return;}
    activeExport.current=job;
    setExportState({owner:result,selection,status:'running'});
    try{instance.postMessage(request);}
    catch{activeExport.current=undefined;exportFailed(job,'无法开始后台导出，请重试');}
  }
  function cancelExport(){
    const job=activeExport.current;
    if(!job)return;
    stopExport(job);
    setExportState({owner:job.owner,selection:job.request.selection,status:'cancelled'});
  }
  return {attempt,result,busy,error,previous:!!cached,run,cancel,exportFile,cancelExport,exportState:exportState?.owner===result?exportState:undefined};
}
