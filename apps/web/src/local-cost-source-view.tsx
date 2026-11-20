import {useMemo,useState} from 'react';
import type {AnalysisResult,AssetDocument,MetricValue,Scenario,Shape} from '@model-analyser/contracts';
import type {LocalCostSelector,LocalCostSourceReport,LocalCostSourceRequest} from '@model-analyser/core';
import {canonical} from '../../../packages/contracts/src/validation.js';
import {readLocalSourceReply} from './local-source-task.js';
import {FormulaProof} from './declaration-source-view.js';
import {TimingDagPage} from './leaf-timing-source-view.js';
import {useCostSourceWorker} from './use-cost-source-worker.js';

function save(report:LocalCostSourceReport){
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
 const link=document.createElement('a');
 link.href=url;link.download=`model-analyser-local-cost-page-${report.page+1}.json`;link.click();URL.revokeObjectURL(url);
}

export function LocalCostSourceView({metric,selector,result,scenario,assets,step}:{
 metric:MetricValue;selector:LocalCostSelector;result:AnalysisResult;scenario:Scenario;assets:AssetDocument[];step:number|undefined;
}){
 const selectorKey=canonical(selector),identity=useMemo(()=>({}),[selectorKey,metric,result,scenario,assets,step]);
 const [open,setOpen]=useState(false),[cursor,setCursor]=useState({owner:identity,page:0});
 const page=cursor.owner===identity?cursor.page:0;
 const request=useMemo<LocalCostSourceRequest|undefined>(()=>{
  const actualStep=step===undefined?undefined:result.decode?.steps.find(row=>row.index===step);
  if(result.decode&&!actualStep)return;
  const frame=actualStep?.result??result;
  return {selector,metric,scenario:actualStep?.scenario??scenario,assets,inputHash:frame.inputHash,engineVersion:frame.engineVersion,page,...(frame.stepContext?{stepContext:frame.stepContext,...(actualStep?{decodeFrame:true as const}:{})}:{})};
 },[identity,page]);
 const {state,retry,cancel}=useCostSourceWorker(open,request,'local_cost_source',readLocalSourceReply);
 return <section className="local-cost-source declaration-source" aria-label="逐卡运算来源">
  {!open?<button onClick={()=>{setCursor({owner:identity,page:0});setOpen(true);}}>复核此设备的局部方程</button>:
   !request?<p role="status">请选择一个实际 Decode 步骤。</p>:
   state.status==='running'?<><p role="status">正在后台复核逐卡运算…</p><button onClick={cancel}>取消逐卡来源复核</button></>:
   state.status==='available'?<><LocalProof key={selectorKey+':'+page} report={state.report}/><div className="button-row">
    {page>0&&<button onClick={()=>setCursor({owner:identity,page:page-1})}>上一页逐卡来源</button>}
    {(page+1)*state.report.pageSize<state.report.componentCount&&<button onClick={()=>setCursor({owner:identity,page:page+1})}>下一页逐卡来源</button>}
    <button onClick={()=>save(state.report)}>导出此页逐卡来源</button><button onClick={()=>setOpen(false)}>关闭逐卡来源</button>
   </div></>:<><p role="status">{state.status==='error'?state.message:'逐卡来源复核已取消。'}</p><button onClick={retry}>重试逐卡来源复核</button></>}
 </section>;
}

type Item=LocalCostSourceReport['items'][number];
type Access=Extract<Item,{kind:'access'}>;
type DeviceAllocation=NonNullable<Access['allocation']>;
type Metric=Access['logical'];
const show=(metric:Metric)=>metric.status==='available'?`${metric.quantity.value} ${metric.quantity.unit}`:'不可用';
const shape=(axes:Shape)=>axes.map(a=>a.axisId+'='+ (a.size.kind==='literal'?a.size.quantity.value:'表达式')).join(' × ');

function Allocation({value}:{value:DeviceAllocation}){
 return <p><code>{value.canonicalStorageId}</code> · {shape(value.allocatedShape)} · {show(value.allocation.totalBytes)}/副本 × {value.copies} = {show(value.totalBytes)}
 {value.assignmentIndices.length>0&&<small>分配规则 {value.assignmentIndices.map(i=>'#'+(i+1)).join('、')}</small>}</p>;
}

function LocalProof({report}:{report:LocalCostSourceReport}){
 const [timingPage,setTimingPage]=useState(0),{metric,participation,dag,trafficOverride}=report;
 return <div className="storage-access-proof">
  <h5>{report.selector.nodeId} · {report.selector.deviceId}</h5>
  <p>{metric.status==='available'?'已复核逐卡指标 '+show(metric):'原逐卡指标不可用，保留诊断。'} · 第 {report.page+1} 页 · {report.componentCount} 项</p>
  <p>{report.asset.assetId}@r{report.asset.revision} · {report.hardware.assetId}@r{report.hardware.revision}</p>
  <p>{participation.kind==='complete_single_device'?'完整单设备采用全局叶方程':participation.kind==='tensor_layout'?'按张量 '+participation.tensorId+' 参与':'按存储 '+participation.storageId+' 参与'} · {report.deviceIds.length} 台参与设备</p>
  {report.description&&<p>{report.description}</p>}
  {!report.complete&&metric.status==='available'&&<p>当前表达式证据为分页或有界记录。按固定输入、完整参数与实际步骤复算原指标。</p>}
  {report.diagnostics.map(d=><p key={d.diagnosticId}>{d.message}</p>)}
  {trafficOverride&&<p>流量覆盖 #{trafficOverride.index+1} · 当前设备原始逻辑读写 {trafficOverride.originalTotal} byte · 指定总量 {trafficOverride.override.value.value} byte</p>}
  {report.timingOverrides.map(({index,override,change})=>change.kind==='timing'&&<p key={index}>耗时覆盖 #{index+1} · {override.field} = {override.value.value} {override.value.unit} · {change.before.kind} → {change.after.kind}</p>)}
  {dag&&<details><summary>查看当前设备的 Roofline 耗时运算</summary>
   <p>{dag.completeTiming?'已复核每段计算耗时、HBM 耗时与启动耗时。':'当前耗时链包含求值诊断或达到记录预算。'}</p>
   <TimingDagPage dag={dag} page={timingPage} pageSize={report.pageSize}/>
   <div className="button-row">
    {timingPage>0&&<button onClick={()=>setTimingPage(n=>n-1)}>上一页 Roofline 步骤</button>}
    {(timingPage+1)*report.pageSize<Math.max(dag.nodes.length,dag.guards.length)&&<button onClick={()=>setTimingPage(n=>n+1)}>下一页 Roofline 步骤</button>}
   </div>
  </details>}
  {report.items.map((item,i)=><article className="storage-access-item" key={i}><LocalTerm item={item} denominator={trafficOverride?.originalTotal}/></article>)}
 </div>;
}

function LocalTerm({item,denominator}:{item:Item;denominator:number|undefined}){
 switch(item.kind){
  case 'binding':return <>
   <h5>{item.binding.symbol} = {item.binding.quantity.value} {item.binding.quantity.unit}</h5>
   {'tensor'in item&&item.tensor&&<><p><code>{item.tensor.tensorId}</code> · 逻辑 {shape(item.tensor.logicalShape)} · 分配 {shape(item.tensor.allocatedShape)} · {item.tensor.copies} 份</p>{item.tensor.slices.map(s=><p key={s.axisId}>{s.axisId} [{s.start}, {s.end})</p>)}</>}
   {'storage'in item&&item.storage&&<Allocation value={item.storage}/>}
   <small>{item.binding.source.kind}{'basis'in item.binding.source?' · '+item.binding.source.basis:''}{'edge'in item.binding.source?' · '+item.binding.source.edge:''}</small>
  </>;
  case 'compute':return <><h5>{item.segmentId} · {item.field==='usefulOperations'?'有效工作':'执行工作'} · {show(item.metric)}</h5>{item.formula&&<FormulaProof proof={item.formula.proof}/>}</>;
  case 'access':return <>
   <h5>{item.accessId} · {item.mode==='read'?'读取':'写入'} · <code>{item.storageId}</code></h5>
   <p>逻辑流量 {show(item.logical)} · HBM {show(item.hbm)}</p>
   {item.allocation&&<Allocation value={item.allocation}/>}
   {item.accessKind==='storage_allocation'&&item.logicalFormula&&<p>passes = {item.logicalFormula.quantity.value}{item.logicalFormula.quantity.value===0?' · 无需读取分配字节':''}</p>}
   {item.replacement&&<p>按原逻辑流量 {item.replacement.originalBytes} / {denominator} 分摊，覆盖后 {item.replacement.replacementBytes} byte</p>}
   {item.logicalFormula&&<details><summary>逻辑流量公式</summary><FormulaProof proof={item.logicalFormula.proof}/></details>}
   {item.hbmFactor!==undefined&&<p>逻辑流量 × {item.hbmFactor}</p>}
   {item.hbmFormula&&<details><summary>独立 HBM 字节公式</summary><FormulaProof proof={item.hbmFormula.proof}/></details>}
   {item.step&&<p>累加 {item.step.before} → {item.step.after} byte</p>}
  </>;
  case 'fixed':return <p>生效固定耗时 {item.definition.seconds} s · {item.definition.description}</p>;
  case 'custom_formula':return item.formula?<FormulaProof proof={item.formula.proof}/>:<p>原局部耗时公式求值失败。</p>;
 }
}
