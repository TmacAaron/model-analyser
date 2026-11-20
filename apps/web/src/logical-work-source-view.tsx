import {useMemo,useState} from 'react';
import type {AnalysisResult,AssetDocument,MetricValue,Scenario} from '@model-analyser/contracts';
import type {LogicalWorkSelector,LogicalWorkSourceMember,LogicalWorkSourceReport,LogicalWorkSourceRequest} from '@model-analyser/core';
import {canonical} from '../../../packages/contracts/src/validation.js';
import {computeClassLabel} from './compute-source.js';
import {FormulaProof} from './declaration-source-view.js';
import {ParameterBindingProof} from './parameter-binding-view.js';
import {readLogicalWorkSourceReply} from './logical-work-source-task.js';
import {useCostSourceWorker} from './use-cost-source-worker.js';

const operations={step_sum:'按实际 Decode 步骤累加',member_sum:'按数学步骤累加',segment_sum:'按原始计算段累加'};

function save(report:LogicalWorkSourceReport){
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
 const link=document.createElement('a');
 link.href=url;link.download=`model-analyser-logical-source-page-${report.page+1}.json`;link.click();URL.revokeObjectURL(url);
}

export function LogicalWorkSourceView({metric,selector,result,scenario,assets,step,onNavigate}:{
 metric:MetricValue;selector:LogicalWorkSelector;result:AnalysisResult;scenario:Scenario;assets:AssetDocument[];
 step:number|undefined;onNavigate:(member:LogicalWorkSourceMember)=>void;
}){
 const selectorKey=canonical(selector),identity=useMemo(()=>({}),[selectorKey,metric,result,scenario,assets,step]);
 const [open,setOpen]=useState(false),[cursor,setCursor]=useState({owner:identity,page:0});
 const page=cursor.owner===identity?cursor.page:0;
 const request=useMemo<LogicalWorkSourceRequest|undefined>(()=>{
  const actualStep=step===undefined?undefined:result.decode?.steps.find(item=>item.index===step);
  if(step!==undefined&&!actualStep)return;
  const frame=actualStep?.result??result;
  return {selector,metric,scenario:actualStep?.scenario??scenario,assets,inputHash:frame.inputHash,engineVersion:frame.engineVersion,page,proofVersion:2,...(frame.stepContext?{stepContext:frame.stepContext,...(actualStep?{decodeFrame:true as const}:{})}:{})};
 },[identity,page]);
 const {state,retry,cancel}=useCostSourceWorker(open,request,'logical_work_source',readLogicalWorkSourceReply);
 return <section className="logical-work-source declaration-source" aria-label="逻辑工作来源">
  {!open?<button onClick={()=>{setCursor({owner:identity,page:0});setOpen(true);}}>复核此逻辑工作量</button>:
   !request?<p role="status">缺少实际 Decode 步骤。</p>:
   state.status==='running'?<><p role="status">正在后台复核逻辑工作量…</p><button onClick={cancel}>取消逻辑工作复核</button></>:
   state.status==='available'?<><LogicalProof key={selectorKey+':'+page} report={state.report} onNavigate={item=>{setOpen(false);onNavigate(item);}}/><div className="button-row">
    {page>0&&<button onClick={()=>setCursor({owner:identity,page:page-1})}>上一页逻辑来源</button>}
    {(page+1)*state.report.pageSize<state.report.componentCount&&<button onClick={()=>setCursor({owner:identity,page:page+1})}>下一页逻辑来源</button>}
    <button onClick={()=>save(state.report)}>导出此页逻辑来源</button><button onClick={()=>setOpen(false)}>关闭逻辑来源</button>
   </div></>:<><p role="status">{state.status==='error'?state.message:'逻辑工作复核已取消。'}</p><button onClick={retry}>重试逻辑工作复核</button></>}
 </section>;
}

function LogicalProof({report,onNavigate}:{report:LogicalWorkSourceReport;onNavigate:(member:LogicalWorkSourceMember)=>void}){
 const {metric,selector}=report;
 return <div className="storage-access-proof">
  <h5>{operations[report.operation]}</h5>
  <p>{selector.field==='usefulOperations'?'有效工作量':'声明执行工作量'} · {computeClassLabel(selector.computeClass)}</p>
  <p>{metric.status==='available'?`已复核逻辑指标 ${metric.quantity.value} ${metric.quantity.unit}`:'原逻辑指标不可用，保留诊断。'} · 第 {report.page+1} 页</p>
  <p>{report.componentCount} 项参与此分类{report.memberCount>report.componentCount?' · '+(report.memberCount-report.componentCount)+' 项缺少此分类':''}</p>
  {report.asset&&<p><code>{report.asset.assetId}@r{report.asset.revision}</code></p>}
  {report.items.map((item,index)=><article className="storage-access-item" key={index}>
   {item.kind==='segment'?<h5>计算段 {item.segmentId}</h5>:<>
    <h5>{item.kind==='extra'?'融合附加项 ':''}{item.scope.target.kind==='model'?'模型':item.scope.target.nodeId}{item.step?' · 步骤 '+(item.step.index+1):''}</h5>
    {item.step&&<p>Context {item.step.evaluatedContext} · <code>{item.step.inputHash}</code></p>}
   </>}
   <p>{item.quantity?`${item.quantity.value} ${item.quantity.unit}`:'不可用'}</p>
   {item.addition&&item.quantity&&<p>{item.addition.before} + {item.quantity.value} = {item.addition.after} {item.quantity.unit}</p>}
   {item.kind==='segment'?item.formula&&<><FormulaProof proof={item.formula.proof}/>{item.formula.truncated&&<p>公式记录达到预算，指标已按完整公式复算。</p>}</>:<button onClick={()=>onNavigate(item)}>查看此项逻辑来源</button>}
  </article>)}
  {report.parameterBindings&&(report.parameterBindings.roots.length||!report.parameterBindings.complete?
   <ParameterBindingProof graph={report.parameterBindings}/>:<p>本页已展开的公式未读取参数。</p>)}
  {report.diagnostics.map(d=><p key={d.diagnosticId}>{d.message}</p>)}
 </div>;
}
