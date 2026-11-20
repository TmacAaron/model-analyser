import { useEffect,useRef,useState } from 'react';
import { Unit,type MetricValue,type DecodeStepContext } from '@model-analyser/contracts';
import { AllocationMetricProof,type MemorySourceContext } from './memory-allocation-source.js';
import { useDisplayUnits } from './display-units.js';
import { DeclarationSourceView,type DeclarationSource } from './declaration-source-view.js';

export type ScalarOperand={label:string;metric:MetricValue}|{label:string;value:number|undefined;unit:string;note?:string|undefined};
export type ScalarEvidence=
  |{kind:'metric';label:string;metric:MetricValue;record?:unknown;note?:string|undefined}
  |{kind:'derived';label:string;value:number|undefined;unit:string;expression:string;operands:ScalarOperand[];metric?:MetricValue|undefined;diagnosticIds?:string[]|undefined;record?:unknown;note?:string|undefined}
  |{kind:'declaration';label:string;value:number|undefined;unit:string;record:unknown;note:string;expressionSource?:DeclarationSource};
export type ScalarContext=MemorySourceContext&{inputHash:string;scope:string;stepContext?:DecodeStepContext|undefined};
export type ScalarSelection={evidence:ScalarEvidence;context:ScalarContext};
export function useScalarSource(identity:unknown){
  const [selected,setSelected]=useState<{identity:unknown;selection:ScalarSelection}>();
  useEffect(()=>setSelected(old=>old?.identity===identity?old:undefined),[identity]);
  return {selection:selected&&selected.identity===identity?selected.selection:undefined,select:(evidence:ScalarEvidence,context:ScalarContext)=>setSelected({identity,selection:{evidence,context}}),close:()=>setSelected(undefined)};
}
export function scalarDisplay(value:number|undefined,unit:string,display:ReturnType<typeof useDisplayUnits>){
  if(value===undefined||!Number.isFinite(value))return '不可用';
  const known=Unit.safeParse(unit);return known.success?display.quantity(value,known.data):new Intl.NumberFormat('en-US',{maximumSignificantDigits:8}).format(value)+' '+unit;
}
export function ScalarButton({label,onClick,children}:{label:string;onClick:()=>void;children:React.ReactNode}){
  return <button className="scalar-source-button" aria-label={'查看'+label+'依据'} onClick={onClick}>{children}</button>;
}
export function ScalarSourcePanel({selection,onClose}:{selection:ScalarSelection;onClose:()=>void}){
  const display=useDisplayUnits(),container=useRef<HTMLElement>(null),[limit,setLimit]=useState(20),[raw,setRaw]=useState(false),{evidence:e,context}=selection;
  useEffect(()=>{container.current?.scrollIntoView({block:'nearest'});setLimit(20);setRaw(false);},[selection]);
  const diagnosticIds=e.kind==='derived'?e.diagnosticIds??e.metric?.diagnosticIds??[]:[];
  return <section className="scalar-source-panel" aria-label="指标推导依据" ref={container}><div className="panel-title"><h4>{e.label} · 依据</h4><button onClick={onClose}>关闭指标依据</button></div><p>{context.scope}</p><p>实际输入 <code>{context.inputHash}</code></p>{e.note&&<p>{e.note}</p>}{diagnosticIds.length>0&&<div role="status">{diagnosticIds.map(id=>{const d=context.diagnostics.find(d=>d.diagnosticId===id);return <p key={id}>{d?d.severity+' · '+d.code+' · '+d.message:'未记录此诊断文本：'+id}</p>;})}</div>}
    {e.kind==='metric'?<AllocationMetricProof key={e.label+':'+context.inputHash} label={e.label} value={e.metric} context={context}/>:<><p className="scalar-result">{scalarDisplay(e.value,e.unit,display)}<small>原始 {e.value===undefined?'不可用':e.value} {e.unit}</small></p>{e.kind==='derived'&&<><p className="scalar-expression">{e.expression}</p><p>以下列出该结果的计算式、实际操作数与原始单位。</p><ol className="scalar-operands">{e.operands.slice(0,limit).map((o,i)=><li key={i}><strong>{o.label}</strong>{'metric' in o?<><p>{display.metric(o.metric)}</p><details><summary>展开操作数来源</summary><AllocationMetricProof label={o.label} value={o.metric} context={context}/></details></>:<p>{scalarDisplay(o.value,o.unit,display)} · 原始 {o.value===undefined?'不可用':o.value} {o.unit}{o.note&&<small>{o.note}</small>}</p>}</li>)}</ol>{e.operands.length>limit&&<button onClick={()=>setLimit(n=>n+20)}>再显示 20 个操作数</button>}{e.metric&&<details><summary>原结果指标、公式与假设</summary><AllocationMetricProof label={e.label} value={e.metric} context={context}/></details>}</>}</>}
    {e.kind==='declaration'&&e.expressionSource&&<DeclarationSourceView key={context.inputHash+':'+e.label} source={e.expressionSource}/>}
    {e.record!==undefined&&<details open={raw} onToggle={event=>setRaw(event.currentTarget.open)}><summary>本项完整原始证据</summary>{raw&&<pre>{JSON.stringify(e.record,null,2)}</pre>}</details>}
  </section>;
}
