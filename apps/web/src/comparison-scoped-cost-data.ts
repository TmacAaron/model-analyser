import type { AnalysisResult,CostResult,MetricTarget,MetricValue,Quantity,ScenarioComparisonResult } from '@model-analyser/contracts';
import { stableStringify } from '@model-analyser/core';
import { sourceTargetId,targetCost,targetId,targetProblem } from './analysis-focus.js';
import { computeClassLabel,logicalTargetId } from './compute-source.js';

export type ScopedComparisonRequest={target:MetricTarget;decodeStep?:number|undefined;fusionMembers?:readonly string[]|undefined};

type Entry=ScenarioComparisonResult['entries'][number];
export type ScopedResult=
  |{entry:Entry;problem:string}
  |{entry:Entry;original:AnalysisResult;result:AnalysisResult;cost:CostResult;id:string;step:number|undefined;context:number|undefined};
export type ScopedMetric={targetId:string;metricId:string;value:MetricValue};
export type ScopedCostRow={id:string;label:string;unit:Quantity['unit'];metrics:(ScopedMetric|undefined)[]};
const fields=[
  ['seconds','理论跨度','second','seconds'],
  ['read','逻辑读取','byte','logicalReadBytes'],
  ['write','逻辑写入','byte','logicalWriteBytes'],
  ['hbm','估算 HBM 流量','byte','hbmBytes'],
] as const;

function selectCost(entry:Entry,target:MetricTarget,step:number|undefined,members:readonly string[]):ScopedResult{
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

export const scopedCostValue=(metric:ScopedMetric|undefined)=>metric?.value.status==='available'?metric.value.quantity.value:undefined;
export function scopedCostDifference(row:ScopedCostRow,results:ScopedResult[],index:number){
  const base=results[0],current=results[index],left=scopedCostValue(row.metrics[0]),right=scopedCostValue(row.metrics[index]);
  if(index===0||!base||!current||'problem'in base||'problem'in current||base.result.phase!==current.result.phase||left===undefined||right===undefined)return undefined;
  const delta=right-left;
  return Number.isFinite(delta)?delta:undefined;
}

function scopedRows(results:ScopedResult[],target:MetricTarget):ScopedCostRow[]{
  const rows:ScopedCostRow[]=fields.map(([id,label,unit,field])=>({id,label,unit,metrics:results.map(result=>'problem'in result?undefined:{
    targetId:result.id,metricId:id,value:result.cost[field],
  })}));
  for(const mode of ['useful','executed'] as const){
    const classes=new Map<string,ScopedCostRow>();
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

function asCsv(rows:ScopedCostRow[],results:ScopedResult[]){
  const lines:(string|number|undefined)[][]=[['metric','unit','scenarioId','phase','stepIndex','inputHash','targetId','value','deltaFromBaseline']];
  for(const row of rows)for(const [index,result] of results.entries()){
    const metric=row.metrics[index];
    lines.push([row.label,row.unit,result.entry.scenario.scenarioId,result.entry.scenario.workload.kind,
      'problem'in result?undefined:result.step,'problem'in result?undefined:result.result.inputHash,
      metric?.targetId,scopedCostValue(metric),scopedCostDifference(row,results,index)]);
  }
  return lines.map(line=>line.map(cell=>'"'+String(cell??'unavailable').replaceAll('"','""')+'"').join(',')).join('\r\n');
}

export function readScopedComparison(report:ScenarioComparisonResult,{target,decodeStep,fusionMembers=[]}:ScopedComparisonRequest){
  const results=report.entries.map(entry=>selectCost(entry,target,decodeStep,fusionMembers));
  return {results,rows:scopedRows(results,target)};
}

export function scopedComparisonCsv(report:ScenarioComparisonResult,request:ScopedComparisonRequest){
  const {rows,results}=readScopedComparison(report,request);
  return asCsv(rows,results);
}
