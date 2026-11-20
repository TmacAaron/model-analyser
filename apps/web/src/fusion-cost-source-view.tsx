import {useMemo,useState} from 'react';
import type {AnalysisResult,AssetDocument,MetricValue,Scenario} from '@model-analyser/contracts';
import type {FusionCostSelector,FusionCostSourceReport,FusionCostSourceRequest,FusionSourceOperand} from '@model-analyser/core';
import {canonical} from '../../../packages/contracts/src/validation.js';
import {readFusionSourceReply} from './fusion-source-task.js';
import {FormulaProof} from './declaration-source-view.js';
import {PagedTimingDag} from './leaf-timing-source-view.js';
import {useCostSourceWorker} from './use-cost-source-worker.js';

const operations={
 sum_devices:'按设备累加物理成本',sum_device_terms:'按成员顺序累加，再计入附加成本',max_devices:'取最慢参与设备的耗时',
 sum_member_barriers:'按成员屏障累加，再加附加屏障',fixed_override:'采用声明的整体固定耗时',formula_override:'采用整体耗时公式',
 roofline_override:'按设备的融合后成本计算整体 Roofline',stream_span:'多流调度的实际融合跨度',
};
const operandLabels={device:'设备',member:'成员',extra:'附加成本',barrier:'屏障',barrier_rank:'屏障设备'};

function save(report:FusionCostSourceReport){
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
 const link=document.createElement('a');
 link.href=url;link.download=`model-analyser-fusion-source-page-${report.page+1}.json`;link.click();URL.revokeObjectURL(url);
}

export function FusionCostSourceView({metric,selector,result,scenario,assets,step,goTo}:{
 metric:MetricValue;selector:FusionCostSelector;result:AnalysisResult;scenario:Scenario;assets:AssetDocument[];step:number|undefined;
 goTo:(term:FusionSourceOperand)=>(()=>void)|undefined;
}){
 const selectorKey=canonical(selector),identity=useMemo(()=>({}),[selectorKey,metric,result,scenario,assets,step]);
 const [open,setOpen]=useState(false),[cursor,setCursor]=useState({owner:identity,page:0});
 const page=cursor.owner===identity?cursor.page:0;
 const request=useMemo<FusionCostSourceRequest|undefined>(()=>{
  const actualStep=step===undefined?undefined:result.decode?.steps.find(item=>item.index===step);
  if(result.decode&&!actualStep)return;
  const frame=actualStep?.result??result;
  return {selector,metric,scenario:actualStep?.scenario??scenario,assets,inputHash:frame.inputHash,engineVersion:frame.engineVersion,page,...(frame.stepContext?{stepContext:frame.stepContext,...(actualStep?{decodeFrame:true as const}:{})}:{})};
 },[identity,page]);
 const {state,retry,cancel}=useCostSourceWorker(open,request,'fusion_cost_source',readFusionSourceReply);
 return <section className="fusion-cost-source declaration-source" aria-label="融合运算来源">
  {!open?<button onClick={()=>{setCursor({owner:identity,page:0});setOpen(true);}}>复核此融合的实际运算</button>:
   !request?<p role="status">请选择一个实际 Decode 步骤。</p>:
   state.status==='running'?<><p role="status">正在后台复核融合运算…</p><button onClick={cancel}>取消融合来源复核</button></>:
   state.status==='available'?<><FusionProof key={selectorKey+':'+page} report={state.report} goTo={term=>{
    const navigate=goTo(term);
    if(!navigate)return;
    return ()=>{setOpen(false);navigate();};
   }}/><div className="button-row">
    {page>0&&<button onClick={()=>setCursor({owner:identity,page:page-1})}>上一页融合来源</button>}
    {(page+1)*state.report.pageSize<state.report.componentCount&&<button onClick={()=>setCursor({owner:identity,page:page+1})}>下一页融合来源</button>}
    <button onClick={()=>save(state.report)}>导出此页融合来源</button><button onClick={()=>setOpen(false)}>关闭融合来源</button>
   </div></>:<><p role="status">{state.status==='error'?state.message:'融合来源复核已取消。'}</p><button onClick={retry}>重试融合来源复核</button></>}
 </section>;
}

function FusionProof({report,goTo}:{report:FusionCostSourceReport;goTo:(term:FusionSourceOperand)=>(()=>void)|undefined}){
 const {scope}=report.selector,{metric,streamSpan,overrideFormula,dag,selectedTimeStrategy}=report;
 return <div className="storage-access-proof">
  <h5>{operations[report.operation]}</h5>
  <p>{report.groupId} · {scope.aggregation==='per_device'?scope.deviceIds[0]:'设备组'} · {report.memberCount} 个数学步骤 · 第 {report.page+1} 页</p>
  <p>{metric.status==='available'?`已复核融合指标 ${metric.quantity.value} ${metric.quantity.unit}`:'原融合指标不可用，保留诊断。'}</p>
  {report.origin&&<p>预设 <code>{report.origin.asset.assetId}@r{report.origin.asset.revision}</code> · {report.origin.presetId} · {report.origin.scopeNodeId}</p>}
  {report.hardware&&<p>设备硬件 <code>{report.hardware.assetId}@r{report.hardware.revision}</code></p>}
  {report.eliminatedTensorCount>0&&<p>取消 {report.eliminatedTensorCount} 个内部张量的物化 · 移除 {report.removedCount} 项实际访问或临时分配</p>}
  {report.operation==='stream_span'&&streamSpan&&<p>融合跨度 {streamSpan.endSeconds??'未定'} − {streamSpan.startSeconds??'未定'} s · {streamSpan.streamId??'未分配流'}。设备项显示独立方程耗时。</p>}
  {report.operation==='sum_member_barriers'&&<p>各屏障分别取该步骤最慢的设备。成员方程保留为时间分量。</p>}
  {report.selector.field==='seconds'&&selectedTimeStrategy.kind==='override'&&<p>整体时间策略 · {selectedTimeStrategy.description}</p>}
  {report.operation==='fixed_override'&&selectedTimeStrategy.kind==='override'&&selectedTimeStrategy.timing.kind==='fixed'&&<p>生效固定耗时 {selectedTimeStrategy.timing.seconds} s · {selectedTimeStrategy.timing.description}</p>}
  {overrideFormula&&<FormulaProof proof={overrideFormula.proof}/>}
  {overrideFormula?.truncated&&<p>公式展开达到记录预算，指标已按完整公式复算。</p>}
  {dag&&<details><summary>查看融合 Roofline 计算步骤</summary><p>{dag.completeTiming?'按融合后的各计算分类与 HBM 字节计算设备耗时。':'Roofline 链含求值诊断或达到记录上限。'}</p><PagedTimingDag dag={dag} pageSize={report.pageSize}/></details>}
  {report.diagnostics.map(d=><p key={d.diagnosticId}>{d.message}</p>)}
  {report.items.map((item,index)=><article className="storage-access-item" key={index}>{'resourceRemoved'in item?
   <><h5>移除 {item.kind==='access'?item.mode==='read'?'读取':'写入':'临时存储'} · {item.nodeId}</h5><p><code>{item.canonicalStorageId}</code>{item.kind==='access'?' · '+item.accessId:''}</p></>:
   item.kind==='elided_allocation'?<><h5>取消物化后的分配 · {item.deviceId}</h5><p><code>{item.storageId}</code> · {item.quantity?`${item.quantity.value} ${item.quantity.unit}`:'不可用'}</p></>:
   <FusionOperand term={item} extraNodeId={report.extraNodeId} navigate={goTo(item)}/>}</article>)}
 </div>;
}

function FusionOperand({term,extraNodeId,navigate}:{term:FusionSourceOperand;extraNodeId:string;navigate:(()=>void)|undefined}){
 return <>
  <h5>{operandLabels[term.kind]} · {term.nodeId===extraNodeId?'融合附加项':term.nodeId}{term.deviceId?' · '+term.deviceId:''}</h5>
  <p>{term.quantity?`${term.quantity.value} ${term.quantity.unit}`:'不可用'}{term.bottleneck?' · 达到屏障上限':''}</p>
  {term.step&&term.quantity&&<p>{term.step.before} + {term.quantity.value} = {term.step.after} {term.quantity.unit}</p>}
  {navigate&&<button onClick={navigate}>查看此项方程</button>}
 </>;
}
