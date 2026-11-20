import { useEffect,useRef,useState } from 'react';
import type { AnalysisResult,AssetDocument,MeasurementRecord,Scenario } from '@model-analyser/contracts';
import { acceptComparisonMessage,type ComparedMeasurement,type MeasurementComparisonRequest } from './measurement-comparison-task.js';

type Status='idle'|'running'|'complete'|'cancelled'|'error';
type Snapshot={key:string;result:AnalysisResult|null;run:number;status:Status;items:ComparedMeasurement[];error?:string};
export function useMeasurementComparisons(scenario:Scenario,assets:AssetDocument[],result:AnalysisResult|null,records:MeasurementRecord[],key:string){
  const [snapshot,setSnapshot]=useState<Snapshot>(),[run,setRun]=useState(0),active=useRef<Worker|null>(null),latest=useRef({key,result,run});latest.current={key,result,run};
  useEffect(()=>{
    if(!result||!records.length)return;
    let instance:Worker|undefined,items:ComparedMeasurement[]=[];
    const ids=records.map(record=>record.measurementId),current=()=>active.current===instance&&latest.current.key===key&&latest.current.result===result&&latest.current.run===run;
    const finish=()=>{instance?.terminate();if(active.current===instance)active.current=null;};
    const fail=(error:string)=>{setSnapshot({key,result,run,status:'error',items,error});finish();};
    setSnapshot({key,result,run,status:'running',items});
    try{
      instance=new Worker(new URL('./measurement-comparison-worker.ts',import.meta.url),{type:'module'});active.current=instance;
      instance.onmessage=(event:MessageEvent<unknown>)=>{if(!current())return;try{const next=acceptComparisonMessage(ids,items,event.data);items=next.items;setSnapshot({key,result,run,status:next.complete?'complete':'running',items});if(next.complete)finish();}catch(error){fail(error instanceof Error?error.message:'测量比较结果无效');}};
      instance.onerror=()=>{if(current())fail('测量比较线程失败，请重试');};
      const request:MeasurementComparisonRequest={scenario,assets,result,records};instance.postMessage(request);
    }catch{fail('无法启动测量比较，请重试');}
    return finish;
  },[key,result,run]);
  const current=snapshot?.key===key&&snapshot.result===result&&snapshot.run===run?snapshot:undefined;
  const status:Status=!result||!records.length?'idle':current?.status??'running';
  return {status,items:status==='idle'?[]:current?.items??[],error:current?.error,total:records.length,
    cancel:()=>{active.current?.terminate();active.current=null;setSnapshot({key,result,run,status:'cancelled',items:current?.items??[]});},
    retry:()=>setRun(value=>value+1)};
}
