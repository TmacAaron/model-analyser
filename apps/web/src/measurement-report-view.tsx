import { useEffect,useRef,useState } from 'react';
import type { AnalysisResult,Scenario,AssetDocument,MeasurementRecord,MeasurementComparisonReport } from '@model-analyser/contracts';
import { stableStringify } from '@model-analyser/core';
import type { ComparedMeasurement } from './measurement-comparison-task.js';
import { createMeasurementReport,measurementReportCsv } from './measurement-report.js';

export function MeasurementComparisonExports({result,scenario,assets,records,items,offset,totalRecords,completion,error}:{result:AnalysisResult;scenario:Scenario;assets:AssetDocument[];records:MeasurementRecord[];items:ComparedMeasurement[];offset:number;totalRecords:number;completion:MeasurementComparisonReport['completion'];error?:string|undefined}){
  const [busy,setBusy]=useState(false),[problem,setProblem]=useState(''),owner=useRef({result,scenario,assets,recordsKey:stableStringify(records),offset});owner.current={result,scenario,assets,recordsKey:stableStringify(records),offset};
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function save(format:'json'|'csv'){
    const snapshot=owner.current;setBusy(true);setProblem('');
    try{
      const report=await createMeasurementReport({result,scenario,assets,records,items,offset,totalRecords,completion,error});
      const current=owner.current;if(!alive.current||current.result!==snapshot.result||current.scenario!==snapshot.scenario||current.assets!==snapshot.assets||current.recordsKey!==snapshot.recordsKey||current.offset!==snapshot.offset)throw Error('当前比较输入或记录页已变化，请导出新的当前页。');
      const text=format==='json'?JSON.stringify(report,null,2)+'\n':measurementReportCsv(report),url=URL.createObjectURL(new Blob([text],{type:format==='json'?'application/json':'text/csv;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download='measurement-comparison-page-'+(offset/20+1)+'.'+format;link.click();URL.revokeObjectURL(url);
    }catch(e){setProblem(e instanceof Error?e.message:'比较结果导出失败');}finally{setBusy(false);}
  }
  return <section className="measurement-comparison-exports" aria-label="当前页比较导出"><p>导出当前页 {offset+1}–{offset+records.length} / {totalRecords} 条；保留全部原始记录、已完成比较，以及未完成或不可用项。JSON包含复算所需配置与固定快照；CSV保留原始数值和单位。</p><button disabled={busy} onClick={()=>void save('json')}>导出当前页比较 JSON</button><button disabled={busy} onClick={()=>void save('csv')}>导出当前页比较 CSV</button>{problem&&<p role="alert">{problem}</p>}</section>;
}
