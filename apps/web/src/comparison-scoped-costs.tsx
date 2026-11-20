import { useMemo,useState } from 'react';
import type { CostResult,ScenarioComparisonResult } from '@model-analyser/contracts';
import { parseTarget,targetId,type AnalysisFocus } from './analysis-focus.js';
import { CostSourceInspector } from './cost-source-view.js';
import { useDisplayUnits } from './display-units.js';
import { readScopedComparison,scopedCostDifference as difference,scopedCostValue as value,type ScopedComparisonRequest,type ScopedCostRow as Row,type ScopedMetric,type ScopedResult } from './comparison-scoped-cost-data.js';

function ScopeProof({result,metric,assets,amount}:{
  result:Extract<ScopedResult,{cost:CostResult}>;metric:ScopedMetric;assets:ScenarioComparisonResult['assets'];amount:string;
}){
  const selection=useMemo(()=>({
    targetId:metric.targetId,metricId:metric.metricId,nonce:0,...(result.step===undefined?{}:{step:result.step}),
  }),[metric,result.step]);
  return <article>
    <h5>{result.entry.scenario.name} · {amount}</h5>
    <p>实际输入 <code>{result.result.inputHash}</code></p>
    <CostSourceInspector result={result.original} scenario={result.entry.scenario} assets={assets} selection={selection}/>
  </article>;
}

export function ComparisonScopedCosts({report,focus,exporting,onExport}:{
  report:ScenarioComparisonResult;focus:AnalysisFocus;exporting:boolean;onExport:(request:ScopedComparisonRequest)=>void;
}){
  const [step,setStep]=useState<number>();
  const [proof,setProof]=useState<{results:ScopedResult[];row:Row;index:number;delta:boolean}>();
  const display=useDisplayUnits();
  const id=focus.target?targetId(focus.target):'';
  const members=JSON.stringify(focus.fusionMembers??[]);
  const maxSteps=Math.max(0,...report.entries.map(({analysis})=>analysis.status==='available'?analysis.result.decode?.steps.length??0:0));
  const request=useMemo(()=>{
    const target=parseTarget(id);
    if(!target||focus.reason)return undefined;
    return {target,decodeStep:step,fusionMembers:JSON.parse(members) as string[]};
  },[id,members,step,focus.reason]);
  const {results,rows}=useMemo(()=>request?readScopedComparison(report,request):{results:[],rows:[]},[report,request]);
  const selected=proof?.results===results?proof:undefined;
  const unit=(n:number|undefined,row:Row)=>n===undefined?'不可用':display.quantity(n,row.unit);
  const signed=(n:number,row:Row)=>(n>0?'+':'')+unit(n,row);

  return <section className="comparison-scoped-costs" aria-label="画布所选范围成本">
    <h3>所选范围成本 · {focus.label}</h3>
    {focus.reason&&<p role="status">{focus.reason}</p>}
    {maxSteps>0&&<label>Decode 成本范围<select aria-label="成本对比 Decode 步骤" value={step??'sequence'} onChange={e=>setStep(e.target.value==='sequence'?undefined:Number(e.target.value))}>
      <option value="sequence">整个 Decode 序列</option>
      {Array.from({length:maxSteps},(_,i)=><option key={i} value={i}>步骤 {i+1}</option>)}
    </select></label>}
    {rows.length>0&&<>
      <p className="scope-note">差值为当前配置减基准。仅在两侧属于同一推理阶段且指标可用时显示。</p>
      <button disabled={exporting} onClick={()=>{if(request)onExport(request);}}>导出所选范围 CSV</button>
      <div className="analysis-table"><table aria-label="所选范围成本对比">
        <thead><tr><th scope="col">指标</th>{results.map((result,index)=><th scope="col" key={result.entry.scenario.scenarioId}>
          {result.entry.scenario.name}{index===0?' · 基准':''}
          {'problem'in result?<small>{result.problem}</small>:<small>
            {result.result.phase} · {result.context!==undefined?'context '+result.context+' · ':result.result.decode?result.result.decode.steps.length+' 步 · ':''}
            {result.cost.scope.deviceIds.join(', ')} · {result.cost.scope.aggregation}
          </small>}
        </th>)}</tr></thead>
        <tbody>{rows.map(row=><tr key={row.id}><th scope="row">{row.label}<small>{row.unit}</small></th>{results.map((result,index)=>{
          const metric=row.metrics[index],delta=difference(row,results,index),label=row.label+' · '+result.entry.scenario.name;
          return <td key={result.entry.scenario.scenarioId}>{metric?<button className="comparison-value-button" aria-label={'查看所选范围 '+label+' 依据'} onClick={()=>setProof({results,row,index,delta:false})}>{unit(value(metric),row)}</button>:'—'}
            {delta!==undefined&&<small><button className="comparison-value-button" aria-label={'查看所选范围 '+label+' 差值依据'} onClick={()=>setProof({results,row,index,delta:true})}>Δ {signed(delta,row)}</button></small>}
          </td>;
        })}</tr>)}</tbody>
      </table></div>
    </>}
    {selected&&<section className="comparison-metric-source" aria-label="所选范围成本来源">
      <div className="panel-title"><h4>{selected.row.label} · {selected.delta?'差值依据':'指标依据'}</h4><button onClick={()=>setProof(undefined)}>关闭所选范围成本来源</button></div>
      {selected.delta&&<p>Δ = {unit(value(selected.row.metrics[selected.index]),selected.row)} − {unit(value(selected.row.metrics[0]),selected.row)}</p>}
      {(selected.delta?[0,selected.index]:[selected.index]).map(index=>{
        const result=results[index],metric=selected.row.metrics[index];
        if(!result||'problem'in result||!metric)return null;
        return <ScopeProof key={selected.row.id+':'+index} result={result} metric={metric} assets={report.assets} amount={unit(value(metric),selected.row)}/>;
      })}
    </section>}
  </section>;
}
