import { useMemo,useState } from 'react';
import type { ScenarioComparisonResult } from '@model-analyser/contracts';
import { parseTarget,targetId,type AnalysisFocus } from './analysis-focus.js';
import { computeClassLabel } from './compute-source.js';
import { useDisplayUnits } from './display-units.js';
import { rooflineObservationEvidence } from './roofline-source.js';
import { scalarDisplay,ScalarButton,ScalarSourcePanel,useScalarSource } from './scalar-source.js';
import { readRooflineComparison,rooflineFields as fields,rooflineEvidenceValue as evidenceValue,rooflineDifference as difference,type RooflineComparisonRequest } from './comparison-roofline-data.js';

function RooflineResults({report,focus,exporting,onExport}:{report:ScenarioComparisonResult;focus:AnalysisFocus|undefined;exporting:boolean;onExport:(request:RooflineComparisonRequest)=>void}){
  const [modelScope,setModelScope]=useState(false);
  const [stepText,setStepText]=useState('1');
  const [fieldId,setFieldId]=useState<string>('intensity');
  const [limit,setLimit]=useState(20);
  const display=useDisplayUnits();
  const followCanvas=!!focus&&!modelScope;
  const scopeId=followCanvas?(focus.target?targetId(focus.target):''):'model';
  const scopeLabel=followCanvas?focus.label:'整个模型';
  const scopeProblem=followCanvas?focus.reason:undefined;
  const maxSteps=Math.max(0,...report.entries.map(e=>e.analysis.status==='available'?e.analysis.result.decode?.steps.length??0:0));
  const stepIndex=Number(stepText)-1;
  const stepValid=Number.isSafeInteger(stepIndex)&&stepIndex>=0&&stepIndex<maxSteps;
  const {entries,points}=useMemo(()=>{
    const target=parseTarget(scopeId);
    if(!target||scopeProblem||maxSteps>0&&!stepValid)return {entries:[],points:[]};
    return readRooflineComparison(report,target,maxSteps>0?stepIndex:undefined);
  },[report,scopeId,scopeProblem,maxSteps,stepValid,stepIndex]);
  const field=fields.find(f=>f.id===fieldId)??fields[0];
  const source=useScalarSource(useMemo(()=>({entries,field}),[entries,field]));

  function exportResults(){
    const target=parseTarget(scopeId);
    if(target)onExport({target,fieldId:field.id,...(maxSteps>0?{decodeStep:stepIndex}:{})});
  }
  return <div>
    {focus&&focus.target?.kind!=='model'&&<label>对比范围<select aria-label="Roofline 对比范围" value={modelScope?'model':'canvas'} onChange={e=>{setModelScope(e.target.value==='model');setLimit(20);}}>
      <option value="canvas">画布 · {focus.label}</option><option value="model">整个模型</option>
    </select></label>}
    {maxSteps>0&&<label>Roofline 对比 Decode 步骤<input type="number" min={1} max={maxSteps} value={stepText} onChange={e=>{setStepText(e.target.value);setLimit(20);}}/></label>}
    {scopeProblem&&<p role="status">{scopeProblem}</p>}
    {maxSteps>0&&!stepValid&&<p role="status">请选择 1 至 {maxSteps} 之间的整数步骤。</p>}
    {entries.length>0&&<>
      <p className="scope-note">{scopeLabel} · 同推理阶段、设备范围、计算类别和流量口径的结果可计算差值。池化屋顶可能掩盖局部瓶颈。</p>
      <label>Roofline 对比指标<select aria-label="Roofline 对比指标" value={field.id} onChange={e=>setFieldId(e.target.value)}>{fields.map(f=><option key={f.id} value={f.id}>{f.label}</option>)}</select></label>
      <button disabled={exporting} onClick={exportResults}>导出 Roofline 对比 JSON</button>
      {entries.filter(e=>!e.sample.observations.length).map(({scenario,sample,problem})=><p key={scenario.scenarioId}>{scenario.name} · {problem??sample.diagnostics.find(d=>d.code==='invalid_decode_step'||d.code==='missing_roofline_target')?.message??'此范围没有可用 Roofline 点。'}</p>)}
      {points.length>0&&<div className="analysis-table"><table aria-label="Roofline 配置对比">
        <thead><tr><th scope="col">物理范围／精度</th>{entries.map(({scenario,sample},index)=><th key={scenario.scenarioId} scope="col">
          {scenario.name}{index===0?' · 基准':''}
          {sample.evaluatedContext!==undefined&&<small>步骤 {stepIndex+1} · context {sample.evaluatedContext}</small>}
          <small>{(sample.stepInputHash??sample.inputHash)?.slice(0,12)}</small>
        </th>)}</tr></thead>
        <tbody>{points.slice(0,limit).map(([key,{point}])=>{
          const baseline=entries[0]?.bySeries.get(key);
          const base=baseline?evidenceValue(rooflineObservationEvidence(baseline,field.id)):undefined;
          return <tr key={key}><th scope="row">{computeClassLabel(point.computeClass)}<small>
            {point.scope.phase} · {point.scope.deviceIds.join(', ')} · {point.scope.aggregation} · {point.trafficBasis==='logical'?'逻辑流量':'估算 HBM'}
          </small></th>{entries.map(({scenario,frame,sample,bySeries},index)=>{
            const observation=bySeries.get(key);
            const evidence=observation?rooflineObservationEvidence(observation,field.id):undefined;
            const value=evidenceValue(evidence);
            const delta=index>0?difference(value,base):undefined;
            return <td key={scenario.scenarioId}>
              {frame&&evidence?<ScalarButton label={scenario.name+' Roofline '+field.label} onClick={()=>source.select({...evidence,label:'Roofline '+field.label},{
                assets:report.assets,
                parameters:frame.parameterTrace,
                diagnostics:sample.diagnostics,
                inputHash:frame.inputHash,
                scope:scenario.name+' · '+scopeLabel+(sample.evaluatedContext===undefined?'':' · 步骤 '+(stepIndex+1)+' · context '+sample.evaluatedContext),
                stepContext:frame.stepContext,
              })}>{scalarDisplay(value,field.unit,display)}</ScalarButton>:observation===null?'范围身份不唯一':'—'}
              {delta!==undefined&&<small>Δ {Number.isFinite(delta)?(delta>0?'+':'')+scalarDisplay(delta,field.unit,display):'超出有限数值范围'}</small>}
            </td>;
          })}</tr>;
        })}</tbody>
      </table></div>}
      {points.length>limit&&<button onClick={()=>setLimit(n=>n+20)}>再显示 20 个 Roofline 分类</button>}
    </>}
    {source.selection&&<ScalarSourcePanel selection={source.selection} onClose={source.close}/>}
  </div>;
}

export function ComparisonRoofline({report,focus,exporting,onExport}:{report:ScenarioComparisonResult;focus?:AnalysisFocus|undefined;exporting:boolean;onExport:(request:RooflineComparisonRequest)=>void}){
  const [open,setOpen]=useState(false);
  return <details onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>Roofline 对比</summary>
    {open&&<RooflineResults report={report} focus={focus} exporting={exporting} onExport={onExport}/>}
  </details>;
}
