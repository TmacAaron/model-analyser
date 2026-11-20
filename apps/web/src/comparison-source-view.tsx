import { useEffect,useMemo,useRef,useState } from 'react';
import { Unit,type ScenarioComparisonResult } from '@model-analyser/contracts';
import { AllocationMetricProof as MetricProof } from './memory-allocation-source.js';
import { comparisonRows,comparisonMetricEvidence,comparisonDeltaEvidence,comparisonCommunicationSource,type ComparisonRow } from './comparison-metrics.js';
import { useDisplayUnits } from './display-units.js';
import {CostSourceInspector,type SourceSelection} from './cost-source-view.js';
import {MemorySourceView} from './memory-source-view.js';

export type ComparisonSourceSelection={report:ScenarioComparisonResult;rowKey:string;entryIndex:number;delta:boolean};
function OperandProof({report,rowKey,row,entryIndex,label,initialDetailsOpen}:{report:ScenarioComparisonResult;rowKey:string;row:ComparisonRow|undefined;entryIndex:number;label:string;initialDetailsOpen:boolean}){
  const display=useDisplayUnits(),evidence=useMemo(()=>comparisonMetricEvidence(report,rowKey,entryIndex),[report,rowKey,entryIndex]),entry=report.entries[entryIndex],n=row?.values[entryIndex];
  const [partIndex,setPartIndex]=useState(0),[limit,setLimit]=useState(20),[expanded,setExpanded]=useState(initialDetailsOpen),[detailOpen,setDetailOpen]=useState(false);
  const parts=evidence.kind==='metric'||evidence.kind==='sum'?evidence.parts:[],part=parts[partIndex];
  const result=entry?.analysis.status==='available'?entry.analysis.result:undefined;
  const eventIndex=evidence.kind==='sum'?evidence.parts[partIndex]?.eventIndex:undefined;
  const memory=part?.targetId.startsWith('memory:')?result?.memory[Number(part.targetId.slice(7))]:undefined;
  const targetId=part?.targetId,metricId=part?.metricId;
  const sourceSelection=useMemo<SourceSelection|undefined>(()=>{
    if(eventIndex!==undefined&&result)return comparisonCommunicationSource(result,eventIndex);
    if(!targetId||!metricId||targetId.startsWith('memory:'))return;
    return {targetId,metricId,nonce:0};
  },[eventIndex,result,targetId,metricId]);
  const detailLabel=memory?'显存峰值来源':eventIndex!==undefined?'通信事件来源':targetId?.startsWith('logical:')?'逻辑工作来源':'成本运算来源';
  return <article className="comparison-source-operand" aria-label={label+'指标依据'}><h4>{label} · {entry?.scenario.name??'缺失配置'}</h4>
    {entry&&<p><code>{entry.scenario.scenarioId}</code></p>}
    <p className="comparison-source-value">{row&&n!==undefined?display.quantity(n,Unit.parse(row.unit)):'不可用'}{row&&n!==undefined&&<small>原始 {n} {row.unit}</small>}</p>
    {entry?.analysis.status==='available'&&<p>固定输入 <code>{entry.analysis.result.inputHash}</code><small>{entry.analysis.result.decode?'整个Decode序列汇总，未改选其中一步。':'单次实际分析结果。'}</small></p>}
    {entry?.analysis.status==='available'&&entry.analysis.result.decode&&rowKey.startsWith('peak:')&&<p>沿原结果查看完整序列的最坏步骤显存；没有累加各步峰值。</p>}
    {evidence.kind==='missing'&&<p role="status">{evidence.problem}</p>}
    {evidence.kind==='hardware'&&<><h5>物理设备的固定硬件容量</h5><p><code>{evidence.deviceId}</code> · <code>{evidence.hardwareRef.assetId}@r{evidence.hardwareRef.revision}</code></p>
      <p>结果记录容量：{evidence.recordedCapacity===undefined?'未记录':evidence.recordedCapacity+' byte'}。容量是固定硬件声明，不是公式求值指标。</p>
      {evidence.asset?.definition.kind==='hardware'?<><p>{evidence.asset.name} · 固定声明 {evidence.asset.definition.hardware.capacityBytes} byte</p><p>{evidence.matches?'当前结果与该固定修订声明一致。':'结果与声明不一致或缺失，不能据此补填结果。'}</p><details><summary>硬件作者来源与原始声明</summary><pre>{JSON.stringify({ref:evidence.hardwareRef,sources:evidence.asset.sources,definition:evidence.asset.definition},null,2)}</pre></details></>:<p role="status">固定快照缺少对应硬件，不能用最新修订或其他设备补填。</p>}</>}
    {evidence.kind==='sum'&&<><h5>实际通信事件的组发送合计</h5><p>{evidence.complete?'逐事件groupSendBytes相加。':'存在不可用事件或数值溢出，合计不可用；没有将缺项补零。'}</p><p>当前 {Math.min(limit,parts.length)}/{parts.length} 个事件；逐事件指标保留自身basis和来源。</p>
      <ol>{parts.slice(0,limit).map((p,i)=><li key={p.metricId}><button onClick={()=>{if(i!==partIndex)setDetailOpen(false);setPartIndex(i);setExpanded(true);}} aria-pressed={partIndex===i}>{p.label} · {display.metric(p.metric)}</button></li>)}</ol>
      {parts.length>limit&&<button onClick={()=>setLimit(n=>n+20)}>再显示 20 个通信事件</button>}
      <p>原始合计：{evidence.sum===undefined?'不可用':evidence.sum+' byte'}</p></>}
    {part&&entry?.analysis.status==='available'&&<><p>精确来源 <code>{part.targetId} / {part.metricId}</code></p><p className="scope-note">保留该指标实际记录的公式、参数、单位、假设与覆盖；共用依赖清单不代表每项独立贡献，不从当前默认值补填。</p><details className="comparison-metric-proof" open={expanded} onToggle={e=>setExpanded(e.currentTarget.open)}><summary>展开{label}公式、参数与假设</summary>{expanded&&<MetricProof key={part.targetId+':'+part.metricId} label={part.label} value={part.metric} context={{assets:report.assets,parameters:entry.analysis.result.parameterTrace,diagnostics:entry.analysis.result.diagnostics,missingParameterReason:entry.analysis.result.decode?'序列汇总涉及不同实际调用；此处未改选某一步。请在逐步分析查看该步记录的参数。':undefined}}/>}</details></>}
    {(sourceSelection||memory)&&entry&&result&&<div className="comparison-operand-source">
      <button aria-expanded={detailOpen} onClick={()=>setDetailOpen(open=>!open)}>{detailOpen?'收起':'打开'}{label}{detailLabel}</button>
      {detailOpen&&sourceSelection&&<CostSourceInspector result={result} scenario={entry.scenario} assets={report.assets} selection={sourceSelection}/>}
      {detailOpen&&memory&&<MemorySourceView memory={memory} scenario={entry.scenario} context={{assets:report.assets,parameters:result.parameterTrace,
        diagnostics:result.diagnostics,inputHash:result.inputHash,stepContext:result.stepContext,scope:label+'配置 · '+part?.label,
        missingParameterReason:result.decode?'序列峰值沿用最坏步骤。请在实际步骤查看该步参数。':undefined}}/>}
    </div>}
    {eventIndex!==undefined&&!sourceSelection&&<p>该事件缺少可核对的布局身份。上方保留汇总中的原事件记录。</p>}
  </article>;
}
export function ComparisonMetricSource({selection,onClose}:{selection:ComparisonSourceSelection;onClose:()=>void}){
  const display=useDisplayUnits(),container=useRef<HTMLElement>(null),{report,rowKey,entryIndex,delta}=selection,row=useMemo(()=>comparisonRows(report).find(r=>r.key===rowKey),[report,rowKey]),difference=useMemo(()=>comparisonDeltaEvidence(report,rowKey,entryIndex),[report,rowKey,entryIndex]);
  useEffect(()=>{container.current?.scrollIntoView({block:'nearest'});},[selection]);
  return <section className="comparison-metric-source" aria-label="比较指标来源" ref={container}><div className="panel-title"><h3>{row?.label??'缺失指标'} · {delta?'差值依据':'指标依据'}</h3><button onClick={onClose}>关闭比较指标来源</button></div>
    {delta&&<><p className="comparison-delta-proof">Δ = 当前 − 基准：{difference.current===undefined?'不可用':difference.current} − {difference.baseline===undefined?'不可用':difference.baseline} = {difference.delta===undefined?'不可用':difference.delta} {row?.unit??''}</p>{difference.delta!==undefined&&row&&<p>显示值 Δ {display.quantity(difference.delta,Unit.parse(row.unit))}</p>}{difference.problem&&<p role="status">{difference.problem}</p>}<p className="scope-note">两侧输入、单位和来源分别列出。差值表示结果之差，不自动归因为某一个参数。</p></>}
    {delta&&<OperandProof key={'baseline:'+rowKey} report={report} rowKey={rowKey} row={row} entryIndex={0} label="基准" initialDetailsOpen={false}/>}
    <OperandProof key={'current:'+entryIndex+':'+rowKey} report={report} rowKey={rowKey} row={row} entryIndex={entryIndex} label="当前" initialDetailsOpen={!delta}/>
  </section>;
}
