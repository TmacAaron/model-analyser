import { useMemo,useState } from 'react';
import type { AnalysisResult } from '@model-analyser/contracts';
import { focusIdentity,type AnalysisFocus } from './analysis-focus.js';
import { timelineContext,inTimelineContext } from './timeline-context.js';
export function useTimelineSelection(result:AnalysisResult|undefined,focus:AnalysisFocus|undefined){
  const identity=focusIdentity(focus),context=useMemo(()=>timelineContext(result,focus),[result,identity]);
  const [choice,setChoice]=useState<{identity:string;mode:'all'|'selected'}>();
  const mode=choice?.identity===identity?choice.mode:context.all?'all':'selected';
  return {context,mode,setMode:(mode:'all'|'selected')=>setChoice({identity,mode}),includes:(nodeId:string,step?:number)=>mode==='all'||inTimelineContext(context,nodeId,step)};
}
export function TimelineSelectionControls({selection}:{selection:ReturnType<typeof useTimelineSelection>}){
  return <div className="timeline-selection"><label>时间线范围<select aria-label="时间线范围" value={selection.mode} onChange={e=>selection.setMode(e.target.value==='selected'?'selected':'all')}><option value="all">全部执行条目</option><option value="selected">画布选择 · {selection.context.label}</option></select></label>
    {selection.mode==='selected'&&<><p className="scope-note">仅筛选实际执行条目；保留全模型的绝对时刻、横轴和执行顺序。全局耗时、资源占比和每卡峰值仍为完整模型口径。方案额外插入的模型层通信不自动归属模块。</p>{selection.context.reason&&<p role="status">{selection.context.reason}</p>}{selection.context.atomic&&<p role="status">所选范围涉及融合内部步骤，展示整个融合执行单元；不拆分其耗时。</p>}</>}
  </div>;
}
