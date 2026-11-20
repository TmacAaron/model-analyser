import { useState } from 'react';
import type { AnalysisResult } from '@model-analyser/contracts';
import { computeClassLabel,modelComputeFrame } from './compute-source.js';
import { useDisplayUnits } from './display-units.js';

export function ModelComputeSummary({result,onSource}:{result:AnalysisResult;onSource:(targetId:string,metricId:string)=>void}){
  const display=useDisplayUnits(),frame=modelComputeFrame(result),[limit,setLimit]=useState(12),label=result.decode?'整个序列有效工作量':result.distributed?'模型一次有效工作量':'有效工作量',only=frame.compute.length===1?frame.compute[0]:undefined;
  return <div className="metric-card model-compute-summary">{only?<button className="metric-source-button" aria-label={'查看'+label+'来源'} onClick={()=>onSource(frame.targetId,'useful:0')}><span>{label}</span><strong>{display.metric(only.usefulOperations)}</strong>{only.usefulOperations.status==='available'&&<small>{only.usefulOperations.basis} · 原始单位 {only.usefulOperations.quantity.unit}</small>}{only.usefulOperations.status==='unavailable'&&<small>缺项未补零</small>}</button>:<><span>{label}</span><strong>{frame.compute.length?frame.compute.length+' 个计算分类':'无声明计算段'}</strong><p className="scope-note">不同计算精度逐类查看，不将分类数量当作运算量。</p>{frame.compute.slice(0,limit).map((segment,index)=><button className="metric-source-button compute-class-source" key={index} aria-label={'查看有效工作分类 '+(index+1)+' 来源'} onClick={()=>onSource(frame.targetId,'useful:'+index)}><span>{computeClassLabel(segment.computeClass)}</span><strong>{display.metric(segment.usefulOperations)}</strong></button>)}{frame.compute.length>limit&&<button onClick={()=>setLimit(n=>n+12)}>再显示 12 个计算分类</button>}</>}</div>;
}
