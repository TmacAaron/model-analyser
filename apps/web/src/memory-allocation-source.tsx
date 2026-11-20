import { useState } from 'react';
import type { AssetDocument,ResolvedParameter,Diagnostic,MetricValue } from '@model-analyser/contracts';
import { ParameterValues } from './resolved-inspector-view.js';
import { useDisplayUnits } from './display-units.js';
export type MemorySourceContext={assets:AssetDocument[];parameters:ResolvedParameter[]|undefined;diagnostics:Diagnostic[];missingParameterReason?:string|undefined};
export function AllocationMetricProof({label,value,context}:{label:string;value:MetricValue|undefined;context:MemorySourceContext}){
  const display=useDisplayUnits(),[limit,setLimit]=useState(12),[assetLimit,setAssetLimit]=useState(12),[rawOpen,setRawOpen]=useState(false);
  if(!value)return <p>{label} · 指标或来源引用缺失，未补值。</p>;
  if(value.status==='unavailable')return <p>{label} · 不可用：{value.diagnosticIds.map(id=>context.diagnostics.find(d=>d.diagnosticId===id)?.message??('未记录此诊断文本：'+id)).join('；')}</p>;
  const keys=new Set(value.provenance.parameterSources.map(p=>p.parameterKey)),parameters=context.parameters?.filter(p=>keys.has(p.nodeId+':'+p.parameterKey));
  return <section className="memory-allocation-metric"><h5>{label}</h5><p>{display.metric(value)} · 原始 {value.quantity.value} {value.quantity.unit} · {value.basis}</p><h5>固定公式与表达式</h5>
    {!!value.diagnosticIds.length&&<div className="metric-source-diagnostics" role="status">{value.diagnosticIds.map(id=>{const d=context.diagnostics.find(d=>d.diagnosticId===id);return <p key={id}>{d?d.severity+' · '+d.code+' · '+d.message:'未记录此诊断文本：'+id}</p>;})}</div>}
    {value.provenance.formulaRefs.length?value.provenance.formulaRefs.slice(0,limit).map((ref,i)=>{const asset=context.assets.find(a=>a.assetId===ref.assetId&&a.revision===ref.revision);return <div key={ref.assetId+':'+ref.revision+':'+i}><code>{ref.assetId}@r{ref.revision}</code>{asset?.definition.kind==='formula'?<><p>{asset.name} · {asset.definition.formula.description}</p><code className="memory-formula-expression">{asset.definition.formula.expression}</code></>:<p>当前快照未含此公式，保留固定引用。</p>}</div>;}):<p>此指标未记录独立公式引用；固定值及假设保留如下。</p>}
    {value.provenance.formulaRefs.length>limit&&<button onClick={()=>setLimit(n=>n+12)}>再显示 12 个固定公式</button>}
    <details><summary>固定资产依赖与修订 · {value.provenance.assetRefs.length}</summary>{value.provenance.assetRefs.slice(0,assetLimit).map((ref,i)=>{const asset=context.assets.find(a=>a.assetId===ref.assetId&&a.revision===ref.revision);return <p key={ref.assetId+':'+ref.revision+':'+i}><code>{ref.assetId}@r{ref.revision}</code> · {ref.kind} · {asset?.name??'当前快照缺少此固定修订，未改用其他版本'}</p>;})}{value.provenance.assetRefs.length>assetLimit&&<button onClick={()=>setAssetLimit(n=>n+12)}>再显示 12 个固定资产</button>}</details>
    <details className="memory-source-parameters"><summary>记录的参数值与来源 · {parameters?.length??0}</summary><p>按指标记录的来源范围读取实际求值参数；共用依赖不表示独立贡献，不用当前默认值补填。</p>{parameters?.length?<ParameterValues parameters={parameters}/>:<p>{context.parameters?'此指标没有可匹配的独立参数值记录，可展开实际调用上下文。':context.missingParameterReason??'此旧结果没有实际参数记录，请重新计算。'}</p>}</details>
    <details className="memory-source-context"><summary>实际调用求值上下文 · {context.parameters?.length??0}</summary><p>整次调用的参数清单，与此指标的独立贡献分开。</p>{context.parameters?<ParameterValues parameters={context.parameters}/>:<p>{context.missingParameterReason??'未记录实际值，请重新计算。'}</p>}</details>
    <details className="memory-source-assumptions"><summary>假设与覆盖说明 · {value.provenance.assumptions.length}</summary>{value.provenance.assumptions.map((s,i)=><p key={i}>{s}</p>)}</details>
    <details className="metric-source-raw" open={rawOpen} onToggle={e=>setRawOpen(e.currentTarget.open)}><summary>当前指标原始记录</summary>{rawOpen&&<pre>{JSON.stringify(value,null,2)}</pre>}</details>
  </section>;
}
