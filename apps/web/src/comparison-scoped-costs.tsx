import { useMemo,useState } from 'react';
import type { AnalysisResult,CostResult,MetricTarget,MetricValue,Quantity,ScenarioComparisonResult } from '@model-analyser/contracts';
import { stableStringify } from '@model-analyser/core';
import { parseTarget,sourceTargetId,targetCost,targetId,targetProblem,type AnalysisFocus } from './analysis-focus.js';
import { computeClassLabel,logicalTargetId } from './compute-source.js';
import { CostSourceInspector } from './cost-source-view.js';
import { useDisplayUnits } from './display-units.js';

type Entry=ScenarioComparisonResult['entries'][number];
type ScopedResult=
  |{entry:Entry;problem:string}
  |{entry:Entry;original:AnalysisResult;result:AnalysisResult;cost:CostResult;id:string;step:number|undefined;context:number|undefined};
type ScopedMetric={targetId:string;metricId:string;value:MetricValue};
type Row={id:string;label:string;unit:Quantity['unit'];metrics:(ScopedMetric|undefined)[]};
const fields=[
  ['seconds','理论跨度','second','seconds'],
  ['read','逻辑读取','byte','logicalReadBytes'],
  ['write','逻辑写入','byte','logicalWriteBytes'],
  ['hbm','估算 HBM 流量','byte','hbmBytes'],
] as const;

function selectCost(entry:Entry,target:MetricTarget,step:number|undefined,members:string[]):ScopedResult{
  if(entry.analysis.status!=='available')return {entry,problem:entry.analysis.diagnostics[0]?.message??'此配置无法计算'};
  const original=entry.analysis.result,call=original.decode?.steps.find(item=>item.index===step);
  if(step!==undefined&&!call)return {entry,problem:'此配置没有所选 Decode 步骤'};
  const result=call?.result??original;
  if(members.length&&target.kind==='node'){
    if(original.decode&&!call)return {entry,problem:'融合组的成本按实际 Decode 步骤查看'};
    const group=result.fusions?.find(f=>f.evaluation.application.nodeId===target.nodeId)?.evaluation.application;
    const actual=new Set<string>(group?.memberNodeIds);
    if(actual.size!==members.length||!members.every(id=>actual.has(id))){
      return {entry,problem:'此配置没有相同成员的融合组'};
    }
  }
  const problem=targetProblem(result,target,true),cost=targetCost(result,target);
  if(problem||!cost)return {entry,problem:problem??'此配置没有所选范围的成本'};
  return {entry,original,result,cost,id:sourceTargetId(result,target),step,context:call?.evaluatedContext};
}

const value=(metric:ScopedMetric|undefined)=>metric?.value.status==='available'?metric.value.quantity.value:undefined;
function difference(row:Row,results:ScopedResult[],index:number){
  const base=results[0],current=results[index],left=value(row.metrics[0]),right=value(row.metrics[index]);
  if(index===0||!base||!current||'problem'in base||'problem'in current||base.result.phase!==current.result.phase||left===undefined||right===undefined)return undefined;
  const delta=right-left;
  return Number.isFinite(delta)?delta:undefined;
}

function scopedRows(results:ScopedResult[],target:MetricTarget):Row[]{
  const rows:Row[]=fields.map(([id,label,unit,field])=>({id,label,unit,metrics:results.map(result=>'problem'in result?undefined:{
    targetId:result.id,metricId:id,value:result.cost[field],
  })}));
  for(const mode of ['useful','executed'] as const){
    const classes=new Map<string,Row>();
    for(const [entryIndex,result] of results.entries()){
      if('problem'in result)continue;
      const logical=result.result.decode?.logicalCompute??result.result.distributed?.logicalCompute;
      const selectedLogical=mode==='useful'?logical?.find(item=>targetId(item.scope.target)===targetId(target)):undefined;
      const segments=mode==='useful'&&logical?selectedLogical?.compute??[]:result.cost.compute;
      const id=selectedLogical?logicalTargetId(target):result.id;
      for(const [index,segment] of segments.entries()){
        const key=stableStringify(segment.computeClass);
        let row=classes.get(key);
        if(!row){
          row={id:mode+':'+key,label:(mode==='useful'?'有效工作 ':'物理执行 ')+computeClassLabel(segment.computeClass),unit:'operation',metrics:new Array<ScopedMetric|undefined>(results.length).fill(undefined)};
          classes.set(key,row);
        }
        // Reported leaf and aggregate costs already group by the complete class.
        row.metrics[entryIndex]={targetId:id,metricId:mode+':'+index,value:mode==='useful'?segment.usefulOperations:segment.executedOperations};
      }
    }
    rows.push(...classes.values());
  }
  return rows;
}

function asCsv(rows:Row[],results:ScopedResult[]){
  const lines:(string|number|undefined)[][]=[['metric','unit','scenarioId','phase','stepIndex','inputHash','targetId','value','deltaFromBaseline']];
  for(const row of rows)for(const [index,result] of results.entries()){
    const metric=row.metrics[index];
    lines.push([row.label,row.unit,result.entry.scenario.scenarioId,result.entry.scenario.workload.kind,
      'problem'in result?undefined:result.step,'problem'in result?undefined:result.result.inputHash,
      metric?.targetId,value(metric),difference(row,results,index)]);
  }
  return lines.map(line=>line.map(cell=>'"'+String(cell??'unavailable').replaceAll('"','""')+'"').join(',')).join('\r\n');
}

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

export function ComparisonScopedCosts({report,focus,onExportCsv}:{
  report:ScenarioComparisonResult;focus:AnalysisFocus;onExportCsv:(text:string)=>void;
}){
  const [step,setStep]=useState<number>();
  const [proof,setProof]=useState<{results:ScopedResult[];row:Row;index:number;delta:boolean}>();
  const display=useDisplayUnits();
  const id=focus.target?targetId(focus.target):'';
  const members=JSON.stringify(focus.fusionMembers??[]);
  const maxSteps=Math.max(0,...report.entries.map(({analysis})=>analysis.status==='available'?analysis.result.decode?.steps.length??0:0));
  const {results,rows}=useMemo(()=>{
    const target=parseTarget(id);
    if(!target||focus.reason)return {results:[],rows:[]};
    const fusionMembers=JSON.parse(members) as string[];
    const results=report.entries.map(entry=>selectCost(entry,target,step,fusionMembers));
    return {results,rows:scopedRows(results,target)};
  },[report,id,members,step,focus.reason]);
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
      <button onClick={()=>onExportCsv(asCsv(rows,results))}>导出所选范围 CSV</button>
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
