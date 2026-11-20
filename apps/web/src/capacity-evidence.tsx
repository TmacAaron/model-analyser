import { useEffect,useRef,useState } from 'react';
import type { CapacitySearchPoint,CapacitySearchResult } from '@model-analyser/contracts';
import type { CapacitySourceTarget } from './capacity-source-view.js';
import { useDisplayUnits } from './display-units.js';
import { ScalarButton } from './scalar-source.js';
import { StudyEvidenceDetails,StudyEvidencePager } from './study-evidence.js';

const pointPageSize=40;
const devicePageSize=12;
type AvailablePoint=Extract<CapacitySearchPoint,{status:'available'}>;
type ShowPoint=(pointValue:number,field:CapacitySourceTarget['field'])=>void;

function PointDevices({point,showPoint}:{point:AvailablePoint;showPoint:ShowPoint}){
  const [page,setPage]=useState(0),display=useDisplayUnits();
  const {memory,value}=point;
  return <>
    {memory.slice(page*devicePageSize,(page+1)*devicePageSize).map(device=><div key={device.deviceId}>{device.deviceId}: {' '}
      <ScalarButton label={`整数 ${value} ${device.deviceId} 峰值`} onClick={()=>showPoint(value,{kind:'peak',deviceId:device.deviceId})}>{display.metric(device.peakBytes)}</ScalarButton> / {' '}
      <ScalarButton label={`整数 ${value} ${device.deviceId} 容量`} onClick={()=>showPoint(value,{kind:'capacity',deviceId:device.deviceId})}>{display.bytes(device.capacityBytes)}</ScalarButton>
    </div>)}
    <StudyEvidencePager label="设备" page={page} size={devicePageSize} total={memory.length} onChange={setPage}/>
  </>;
}

export function CapacityEvidence({report,onSource}:{report:CapacitySearchResult;onSource:(target:CapacitySourceTarget)=>void}){
  const [page,setPage]=useState(0),[lookup,setLookup]=useState('');
  const [current,setCurrent]=useState<AvailablePoint['value']>();
  const locatedRow=useRef<HTMLTableRowElement|null>(null);
  const display=useDisplayUnits();
  const {points}=report;
  const index=lookup.trim()?points.findIndex(point=>point.value===Number(lookup)):-1;
  const visible=points.slice(page*pointPageSize,(page+1)*pointPageSize);
  const showPoint:ShowPoint=(pointValue,field)=>onSource({report,pointValue,field});
  useEffect(()=>{locatedRow.current?.focus();},[current,page]);
  return <>
    {points.length>pointPageSize&&<form className="capacity-form" onSubmit={event=>{
      event.preventDefault();
      const target=points[index];
      if(!target)return;
      setCurrent(target.value);
      setPage(Math.floor(index/pointPageSize));
      if(target.value===current)locatedRow.current?.focus();
    }}>
      <label>定位整数<input type="number" step="1" aria-label="定位容量整数" value={lookup} onChange={event=>setLookup(event.target.value)}/></label>
      <button type="submit" disabled={index<0}>定位容量样本</button>
      {lookup.trim()&&index<0&&<small>没有已计算的整数样本</small>}
    </form>}
    <StudyEvidencePager label="容量样本" page={page} size={pointPageSize} total={points.length} onChange={next=>{setCurrent(undefined);setPage(next);}}/>
    <div className="analysis-table capacity-table"><table>
      <thead><tr><th>变量值</th><th>容量判定</th><th>设备峰值 / 容量</th><th>理论耗时</th><th>证据</th></tr></thead>
      <tbody>{visible.map(point=><tr key={point.value} ref={point.value===current?locatedRow:undefined} tabIndex={point.value===current?-1:undefined} aria-current={point.value===current?'true':undefined}>
        <td>{point.value}</td>
        <td>{point.status==='unavailable'?'不可计算':point.fit==='fits'?'可容纳':point.fit==='exceeds'?'超容量':'缺项'}</td>
        <td>{point.status==='available'?<PointDevices point={point} showPoint={showPoint}/>:'不可计算'}</td>
        <td><ScalarButton label={`整数 ${point.value} 理论耗时`} onClick={()=>showPoint(point.value,{kind:'seconds'})}>
          {point.status==='available'?display.metric(point.seconds):'不可用'}
        </ScalarButton></td>
        <td><StudyEvidenceDetails summary={`${point.status==='available'?point.inputHash.slice(0,8)+'…':'计算错误'} · ${point.diagnostics.length} 诊断`}
          render={()=>point.diagnostics.map(diagnostic=><p key={diagnostic.diagnosticId}>{diagnostic.code} · {diagnostic.message}</p>)}/></td>
      </tr>)}</tbody>
    </table></div>
    <StudyEvidenceDetails summary="固定输入快照" render={()=> <pre>{JSON.stringify(report.baseScenario,null,2)}</pre>}/>
  </>;
}
