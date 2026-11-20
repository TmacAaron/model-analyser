import { MeasurementComparisonExports } from './measurement-report-view.js';
import { rooflinePointEvidence } from './roofline-source.js';
import { MemorySourceView } from './memory-source-view.js';
import { ScalarButton,ScalarSourcePanel,useScalarSource } from './scalar-source.js';
import { MeasurementSourceValues } from './measurement-source-view.js';
import { SelectedMemoryView } from './selected-memory-view.js';
import { ModelComputeSummary } from './model-compute-summary.js';
import { ManualMeasurementEditor } from './manual-measurement-view.js';
import { targetCost,targetProblem,targetId,sourceTargetId,type AnalysisFocus } from './analysis-focus.js';
import { useMeasurementComparisons } from './use-measurement-comparisons.js';
import { useDisplayUnits } from './display-units.js';
import { peakLocation,PeakOverrideNote } from './memory-peak-view.js';
import { useEffect,useRef,useState } from 'react';
import { MeasurementRecord,NodeId,type Scenario,type AssetDocument,type AnalysisResult,type MetricValue } from '@model-analyser/contracts';
import { calculationInput,stableStringify } from '@model-analyser/core';
import { SerialExecutionView } from './serial-execution-view.js';
import { Timeline } from './timeline-view.js';
import { useTheoreticalAnalysis } from './use-theoretical-analysis.js';
import { QuantizationApplications } from './quantization-view.js';
import { FusionResults } from './fusion-view.js';
import { CostSourceInspector,type SourceSelection } from './cost-source-view.js';
import { CostExplorer } from './cost-explorer-view.js';
import { MeasurementImportEditor } from './measurement-import-view.js';
import { TraceImportEditor } from './trace-import-view.js';
import { RooflineStudyView } from './roofline-study-view.js';

const palette=['#397954','#788c44','#477ea0','#a8784e','#8c669d'];
type AnalysisExporter=Pick<ReturnType<typeof useTheoreticalAnalysis>,'exportFile'|'exportState'|'cancelExport'>;
function AnalysisExportFeedback({exporter,step=false}:{exporter:AnalysisExporter;step?:boolean}){
  const {exportState:state,cancelExport,exportFile}=exporter;
  if(!state||(state.selection.kind==='step')!==step)return null;
  const label=state.selection.kind==='step'?'步骤 '+(state.selection.index+1)+'证据':state.selection.kind==='csv'?'成本 CSV':'结果 JSON';
  return <div className="analysis-export-status">
    {state.status==='running'?<><p role="status">正在后台准备导出{label}…</p><button onClick={cancelExport}>取消结果导出</button></>:<>
      {state.status==='error'?<p role="alert">{state.message}</p>:<p role="status">已取消结果导出。</p>}
      <button onClick={()=>exportFile(state.selection)}>重试结果导出</button>
    </>}
  </div>;
}
function DecodeView({result,onSource,focus,assets,scenario,exporter}:{assets:AssetDocument[];scenario:Scenario;result:AnalysisResult;focus?:AnalysisFocus|undefined;onSource:(targetId:string,metricId:string,step?:number)=>void;exporter:AnalysisExporter}){
  const display=useDisplayUnits(),show=display.metric;

  const [index,setIndex]=useState(0),scalar=useScalarSource(result),sequence=result.decode;if(!sequence)return null;const step=sequence.steps.find(s=>s.index===index);if(!step)return <section><p role="status">请求的Decode步骤不存在，未改选其他步骤。</p><label>查看 Decode 步骤<select aria-label="查看 Decode 步骤" value={index} onChange={e=>setIndex(Number(e.target.value))}><option value={index} disabled>缺失步骤 · {index}</option>{sequence.steps.map(s=><option key={s.index} value={s.index}>步骤 {s.index+1} · context {s.evaluatedContext}</option>)}</select></label></section>;
  const stepContext={assets,stepContext:step.result.stepContext,parameters:step.result.parameterTrace,diagnostics:step.result.diagnostics,inputHash:step.result.inputHash,scope:'实际Decode步骤 '+(step.index+1)+' · context '+step.evaluatedContext};
  const stateMetric=(label:string,value:MetricValue,record:unknown)=><ScalarButton label={label} onClick={()=>scalar.select({kind:'metric',label,metric:value,record},stepContext)}>{show(value)}</ScalarButton>;
  return <section className="decode-results"><h3>逐步 Decode 与状态版本</h3><p className="scope-note">{sequence.mode==='fixed_context'?'固定上下文近似：计算与状态容量冻结在初始上下文；不代表真实增长。':'上下文逐步增长；累计工作/流量/时间，显存取最坏步骤。'} 状态在同一 backing 中预留前后最大容量；重分配复制/转换开销须显式声明。</p><div className="analysis-table"><table><thead><tr><th>步骤</th><th>实际上下文</th><th>求值上下文</th><th>本步耗时</th><th>含状态预留峰值</th></tr></thead><tbody>{sequence.steps.map(s=><tr key={s.index}><td>{s.index+1}</td><td>{s.contextBefore} → {s.contextAfter}</td><td>{s.evaluatedContext}</td><td><button onClick={()=>onSource('model','seconds',s.index)} aria-label={'查看步骤 '+(s.index+1)+' 耗时来源'}>{show(s.result.total.seconds)}</button></td><td>{s.memory.map((m,i)=><ScalarButton key={i} label={'步骤 '+(s.index+1)+' '+(m.deviceScope.kind==='per_device'?m.deviceScope.deviceId:m.deviceScope.deviceIds.join(','))+' 含状态预留峰值'} onClick={()=>scalar.select({kind:'metric',label:'本步含状态预留峰值',metric:m.peakBytes,record:m},{assets,parameters:s.result.parameterTrace,diagnostics:s.result.diagnostics,inputHash:s.result.inputHash,scope:'实际Decode步骤 '+(s.index+1)})}>{show(m.peakBytes)}</ScalarButton>)}</td></tr>)}</tbody></table></div><label>查看 Decode 步骤<select aria-label="查看 Decode 步骤" value={index} onChange={e=>setIndex(Number(e.target.value))}>{sequence.steps.map(s=><option key={s.index} value={s.index}>步骤 {s.index+1} · context {s.evaluatedContext}</option>)}</select></label><p className="scope-note">步骤输入 <code>{step.result.inputHash.slice(0,20)}…</code> · {step.startSeconds===undefined?'绝对时刻未知':display.seconds(step.startSeconds)} → {step.endSeconds===undefined?'未知':display.seconds(step.endSeconds)}</p>
    <details open><summary>本步状态更新 · {step.stateTransitions.length} 项</summary>{step.stateTransitions.map(state=><div key={state.stateId} className="decode-state"><p><code>{state.stateId}</code> · {state.policy.kind} · {state.allocationBasis==='step_end'?'已预留本步写入容量':'按上下文边界分配'} · v{state.beforeVersion} → v{state.afterVersion} · {state.beforeInitialized?'已有数据可读':'由本步创建'}{state.afterTokenRange&&<> · token [{state.afterTokenRange.start}, {state.afterTokenRange.end})</>}</p><table><thead><tr><th>规范存储 / 设备</th><th>上步携带</th><th>调用开始预留</th><th>结束</th><th>本步预留</th></tr></thead><tbody>{state.storages.map(s=><tr key={s.storageId+'@'+s.deviceId}><td>{s.storageId} / {s.deviceId}</td><td>{s.carriedBytes?stateMetric(s.storageId+" / "+s.deviceId+" 上步携带",s.carriedBytes,state):'按边界连续'}</td><td>{stateMetric(s.storageId+" / "+s.deviceId+" 调用开始预留",s.beforeBytes,state)}</td><td>{stateMetric(s.storageId+" / "+s.deviceId+" 结束",s.afterBytes,state)}</td><td>{stateMetric(s.storageId+" / "+s.deviceId+" 本步预留",s.reservedBytes,state)}</td></tr>)}</tbody></table></div>)}</details>
    {scalar.selection&&<ScalarSourcePanel selection={scalar.selection} onClose={scalar.close}/>}
    <details><summary>本步成本、时间线与 Roofline</summary><p>{show(step.result.total.seconds)} · HBM {show(step.result.total.hbmBytes)}</p>{step.result.distributed?<SerialExecutionView result={step.result.distributed.layout} analysis={step.result} focus={focus} assets={assets} scenario={step.scenario}/>:<><div className="decode-step-memory">{step.memory.map((memory,i)=><MemorySourceView key={i} memory={memory} scenario={step.scenario} context={stepContext}/>)}</div><Timeline result={step.result} focus={focus}/></>}<Roofline result={step.result} assets={assets}/><button disabled={exporter.exportState?.status==='running'} onClick={()=>exporter.exportFile({kind:'step',index:step.index,inputHash:step.result.inputHash})}>导出当前步骤证据</button><AnalysisExportFeedback exporter={exporter} step/></details>
  </section>;
}
const format=(n:number)=>n!==0&&(Math.abs(n)<0.0001||Math.abs(n)>=1e12)?n.toExponential(3):new Intl.NumberFormat('en-US',{maximumFractionDigits:4}).format(n);
function MetricCard({label,metric,children,onSource}:{label:string;metric?:MetricValue|undefined;children?:React.ReactNode;onSource:()=>void}){
  const {metric:show}=useDisplayUnits();
return <div className="metric-card"><button className="metric-source-button" onClick={onSource} aria-label={'查看'+label+'来源'}><span>{label}</span><strong>{children??show(metric)}</strong>{metric?.status==='available'&&<small>{metric.basis} · 原始单位 {metric.quantity.unit}</small>}{metric?.status==='unavailable'&&<small>缺项未补零</small>}</button></div>;}
function Roofline({result,assets}:{result:AnalysisResult;assets:AssetDocument[]}){
  const scalar=useScalarSource(result);
  const points=result.roofline.filter(p=>p.arithmeticIntensity.status==='available'&&p.arithmeticIntensity.operationsPerByte>0).slice(0,20),xs=points.flatMap(p=>p.arithmeticIntensity.status==='available'?[p.arithmeticIntensity.operationsPerByte]:[]),ys=points.flatMap(p=>[p.roofPerformance,p.actualOrPredictedPerformance].flatMap(m=>m.status==='available'&&m.quantity.value>0?[m.quantity.value]:[]));
  if(!xs.length||!ys.length)return <p className="scope-note">Roofline 暂无有限且大于零的图点；缺项保留在诊断中。</p>;
  const minX=Math.floor(Math.log10(Math.min(...xs)))-1,maxX=Math.ceil(Math.log10(Math.max(...xs)))+1,minY=Math.floor(Math.log10(Math.min(...ys)))-1,maxY=Math.ceil(Math.log10(Math.max(...ys)))+1,x=(n:number)=>55+(Math.log10(n)-minX)/(maxX-minX)*490,y=(n:number)=>250-(Math.log10(n)-minY)/(maxY-minY)*210;
  return <><h3>分精度 Roofline</h3><div className="roofline-chart"><svg role="img" aria-label="分精度 Roofline" width="610" height="300" viewBox="0 0 610 300"><defs><clipPath id="roofline-clip"><rect x="55" y="25" width="490" height="225"/></clipPath></defs><path d="M55 25 V250 H550" fill="none" stroke="#a3b7a9"/>
    {Array.from({length:Math.min(10,maxX-minX+1)},(_,i)=>minX+i).map(v=><g key={v}><path d={`M${x(10**v)} 25 V250`} stroke="#edf2ee"/><text x={x(10**v)} y="267" textAnchor="middle" fontSize="9" fill="#7a8e7f">1e{v}</text></g>)}
    {Array.from({length:Math.min(10,maxY-minY+1)},(_,i)=>minY+i).map(v=><g key={v}><path d={`M55 ${y(10**v)} H545`} stroke="#edf2ee"/><text x="48" y={y(10**v)+3} textAnchor="end" fontSize="9" fill="#7a8e7f">1e{v}</text></g>)}
    <g clipPath="url(#roofline-clip)">{points.map((p,i)=>{if(p.arithmeticIntensity.status!=='available')return null;const intensity=p.arithmeticIntensity.operationsPerByte,color=palette[i%palette.length];const curve=p.computeCeiling.status==='available'&&p.memoryBandwidth.status==='available'?Array.from({length:70},(_,j)=>{const a=10**(minX+(maxX-minX)*j/69),c=p.computeCeiling.status==='available'?p.computeCeiling.quantity.value:0,b=p.memoryBandwidth.status==='available'?p.memoryBandwidth.quantity.value:0;return [x(a),y(Math.max(Number.MIN_VALUE,Math.min(c,b*a)))].join(',');}).join(' '):undefined;return <g key={i}><title>{p.scope.target.kind==='model'?'model':p.scope.target.nodeId} · {p.scope.deviceIds.join(', ')} · {p.computeClass.multiplyDtype.format} · {p.trafficBasis}</title>{curve&&<polyline points={curve} fill="none" stroke={color} strokeWidth="1.5" strokeOpacity="0.6"/>}{p.actualOrPredictedPerformance.status==='available'&&p.actualOrPredictedPerformance.quantity.value>0&&<circle role="button" tabIndex={0} aria-label={"查看 "+(p.scope.target.kind==="model"?"模型":p.scope.target.nodeId)+" Roofline预测性能依据"} onClick={()=>{const evidence=rooflinePointEvidence(p,"predicted");if(evidence)scalar.select(evidence,{assets,parameters:result.parameterTrace,diagnostics:result.diagnostics,inputHash:result.inputHash,scope:JSON.stringify(p.scope)});}} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();const evidence=rooflinePointEvidence(p,"predicted");if(evidence)scalar.select(evidence,{assets,parameters:result.parameterTrace,diagnostics:result.diagnostics,inputHash:result.inputHash,scope:JSON.stringify(p.scope)});}}} cx={x(intensity)} cy={y(p.actualOrPredictedPerformance.quantity.value)} r="4" fill={color}/>}</g>;})}</g><text x="280" y="289" textAnchor="middle" fontSize="10" fill="#718a79">Arithmetic intensity · operation/byte (log)</text><text x="10" y="17" fontSize="9" fill="#718a79">operation/s (log)</text></svg></div><p className="scope-note">曲线来自该节点的计算上限与内存带宽，圆点为理论预测，未冒充实测。不同设备和精度单独归类；每类使用该叶节点完整流量作为共享流量假设。最多展示 20 个点；点击预测点查看其实际依据。</p>{scalar.selection&&<ScalarSourcePanel selection={scalar.selection} onClose={scalar.close}/>}</>;
}
export function AnalysisView({scenario,assets,measurements,onMeasurement,onMeasurements,autoRunKey,onResult,focus}:{scenario:Scenario;assets:AssetDocument[];measurements:MeasurementRecord[];onMeasurement:(record:MeasurementRecord)=>void;onMeasurements:(records:MeasurementRecord[])=>void;autoRunKey?:number;focus?:AnalysisFocus|undefined;onResult?:(result:AnalysisResult|null)=>void}){
  const display=useDisplayUnits(),show=display.metric;

  let key:string;try{key=calculationInput(scenario,assets).canonicalInput;}catch{key=stableStringify({scenario,assets});}
  const analysis=useTheoreticalAnalysis(scenario,assets,key),{attempt,result,busy,error,previous,run,cancel,exportFile,exportState}=analysis;
  useEffect(()=>{onResult?.(result);},[result,onResult]);
  useEffect(()=>{if(autoRunKey)run();},[autoRunKey]);
  const [measurementPage,setMeasurementPage]=useState(0),allRecords=measurements.filter(m=>m.scenarioId===scenario.scenarioId).toReversed(),pageCount=Math.max(1,Math.ceil(allRecords.length/20)),page=Math.min(measurementPage,pageCount-1),records=allRecords.slice(page*20,(page+1)*20),measurementKey=stableStringify(records);
  const comparison=useMeasurementComparisons(scenario,assets,result,records,stableStringify([scenario.scenarioId,key,measurementKey])),comparisons=comparison.items;
  const memorySection=useRef<HTMLDivElement>(null);
  const [sourceSelection,setSourceSelection]=useState<SourceSelection>();
  function openSource(targetId:string,metricId:string,step?:number){setSourceSelection(old=>({targetId,metricId,...(step!==undefined?{step}:{}),nonce:(old?.nonce??0)+1}));}
  const focusedCost=result&&focus?.target?targetCost(result,focus.target):undefined,focusError=focus?.reason??(result&&focus?.target?targetProblem(result,focus.target):undefined);
  const peak=result?.memory.some(m=>m.peakBytes.status==='unavailable')?result.memory.find(m=>m.peakBytes.status==='unavailable')?.peakBytes:result?.memory.reduce<MetricValue|undefined>((best,m)=>m.peakBytes.status==='available'&&(best?.status!=='available'||m.peakBytes.quantity.value>best.quantity.value)?m.peakBytes:best,undefined);
  const source=result?[result.total.seconds,result.total.logicalReadBytes,result.total.logicalWriteBytes,result.total.hbmBytes,...result.total.compute.map(c=>c.usefulOperations)].find(m=>m.status==='available'):undefined;
  return <section className="analysis-panel"><div className="panel-title"><div><h2>理论分析与测量比较</h2><small>单步/逐步 Decode；串行或指定多流，多卡需显式布局与局部方程，不支持的配置明确报缺项</small></div><button onClick={run} disabled={busy}>{busy?'计算中…':'计算理论结果'}</button></div>
    {busy&&<button onClick={cancel}>取消理论分析</button>}{error&&<p className="error" role="alert">{error}</p>}
    <MeasurementImportEditor scenario={scenario} assets={assets} result={result} measurements={measurements} onApply={onMeasurements}/>
    <TraceImportEditor scenario={scenario} assets={assets} result={result} onApply={onMeasurements}/>
    {!attempt&&<p className="scope-note">{previous?'输入已变化，旧结果已失效，请重新计算。':'从固定快照计算叶节点、模块汇总、生命周期显存与 Roofline。'}</p>}
    {attempt?.status==='unavailable'&&<div className="error" role="alert">{attempt.diagnostics.map(d=><p key={d.diagnosticId}>{d.code} · {d.message}</p>)}</div>}
    {result&&<>{focus&&<section className="analysis-focus"><h3>画布选择 · {focus.label}</h3>{focus.target&&<code>{targetId(focus.target)}</code>}{focusError?<p role="status">{focusError}</p>:focusedCost?<><p>所选范围耗时 {show(focusedCost.seconds)} · HBM {show(focusedCost.hbmBytes)}</p><button onClick={()=>focus.target&&openSource(sourceTargetId(result,focus.target),'seconds')}>查看画布选择的成本来源</button></>:<p>等待此目标的结果。</p>}<button onClick={()=>memorySection.current?.scrollIntoView({block:'start'})}>查看所选范围存储</button><small>成本、显存参与关系、时间线、Roofline和测量带入当前选择，可分别改选；全模型概览与所选范围分开。</small></section>}<p className="scope-note">{result.phase} · {result.scope.aggregation} · {result.scope.deviceIds.join(', ')} · {result.decode?result.decode.steps.length+' 个 decode 步骤累计':'一个明确步骤'}</p>{focus&&<h3>全模型概览</h3>}<div className="analysis-cards"><ModelComputeSummary key={result.inputHash} result={result} onSource={openSource}/><MetricCard onSource={()=>openSource('model','seconds')} label={result.distributed?.layout.execution.status==='available'&&result.distributed.layout.execution.result.policy==='streams'?'理论耗时 · 多流':'理论耗时 · 串行'} metric={result.total.seconds}/><MetricCard onSource={()=>openSource('model','hbm')} label="估计 HBM 流量" metric={result.total.hbmBytes}/><MetricCard onSource={()=>openSource('memory:'+Math.max(0,result.memory.findIndex(m=>m.peakBytes===peak)),'peak')} label={result.distributed?'最大每卡生命周期峰值':'生命周期显存峰值'} metric={peak}/></div>
      <div className="analysis-identity"><code>input {result.inputHash.slice(0,20)}…</code><small>engine {result.engineVersion}</small><button disabled={exportState?.status==='running'} onClick={()=>exportFile({kind:'json'})}>导出结果 JSON</button><button disabled={exportState?.status==='running'} onClick={()=>exportFile({kind:'csv'})}>{result.fusions?.length?'导出执行成本 CSV':'导出叶成本 CSV'}</button></div><AnalysisExportFeedback exporter={analysis}/>
      <CostSourceInspector key={'sources:'+result.inputHash} result={result} scenario={scenario} assets={assets} selection={sourceSelection}/>
      <DecodeView exporter={analysis} result={result} onSource={openSource} focus={focus} assets={assets} scenario={scenario}/><FusionResults result={result} onSource={openSource}/><QuantizationApplications applications={result.quantizationApplications??[]}/>{!!result.diagnostics.length&&<details className="analysis-diagnostics" open={result.diagnostics.some(d=>d.severity==='error')}><summary>结果诊断 · {result.diagnostics.length} 项</summary>{result.diagnostics.map(d=><p key={d.diagnosticId}>{d.severity} · {d.code} · {d.message}</p>)}</details>}
      {result.distributed&&<p className="scope-note distributed-cost-note">设备组成本累加物理工作与流量，复制执行可能增加组总工作；上方模型一次有效工作量用于 MFU，不按卡数重复增加。节点耗时是最慢参与设备的屏障时间。模块仅汇总其图叶节点，方案通信在模型层单列。</p>}<CostExplorer focus={focus} key={'costs:'+result.inputHash} result={result} scenario={scenario} assets={assets}/>
      <details><summary>模块汇总（不与叶节点再次累加）</summary>{result.modules.map(m=><p key={m.nodeId}><button onClick={()=>openSource('module:'+m.nodeId,'seconds')}>查看模块耗时来源</button><code>{m.nodeId}</code> · {m.leafNodeIds.length} 个叶节点 · {show(m.cost.seconds)}</p>)}</details>
      {!result.distributed&&result.memory.map((m,i)=><MemorySourceView key={i} memory={m} scenario={scenario} context={{assets,stepContext:result.stepContext,parameters:result.parameterTrace,diagnostics:result.diagnostics,inputHash:result.inputHash,scope:"完整模型显存，未按所选模块分摊",missingParameterReason:result.decode?"序列各步参数不同；请选择实际步骤查看参数。":undefined}}/>)}
      <div ref={memorySection}><SelectedMemoryView result={result} focus={focus} assets={assets}/></div>
      {result.distributed?<SerialExecutionView result={result.distributed.layout} analysis={result} focus={focus} assets={assets} scenario={scenario}/>:<Timeline result={result} focus={focus}/>}{!result.decode&&<Roofline result={result} assets={assets}/>}
      <RooflineStudyView focus={focus} scenario={scenario} assets={assets} result={result}/>
      {allRecords.length>0&&<label>测量记录 · {allRecords.length} 条<select aria-label="测量记录页" value={page} onChange={e=>setMeasurementPage(Number(e.target.value))}>{Array.from({length:pageCount},(_,i)=><option key={i} value={i}>最新记录 {i*20+1}–{Math.min((i+1)*20,allRecords.length)}</option>)}</select></label>}
      {comparison.status!=='idle'&&<div className="measurement-comparison-status" role="status"><p>当前页测量比较 · {comparisons.length}/{comparison.total} · {comparison.status==='running'?'后台比较中，当前为部分结果':comparison.status==='complete'?'已完成':comparison.status==='cancelled'?'已取消，保留已完成项':'失败，保留已完成项'}</p>{comparison.error&&<p role="alert">{comparison.error}</p>}{comparison.status==='running'?<button onClick={comparison.cancel}>取消测量比较</button>:(comparison.status==='cancelled'||comparison.status==='error')&&<button onClick={comparison.retry}>重试测量比较</button>}</div>}
      {records.length>0&&<MeasurementComparisonExports result={result} scenario={scenario} assets={assets} records={records} items={comparisons} offset={page*20} totalRecords={allRecords.length} completion={comparison.status} error={comparison.error}/>}<div className="comparison-list">{comparisons.map(({id,attempt})=><div key={id} className="measurement-comparison">{attempt.status==='unavailable'?<p>{id} · {attempt.diagnostics.at(-1)?.message}</p>:<><strong>同范围比较 · {attempt.comparison.scope.target.kind}{attempt.comparison.scope.target.kind==='model'?'':' '+attempt.comparison.scope.target.nodeId}</strong><MeasurementSourceValues record={allRecords.find(r=>r.measurementId===id)} comparison={attempt.comparison} result={result} scenario={scenario} assets={assets}/><small>{id} · MFU {attempt.comparison.mfuScope?.aggregation??attempt.comparison.scope.aggregation} · MBU {attempt.comparison.mbuScope?.aggregation??attempt.comparison.scope.aggregation} · time kind={attempt.comparison.normalizedTime.kind} · count={attempt.comparison.normalizedTime.count} · input {attempt.comparison.inputHash.slice(0,12)}</small><details className="measurement-record-proof"><summary>测量原始范围与统计</summary><pre>{JSON.stringify(allRecords.find(r=>r.measurementId===id),null,2)}</pre></details>{!!attempt.comparison.diagnostics.length&&<details><summary>比较诊断 · {attempt.comparison.diagnostics.length} 项</summary>{attempt.comparison.diagnostics.map(d=><p key={d.diagnosticId}>{d.severity} · {d.code} · {d.message}</p>)}</details>}</>}</div>)}</div>
      <details><summary>公式、参数来源与假设</summary>{source&&<><h4>依赖修订</h4>{source.provenance.assetRefs.map(r=><p key={r.assetId+'@'+r.revision}><code>{r.assetId}@{r.revision}</code></p>)}<h4>参数来源</h4>{source.provenance.parameterSources.map((p,i)=><p key={i}>{p.parameterKey} · {p.source}</p>)}<h4>计算假设</h4>{source.provenance.assumptions.map((text,i)=><p key={i}>{text}</p>)}</>}</details>
    </>}
    <ManualMeasurementEditor key={scenario.scenarioId+':'+scenario.model.assetId} result={result} scenario={scenario} focus={focus} onRecord={onMeasurement}/>
  </section>;
}









