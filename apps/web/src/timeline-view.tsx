import { useEffect,useState } from 'react';
import type { AnalysisResult } from '@model-analyser/contracts';
import type { AnalysisFocus } from './analysis-focus.js';
import { useDisplayUnits } from './display-units.js';
import { TimelineSelectionControls,useTimelineSelection } from './timeline-selection-view.js';
export function Timeline({result,focus}:{result:AnalysisResult;focus?:AnalysisFocus|undefined}){
  const display=useDisplayUnits(),selection=useTimelineSelection(result,focus);
  const [limit,setLimit]=useState(60);useEffect(()=>setLimit(60),[result,focus?.key,selection.mode]);
  const filtered=result.schedule.filter(e=>selection.includes(e.nodeId,e.decodeStepIndex)),entries=filtered.slice(0,limit),max=result.schedule.reduce((m,e)=>Math.max(m,e.endSeconds),0),height=Math.max(80,35+entries.length*28);
  return <section className="theory-timeline"><h3>串行理论时间线</h3><TimelineSelectionControls selection={selection}/><div className="analysis-timeline"><svg role="img" aria-label="串行理论时间线" width="650" height={height} viewBox={`0 0 650 ${height}`}>{entries.map((e,i)=><g key={e.nodeId+':'+e.decodeStepIndex+':'+i} data-timeline-node={e.nodeId} data-decode-step={e.decodeStepIndex}><title>{e.decodeStepIndex!==undefined?'step '+e.decodeStepIndex+' · ':''}{e.nodeId}: {display.seconds(e.startSeconds)}–{display.seconds(e.endSeconds)}</title><text x="4" y={i*28+29} fontSize="10" fill="#708675">{e.nodeId.slice(-24)}</text><rect x={160+e.startSeconds/(max||1)*370} y={i*28+15} width={Math.max(2,(e.endSeconds-e.startSeconds)/(max||1)*370)} height="17" rx="3" fill="#72a084"/><text x="540" y={i*28+29} fontSize="9" fill="#708675">{display.seconds(e.endSeconds)}</text></g>)}<text x="530" y={height-4} textAnchor="end" fontSize="10" fill="#708675">{display.seconds(max)}</text></svg></div><p className="scope-note">显示 {entries.length}/{filtered.length} 个范围内时间条目；完整模型 {result.schedule.length} 项。横轴覆盖全部已知时刻。耗时缺失后的时刻不生成。零耗时以最小标记显示。{entries.length<filtered.length&&<button onClick={()=>setLimit(n=>n+60)}>再显示 60 个时间条目</button>}{limit>60&&<button onClick={()=>setLimit(60)}>收起时间条目</button>}</p></section>;
}
