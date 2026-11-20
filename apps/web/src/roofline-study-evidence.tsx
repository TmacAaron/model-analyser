import { useMemo,useState } from 'react';
import type { CapacitySearchPoint,RooflineBalance,RooflineObservation,RooflineStudyResult,RooflineStudySample,RooflineStudyTransition } from '@model-analyser/contracts';
import type { RooflineField } from './roofline-source.js';
import { ScalarButton } from './scalar-source.js';
import { StudyEvidenceDetails,StudyEvidencePager } from './study-evidence.js';

const formatter=new Intl.NumberFormat('en-US',{maximumFractionDigits:4});
const samplePageSize=20;
export const rooflineSeriesPageSize=10;
export const rooflineNumber=(value:number)=>value!==0&&(Math.abs(value)<.0001||Math.abs(value)>=1e12)?value.toExponential(4):formatter.format(value);
export const rooflineSide=(balance:RooflineBalance)=>balance.status==='available'?balance.side==='compute'?'计算侧':balance.side==='memory'?'带宽侧':'平衡点':'不可用';

export function rooflineSeriesLabel(observation:RooflineObservation){
  const c=observation.point.computeClass;
  return observation.point.scope.deviceIds.join(',')+' · '+c.resource+(c.resourceKey?' '+c.resourceKey:'')+' '+c.multiplyDtype.format+'/'+c.accumulateDtype.format+' ['+c.inputDtypes.map(d=>d.format).join(',')+']';
}

function fit(point:CapacitySearchPoint|undefined){
  return point?.status==='available'?point.fit==='fits'?'可容纳':point.fit==='exceeds'?'超容量':'缺项':'未计算';
}

export function RooflineTransitionEvidence({transition,title}:{transition:RooflineStudyTransition;title:string}){
  const [page,setPage]=useState(0);
  const {events,expectedPoints,knownPoints,roof}=transition;
  const visible=events.slice(page*samplePageSize,(page+1)*samplePageSize);
  const eventRows=()=> <>
    {visible.map(event=><p key={event.kind+':'+event.lower+':'+event.upper}>
      {event.kind==='balanced_samples'?'平衡采样点':'相邻整数限制侧改变区间'} [{event.lower}, {event.upper}]
    </p>)}
    <StudyEvidencePager label="拐点区间" page={page} size={samplePageSize} total={events.length} onChange={setPage}/>
  </>;
  return <div className="roofline-transition">
    <strong>{title} · {roof==='effective'?'有效屋顶':'硬件声明屋顶'}</strong>
    <p>可用限制侧 {knownPoints}/{expectedPoints}点{knownPoints<expectedPoints?' · 缺项或未完成，不覆盖全区间':''}</p>
    {events.length===0?<p>已知整数点未发现平衡或相邻限制侧改变；不推断连续区间或范围外拐点。</p>:
      events.length>samplePageSize?<StudyEvidenceDetails summary={events.length+' 个拐点区间'} render={eventRows}/>:eventRows()}
  </div>;
}

export type ShowRooflineSource=(observation:RooflineObservation,field:RooflineField,sample?:RooflineStudySample)=>void;

export function RooflineSampleTable({report,seriesIds,showSource}:{report:RooflineStudyResult;seriesIds:ReadonlySet<string>;showSource:ShowRooflineSource}){
  const [page,setPage]=useState(0);
  const {samples,scan}=report;
  const capacity=useMemo(()=>new Map(scan?.status==='available'?scan.result.points.map(point=>[point.value,point] as const):[]),[scan]);
  const visible=samples.slice(page*samplePageSize,(page+1)*samplePageSize);
  return <>
    <StudyEvidencePager label="整数样本" page={page} size={samplePageSize} total={samples.length} onChange={setPage}/>
    <div className="analysis-table"><table>
      <thead><tr><th>整数 / input hash</th><th>容量判定</th><th>强度与有效屋顶侧</th><th>硬件声明屋顶侧</th><th>证据</th></tr></thead>
      <tbody>{visible.map(sample=>{
        const observations=sample.observations.filter(observation=>seriesIds.has(observation.seriesId));
        return <tr key={sample.value}>
          <td>{sample.value}<small>{sample.inputHash?.slice(0,12)??'分析失败'}{sample.evaluatedContext!==undefined?' · context '+sample.evaluatedContext:''}</small></td>
          <td>{fit(sample.value===undefined?undefined:capacity.get(sample.value))}</td>
          <td>{observations.map(observation=><div key={observation.seriesId}>{rooflineSeriesLabel(observation)} · {' '}
            <ScalarButton label={'样本 '+sample.value+' 运算强度'} onClick={()=>showSource(observation,'intensity',sample)}>
              {observation.point.arithmeticIntensity.status==='available'?rooflineNumber(observation.point.arithmeticIntensity.operationsPerByte)+' op/B':'强度不可用'}
            </ScalarButton> · {' '}
            <ScalarButton label={'样本 '+sample.value+' 有效屋顶侧依据'} onClick={()=>showSource(observation,'effective-ridge',sample)}>{rooflineSide(observation.effectiveBalance)}</ScalarButton>
          </div>)}</td>
          <td>{observations.map(observation=><div key={observation.seriesId}>
            <ScalarButton label={'样本 '+sample.value+' 硬件屋顶侧依据'} onClick={()=>showSource(observation,'hardware-ridge',sample)}>{rooflineSide(observation.hardwareBalance)}</ScalarButton>
          </div>)}</td>
          <td><StudyEvidenceDetails summary={sample.diagnostics.length+'诊断 · 原始指标'} render={()=><pre>{JSON.stringify(sample,null,2)}</pre>}/></td>
        </tr>;
      })}</tbody>
    </table></div>
  </>;
}
