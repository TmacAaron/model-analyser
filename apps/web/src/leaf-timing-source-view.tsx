import type {ExactLeafSourceReport,TimingNode} from '@model-analyser/core';
import {useState} from 'react';
import {StorageAccessProof} from './storage-access-source-view.js';
import {FormulaProof} from './declaration-source-view.js';import {LeafExpressionItems} from './leaf-expression-items.js';
const operations:Record<TimingNode['operation'],string>={input:'实际输入',literal:'常量',return:'返回',zero_when_work_zero:'工作量为零，直接返回',multiply:'乘',divide:'除',log:'log',subtract:'减',exp:'exp',sum:'加',max:'max'};
const units:Record<string,string>={operation:'op',operation_per_second:'op/s',byte:'B',byte_per_second:'B/s',second:'s',ratio:'×',scalar:''};
function origin(node:TimingNode){const source=node.source;if(!source)return '';if(source['kind']==='hardware_field')return (String(source['field']).startsWith('memory')?'HBM带宽':'计算能力')+' #'+source['capabilityIndex']+' · '+(source['capabilityKind']==='peak'?'峰值':'有效能力');if(source['kind']==='metric_boundary')return source['field']==='hbmBytes'?'当前HBM字节量':'计算段执行工作量';if(source['kind']==='timing_field')return source['field']==='launchSeconds'?'启动耗时':source['field']==='memoryEfficiency'?'带宽效率':'计算效率';if(source['kind']==='effective_capacity_no_extra_factor')return '有效能力，效率为1';if(node.operation==='zero_when_work_zero')return '未执行除法或log回退';return '';}
export function LeafTimingProof({report}:{report:Extract<ExactLeafSourceReport,{kind:'leaf_timing_source'}>}){
 return <div className="leaf-timing-proof" aria-label="实际Roofline耗时来源"><p>已复核原叶指标：{report.metric.quantity.value} {report.metric.quantity.unit}</p><p><code>{report.selector.nodeId}</code> · {report.selector.field} · {report.engineVersion}</p><p>实际硬件 <code>{report.hardware.assetId}@r{report.hardware.revision}</code> · 原始计算段分别相除后按原顺序求和，再执行{report.timing.computeMemoryOverlap==='ideal'?' max':'加法'}与启动耗时。</p><p role="status">{report.coverage.completeTimingTransform?'耗时运算链已完整复核。':'耗时运算证据达到预算，数值已完整复算；当前链为部分记录。'} 第 {report.page+1} 页，每类最多 {report.pageSize} 项。</p><p>{report.coverage.completeSupportedExpressions?'本页工作量表达式与HBM来源已复核。':'上游表达式为分页、有界或部分来源。'} {report.coverage.parameterBindingDagComplete?'当前调用参数绑定已完整复核；':'参数绑定为有界或部分记录；'}分布式及融合变换链尚未完整展示。</p>
 <TimingDagPage dag={report.dag} page={report.page} pageSize={report.pageSize}/>
 {!!report.workExpressions.length&&<section className="timing-work-expressions"><h4>实际计算段表达式 · {report.workExpressionCount} 项</h4>{report.workExpressions.map(work=><section key={work.segmentId}><h5>{work.field}</h5><FormulaProof proof={work.proof}/>{work.truncated&&<p>此计算段表达式达到记录预算，证据为部分。</p>}</section>)}</section>}
 {'hbmSource'in report&&report.hbmSource&&<section className="timing-hbm-source"><h4>实际HBM工作量上游 · {report.hbmExpressionCount} 项</h4><LeafExpressionItems items={report.hbmSource.items}/></section>}
 {'hbmBoundaryReason'in report&&report.hbmBoundaryReason&&<p className="scope-note">HBM使用已复核的当前指标边界；上游变换未声明完整：{report.hbmBoundaryReason}</p>}
 {'storageAccessSource'in report&&<StorageAccessProof key={report.page} source={report.storageAccessSource}/>}
 </div>;
}

type TimingDag=Extract<ExactLeafSourceReport,{kind:'leaf_timing_source'}>['dag'];
export function PagedTimingDag({dag,pageSize}:{dag:TimingDag;pageSize:number}){
 const [page,setPage]=useState(0);
 return <>
  <TimingDagPage dag={dag} page={page} pageSize={pageSize}/>
  <div className="button-row">
   {page>0&&<button onClick={()=>setPage(n=>n-1)}>上一页 Roofline 步骤</button>}
   {(page+1)*pageSize<Math.max(dag.nodes.length,dag.guards.length)&&<button onClick={()=>setPage(n=>n+1)}>下一页 Roofline 步骤</button>}
  </div>
 </>;
}

export function TimingDagPage({dag,page,pageSize}:{dag:TimingDag;page:number;pageSize:number}){
 const start=page*pageSize,nodes=dag.nodes.slice(start,start+pageSize),guards=dag.guards.slice(start,start+pageSize),ordinal=new Map(dag.nodes.map((node,index)=>[node.id,index+1]));
 return <>
 <table className="timing-operation-table"><caption>实际耗时运算 · {dag.nodes.length} 条有界记录</caption><colgroup><col style={{width:'12%'}}/><col style={{width:'27%'}}/><col style={{width:'27%'}}/><col style={{width:'34%'}}/></colgroup><thead><tr><th>步骤</th><th>运算</th><th>结果</th><th>来源</th></tr></thead><tbody>{nodes.map(node=><tr key={node.id}><td>#{ordinal.get(node.id)}</td><td>{operations[node.operation]}{node.inputs.length?'（'+node.inputs.map(id=>'#'+ordinal.get(id)).join(', ')+'）':''}</td><td>{String(node.value)} <small>{units[node.unit]??node.unit}</small></td><td>{origin(node)}</td></tr>)}</tbody></table>
 {!!nodes.length&&<details className="timing-field-identities"><summary>本页运算的原始字段身份</summary>{nodes.map(node=><p key={node.id}>#{ordinal.get(node.id)} · <code>{node.id}</code>{node.source?.['field']?' · '+node.source['field']:''}</p>)}</details>}
 {!!guards.length&&<details><summary>硬件能力匹配与效率检查</summary>{guards.map((guard,index)=><p key={start+index}>{guard['kind']==='compute_capability'?'计算段 '+guard['segmentId']:'HBM带宽'} · 精确匹配 {String(guard['matchingCount'])} 项 · 声明效率 {String(guard['declaredEfficiency'])}</p>)}</details>}
 </>;
}
