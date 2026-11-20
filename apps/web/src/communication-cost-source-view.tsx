import {useMemo,useState} from 'react';
import type {AnalysisResult,AssetDocument,MetricValue,Scenario} from '@model-analyser/contracts';
import type {CommunicationCostSelector,CommunicationCostSourceReport,CommunicationCostSourceRequest} from '@model-analyser/core';
import {canonical} from '../../../packages/contracts/src/validation.js';
import {readCommunicationSourceReply} from './communication-source-task.js';
import {FormulaProof} from './declaration-source-view.js';
import {useCostSourceWorker} from './use-cost-source-worker.js';

function save(report:CommunicationCostSourceReport){
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
 const link=document.createElement('a');
 link.href=url;link.download=`model-analyser-communication-source-page-${report.page+1}.json`;link.click();URL.revokeObjectURL(url);
}

export function CommunicationCostSourceView({metric,selector,result,scenario,assets,step}:{
 metric:MetricValue;selector:CommunicationCostSelector;result:AnalysisResult;scenario:Scenario;assets:AssetDocument[];step:number|undefined;
}){
 const selectorKey=canonical(selector),identity=useMemo(()=>({}),[selectorKey,result,scenario,assets,step,metric]);
 const [open,setOpen]=useState(false),[cursor,setCursor]=useState({owner:identity,page:0});
 const page=cursor.owner===identity?cursor.page:0;
 const request=useMemo<CommunicationCostSourceRequest|undefined>(()=>{
  const actualStep=step===undefined?undefined:result.decode?.steps.find(item=>item.index===step);
  if(result.decode&&!actualStep)return;
  const frame=actualStep?.result??result;
  return {selector,metric,scenario:actualStep?.scenario??scenario,assets,inputHash:frame.inputHash,engineVersion:frame.engineVersion,page,...(frame.stepContext?{stepContext:frame.stepContext}:{})};
 },[identity,page]);
 const {state,cancel,retry}=useCostSourceWorker(open,request,'communication_cost_source',readCommunicationSourceReply);
 return <section className="communication-cost-source declaration-source" aria-label="通信运算来源">
  {!open?<button onClick={()=>{setCursor({owner:identity,page:0});setOpen(true);}}>复核此通信的实际运算</button>:
   !request?<p role="status">请选择一个实际 Decode 步骤。</p>:
   state.status==='running'?<><p role="status">正在后台复核通信运算…</p><button onClick={cancel}>取消通信来源复核</button></>:
   state.status==='available'?<><CommunicationProof report={state.report}/><div className="button-row">
    {page>0&&<button onClick={()=>setCursor({owner:identity,page:page-1})}>上一页通信设备</button>}
    {(page+1)*state.report.pageSize<state.report.componentCount&&<button onClick={()=>setCursor({owner:identity,page:page+1})}>下一页通信设备</button>}
    <button onClick={()=>save(state.report)}>导出此页通信来源</button><button onClick={()=>setOpen(false)}>关闭通信来源</button>
   </div></>:<><p role="status">{state.status==='error'?state.message:'通信来源复核已取消。'}</p><button onClick={retry}>重试通信来源复核</button></>}
 </section>;
}

type SummaryMetric=CommunicationCostSourceReport['summary']['send'];
const describe=(metric:SummaryMetric)=>metric.status==='available'?`${metric.quantity.value} ${metric.quantity.unit}`:'不可用';
const label={communication_bandwidth:'带宽',communication_latency:'单轮延迟',fixed_seconds:'固定耗时'};

function timingValue(timing:CommunicationCostSourceReport['network']['effective']){
 if(timing.kind==='bandwidth_latency')return `${timing.bytePerSecond} byte/s · ${timing.latencySeconds} s/轮`;
 if(timing.kind==='fixed')return `${timing.seconds} s`;
 return '自定义公式';
}

function CommunicationProof({report}:{report:CommunicationCostSourceReport}){
 const {summary,timing,network,uniformMessages,declaration}=report;
 return <div className="storage-access-proof">
  <h5>{report.operation} · {report.groupId} · {report.algorithm.name}</h5>
  <p>张量 {report.endpoints.source} → {report.endpoints.destination}</p>
  <p>{declaration.kind==='graph'?<>图内调用 {declaration.nodeId} · {declaration.asset.assetId}@{declaration.asset.revision}</>:<>配置通信 #{declaration.index}</>}</p>
  <p>已复核原指标 {describe(report.metric)} · {report.componentCount} 台设备 · 第 {report.page+1} 页</p>
  <p>每成员发送 {describe(summary.send)} · 接收 {describe(summary.receive)} · 算法流量 {describe(summary.traffic)}</p>
  <p>组总发送 {describe(summary.groupSend)} · 组总接收 {describe(summary.groupReceive)}</p>
  {uniformMessages&&<details><summary>统一消息的公式与组总量</summary>
   <p>发送 {uniformMessages.send.quantity.value} byte，接收 {uniformMessages.receive.quantity.value} byte，分别乘以 {uniformMessages.count} 得到组总量。</p>
   {uniformMessages.send.proof&&<FormulaProof proof={uniformMessages.send.proof}/>}
   {uniformMessages.receive.proof&&<FormulaProof proof={uniformMessages.receive.proof}/>}
  </details>}
  <section className="storage-access-item" aria-label="实际链路与耗时">
   <h5>实际链路与耗时</h5>
   <p>声明 {timingValue(network.authored)} · 角色绑定后 {timingValue(network.roleBound)} · 生效 {timingValue(network.effective)}</p>
   {network.overrides.map(row=><p key={row.index}>规则 #{row.index} · {label[row.override.field as keyof typeof label]} · {timingValue(row.before)} → {timingValue(row.after)}{row.override.description?` · ${row.override.description}`:''}</p>)}
   {timing?.kind==='bandwidth_latency'&&<><p>传输 {timing.maxTraffic} ÷ {timing.bytePerSecond} = {timing.transfer} s</p><p>启动 {timing.rounds} × {timing.latencySeconds} = {timing.startup} s</p><p>网络耗时 {timing.transfer} + {timing.startup} = {timing.seconds} s</p></>}
   {timing?.kind==='fixed'&&<p>固定网络耗时 {timing.seconds} s</p>}
   {report.timingFormula?.proof&&<FormulaProof proof={report.timingFormula.proof}/>}
   <p>该值是通信模型的网络耗时。多流调度区间在聚合来源与时间线中查看。</p>
  </section>
  {report.items.map(item=><article className="storage-access-item" key={item.deviceId}>
   <h5>{item.deviceId}{item.role==='sender'?' · 发送端':item.role==='receiver'?' · 接收端':''}</h5>
   <p>发送 {describe(item.send)} · 接收 {describe(item.receive)} · 发送量 × {item.factor} = {describe(item.traffic)}</p>
   {timing?.kind==='bandwidth_latency'&&item.traffic.status==='available'&&item.traffic.quantity.value===timing.maxTraffic&&<p>该设备的算法流量达到网络耗时使用的最大值。</p>}
   {item.sendSum&&item.receiveSum&&item.send.status==='available'&&item.receive.status==='available'&&<p>组发送累计 {item.sendSum.before} + {item.send.quantity.value} = {item.sendSum.after} byte · 组接收累计 {item.receiveSum.before} + {item.receive.quantity.value} = {item.receiveSum.after} byte</p>}
   {item.sendFormula?.proof&&<FormulaProof proof={item.sendFormula.proof}/>}
   {item.receiveFormula?.proof&&<FormulaProof proof={item.receiveFormula.proof}/>}
  </article>)}
  {!report.complete&&<p>此页公式记录达到证据预算。</p>}
  {report.diagnostics.map(item=><p key={item.diagnosticId}>{item.message}</p>)}
 </div>;
}
