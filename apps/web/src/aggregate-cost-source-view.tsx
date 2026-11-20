import {useEffect,useMemo,useRef,useState} from 'react';
import type {AnalysisResult,AssetDocument,MetricValue,Scenario} from '@model-analyser/contracts';
import type {AggregateCostSelector,AggregateCostSourceReport,AggregateCostSourceRequest} from '@model-analyser/core';
import {canonical} from '../../../packages/contracts/src/validation.js';
import {readAggregateSourceReply,type AggregateSourceTask} from './aggregate-source-task.js';

export type AggregateSourceMember=AggregateCostSourceReport['items'][number];
type State={status:'running'|'cancelled'}|{status:'error';message:string}|{status:'available';report:AggregateCostSourceReport};
const labels={ordered_sum:'按原顺序求和',serial_barriers:'按执行顺序累计串行屏障',stream_makespan:'多流调度结束时刻',module_stream_span:'模块最后结束减最早开始'};
const members={node:'算子',fusion:'融合组',communication:'通信',module:'模块',model:'模型',metadata:'调度元数据'};

function save(report:AggregateCostSourceReport){
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
 const link=document.createElement('a');link.href=url;link.download=`model-analyser-aggregate-source-page-${report.page+1}.json`;link.click();URL.revokeObjectURL(url);
}

export function AggregateCostSourceView({metric,selector,result,scenario,assets,step,onNavigate}:{
 metric:MetricValue;selector:AggregateCostSelector;result:AnalysisResult;scenario:Scenario;assets:AssetDocument[];step:number|undefined;
 onNavigate:(member:AggregateSourceMember)=>void;
}){
 const selectorKey=canonical(selector);
 const identity=useMemo(()=>({}),[selectorKey,result,scenario,assets,step,metric]);
 const [open,setOpen]=useState(false),[cursor,setCursor]=useState({owner:identity,page:0}),[retry,setRetry]=useState(0);
 const page=cursor.owner===identity?cursor.page:0;
 const request=useMemo<AggregateCostSourceRequest|undefined>(()=>{
  const actualStep=step===undefined?undefined:result.decode?.steps.find(item=>item.index===step);
  if(step!==undefined&&!actualStep)return;
  const frame=actualStep?.result??result;
  return {selector,metric,scenario:actualStep?.scenario??scenario,assets,inputHash:frame.inputHash,engineVersion:frame.engineVersion,page,...(frame.stepContext?{stepContext:frame.stepContext}:{})};
 },[identity,page]);
 const owner=useRef(request);owner.current=request;
 const worker=useRef<Worker|null>(null);
 const [saved,setSaved]=useState<{owner:typeof request;state:State}>({owner:request,state:{status:'running'}});
 const state:State=saved.owner===request?saved.state:{status:'running'};
 useEffect(()=>{
  if(!open||!request)return;
  setSaved({owner:request,state:{status:'running'}});
  const task:AggregateSourceTask={taskId:crypto.randomUUID(),phase:'aggregate_cost_source',request};
  let active:Worker|undefined;
  function finish(next:State){
   if(worker.current!==active||owner.current!==request)return;
   setSaved({owner:request,state:next});active?.terminate();worker.current=null;
  }
  try{
   active=new Worker(new URL('./leaf-cost-source-worker.ts',import.meta.url),{type:'module'});
   worker.current=active;
   active.onmessage=(message:MessageEvent<unknown>)=>{
    try{finish(readAggregateSourceReply(message.data,task));}
    catch(error){finish({status:'error',message:error instanceof Error?error.message:'聚合来源回复有误'});}
   };
   active.onerror=()=>finish({status:'error',message:'聚合来源后台任务失败'});
   active.postMessage(task);
  }catch(error){
   active?.terminate();worker.current=null;
   setSaved({owner:request,state:{status:'error',message:error instanceof Error?error.message:'无法启动聚合来源任务'}});
  }
  return ()=>{active?.terminate();if(worker.current===active)worker.current=null;};
 },[open,request,retry]);
 return <section className="aggregate-cost-source declaration-source" aria-label="聚合运算来源">
  {!open?<button onClick={()=>{setCursor({owner:identity,page:0});setOpen(true);}}>复核此指标的聚合运算</button>:!request?<p role="status">实际步骤或固定配置缺失，请重新分析。</p>:
   state.status==='running'?<><p role="status">正在后台复核聚合运算…</p><button onClick={()=>{worker.current?.terminate();worker.current=null;setSaved({owner:request,state:{status:'cancelled'}});}}>取消聚合来源复核</button></>:
   state.status==='available'?<><AggregateProof report={state.report} onNavigate={member=>{setOpen(false);onNavigate(member);}}/><div className="button-row">
   {page>0&&<button onClick={()=>setCursor({owner:identity,page:page-1})}>上一页聚合来源</button>}
   {(page+1)*state.report.pageSize<state.report.componentCount&&<button onClick={()=>setCursor({owner:identity,page:page+1})}>下一页聚合来源</button>}
   <button onClick={()=>save(state.report)}>导出此页聚合来源</button><button onClick={()=>setOpen(false)}>关闭聚合来源</button>
   </div></>:<><p role="status">{state.status==='error'?state.message:'聚合来源复核已取消。'}</p><button onClick={()=>setRetry(value=>value+1)}>重试聚合来源复核</button></>}
 </section>;
}

function AggregateProof({report,onNavigate}:{report:AggregateCostSourceReport;onNavigate:(member:AggregateSourceMember)=>void}){
 const start=report.page*report.pageSize;
 return <div className="storage-access-proof">
  <h5>{labels[report.operation]}</h5>
  <p>已复核原指标 {report.metric.quantity.value} {report.metric.quantity.unit} · {report.componentCount} 项 · 第 {report.page+1} 页</p>
  {'startSeconds'in report&&<p>起点 {report.startSeconds} s · 终点 {report.endSeconds} s{report.terminalEvent?` · 最后一次调度事件处理 ${report.terminalEvent.activeDeviceTasks} 个设备任务`:''}</p>}
  {report.memberCount!==report.componentCount&&<p>{report.memberCount-report.componentCount} 个成员没有此完整计算分类。</p>}
  {report.items.map((item,index)=><article className="storage-access-item" key={start+index}>
   <h5>{members[item.kind]} {item.target.kind==='model'?'':item.target.nodeId}{item.step?` · 步骤 ${item.step.index+1}`:''}</h5>
   {item.step&&<p>Context {item.step.evaluatedContext} · <code>{item.step.inputHash}</code></p>}
   {!!item.deviceIds.length&&<p>{item.deviceIds.join('、')}</p>}
   {'quantity'in item?<p>{item.before} + {item.quantity.value} = {item.after} {item.quantity.unit}</p>:<p>{item.startSeconds} → {item.endSeconds} s{item.streamId?` · ${item.streamId}`:''}</p>}
   {item.kind!=='metadata'&&<button onClick={()=>onNavigate(item)}>查看此项来源</button>}
  </article>)}
 </div>;
}
