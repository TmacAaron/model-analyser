import { useFocusedTarget } from './use-focused-target.js';
import { RooflineSourcePanel,type RooflineSourceTarget } from './roofline-source-view.js';
import { rooflineActualFrame,type RooflineField } from './roofline-source.js';
import { ScalarButton } from './scalar-source.js';
import { parseTarget,targetProblem,type AnalysisFocus } from './analysis-focus.js';
import { useDisplayUnits } from './display-units.js';
import { useEffect,useMemo,useState } from 'react';
import { RooflineStudyAttempt,RooflineStudyRequest,type RooflineStudyResult,type AnalysisResult,type Scenario,type AssetDocument,type RooflineObservation,type RooflineBalance,type MetricValue } from '@model-analyser/contracts';
import { calculationInput,ENGINE_VERSION,stableStringify } from '@model-analyser/core';
import { AnalysisTargetPicker } from './analysis-target-picker.js';
import { RooflineSampleTable,RooflineTransitionEvidence,rooflineNumber as num,rooflineSeriesLabel as label,rooflineSeriesPageSize,rooflineSide as side,type ShowRooflineSource } from './roofline-study-evidence.js';
import { useIntegerStudy } from './use-integer-study.js';
import { StudyEvidenceDetails,StudyEvidencePager } from './study-evidence.js';

const colors=['#397954','#a0643f','#526db6','#97629d','#4e8a89'];
function Balance({value,onSource,prefix}:{value:RooflineBalance;prefix:string;onSource:(field:RooflineField)=>void}){
  const display=useDisplayUnits();
return value.status==='available'?<><strong>{side(value)}</strong><small><ScalarButton label={prefix+' 拐点'} onClick={()=>onSource((prefix==='硬件'?'hardware-ridge':'effective-ridge'))}>拐点 {num(value.ridgeOperationsPerByte)} op/B</ScalarButton></small><small>计算 <ScalarButton label={prefix+' 计算分量时间'} onClick={()=>onSource(prefix==='硬件'?'hardware-compute-time':'effective-compute-time')}>{display.seconds(value.computeSeconds)}</ScalarButton> / 搬运 <ScalarButton label={prefix+' 搬运分量时间'} onClick={()=>onSource(prefix==='硬件'?'hardware-memory-time':'effective-memory-time')}>{display.seconds(value.memorySeconds)}</ScalarButton></small></>:<ScalarButton label={prefix+' 不可用Balance'} onClick={()=>onSource(prefix==='硬件'?'hardware-ridge':'effective-ridge')}>不可用</ScalarButton>;}
function Plot({observations}:{observations:RooflineObservation[]}){
  const points=observations,xs=points.flatMap(o=>[o.point.arithmeticIntensity.status==='available'?o.point.arithmeticIntensity.operationsPerByte:0,...[o.effectiveBalance,o.hardwareBalance].flatMap(b=>b.status==='available'?[b.ridgeOperationsPerByte]:[])]).filter(v=>v>0),ys=points.flatMap(o=>[o.point.actualOrPredictedPerformance,o.point.computeCeiling,o.hardwareComputeCeiling].flatMap(v=>v.status==='available'&&v.quantity.value>0?[v.quantity.value]:[]));
  if(!xs.length||!ys.length)return <p>没有可绘制的正且有限点；原始数量与缺项保留在下表。</p>;
  const minX=Math.floor(Math.log10(Math.min(...xs)))-1,maxX=Math.ceil(Math.log10(Math.max(...xs)))+1,minY=Math.floor(Math.log10(Math.min(...ys)))-1,maxY=Math.ceil(Math.log10(Math.max(...ys)))+1,x=(l:number)=>60+(l-minX)/(maxX-minX)*480,y=(l:number)=>240-(l-minY)/(maxY-minY)*200;
  function roof(c:MetricValue,b:MetricValue){if(c.status!=='available'||b.status!=='available'||c.quantity.value<=0||b.quantity.value<=0)return undefined;const lc=Math.log10(c.quantity.value),lb=Math.log10(b.quantity.value);return Array.from({length:70},(_,i)=>{const a=minX+(maxX-minX)*i/69;return x(a)+','+y(Math.min(lc,lb+a));}).join(' ');}
  return <div className="roofline-study-plot"><svg role="img" aria-label="所选范围硬件与有效 Roofline" viewBox="0 0 620 290"><defs><clipPath id="study-roof-clip"><rect x="60" y="30" width="480" height="210"/></clipPath></defs><path d="M60 30 V240 H540" stroke="#a3b7a9" fill="none"/>{[minX,(minX+maxX)/2,maxX].map(v=><text key={v} x={x(v)} y="260" textAnchor="middle" fontSize="10">10^{num(v)}</text>)}{[minY,(minY+maxY)/2,maxY].map(v=><text key={v} x="55" y={y(v)+3} textAnchor="end" fontSize="9">10^{num(v)}</text>)}<g clipPath="url(#study-roof-clip)">{points.map((o,i)=>{const p=o.point,hardware=roof(o.hardwareComputeCeiling,o.hardwareMemoryBandwidth),effective=roof(p.computeCeiling,p.memoryBandwidth),c=colors[i%colors.length];return <g key={o.seriesId}><title>{label(o)} · {p.trafficBasis}</title>{hardware&&<polyline points={hardware} stroke={c} strokeWidth="1.5" strokeDasharray="6 4" fill="none"/>}{effective&&<polyline points={effective} stroke={c} strokeWidth="2" fill="none"/>}{p.arithmeticIntensity.status==='available'&&p.arithmeticIntensity.operationsPerByte>0&&p.actualOrPredictedPerformance.status==='available'&&p.actualOrPredictedPerformance.quantity.value>0&&<circle cx={x(Math.log10(p.arithmeticIntensity.operationsPerByte))} cy={y(Math.log10(p.actualOrPredictedPerformance.quantity.value))} r="4" fill={c}/>}</g>;})}</g><text x="280" y="285" textAnchor="middle" fontSize="10">Arithmetic intensity · op/B (log)</text><text x="60" y="17" fontSize="10">Performance · operation/s (log)</text></svg><div className="roofline-study-legend">{points.map((o,i)=><span key={o.seriesId} style={{color:colors[i%colors.length]}}>● {label(o)}</span>)}</div><p className="scope-note">虚线：硬件声明屋顶（可能为peak/effective/mixed）；实线：本范围可确定的用户有效屋顶；点：理论预测。聚合图可能掩盖局部瓶颈。随分类筛选和分页更新。</p></div>;
}
export function RooflineStudyView({scenario,assets,result,focus}:{scenario:Scenario;assets:AssetDocument[];result:AnalysisResult;focus?:AnalysisFocus|undefined}){
  const [sourceTarget,setSourceTarget]=useState<RooflineSourceTarget>();
  const [seriesPage,setSeriesPage]=useState(0);
  const display=useDisplayUnits(),metric=(m:MetricValue)=>m.status==='available'?(m.quantity.unit==='byte'||m.quantity.unit==='second'?display.metric(m):num(m.quantity.value)):'不可用';

  const context=useFocusedTarget(focus),target=context.id,setTarget=context.setId,[step,setStep]=useState('0'),[scan,setScan]=useState(false),[variable,setVariable]=useState('workload:batchSize'),[min,setMin]=useState('1'),[max,setMax]=useState('20'),[filter,setFilter]=useState('');
  const source=rooflineActualFrame(result,Number(step)),chosen=target,parsedTarget=parseTarget(chosen);
  const targets=useMemo(()=>{
    const fused=new Set(source?.fusions?.flatMap(f=>f.evaluation.application.memberNodeIds)??[]);
    return [{id:'model',label:'整个模型（物理聚合）'},
      ...(source?.modules??[]).map(m=>({id:'module:'+m.nodeId,label:'模块 '+m.nodeId})),
      ...(source?.nodes??[]).filter(n=>!fused.has(n.nodeId)).map(n=>({id:'node:'+n.nodeId,label:'节点 '+n.nodeId})),
      ...(source?.fusions??[]).map(f=>({id:'node:'+f.evaluation.application.nodeId,label:'融合 '+f.evaluation.application.nodeId}))];
  },[source]);
  const targetError=!source?'请求的Decode步骤不存在，未使用序列汇总替代。':context.following&&focus?.reason?focus.reason:parsedTarget?targetProblem(source,parsedTarget,true):'当前选择没有可用的Roofline目标';
  const parameters=assets.find(a=>a.assetId===scenario.model.assetId&&a.revision===scenario.model.revision)?.parameters.filter(p=>p.type==='integer')??[],variables=[['workload:batchSize','并发 batch'],['workload:queryTokensPerRequest','每请求查询长度'],scenario.workload.kind==='prefill'?['workload:pastTokensPerRequest','prefill 历史长度']:['workload:contextTokensPerRequest','decode 上下文长度'],...parameters.map(p=>['parameter:'+p.key,'模型参数 '+p.key])],selectedVariable=variables.some(v=>v[0]===variable)?variable:'workload:batchSize';
  const input=useMemo(()=>{
    try{return calculationInput(scenario,assets).canonicalInput;}
    catch{return stableStringify([scenario,assets]);}
  },[scenario,assets]);
  const key=useMemo(()=>stableStringify([input,chosen,step,scan,selectedVariable,min,max]),[input,chosen,step,scan,selectedVariable,min,max]);
  const {attempt,report,busy,cancelling,error,setError,progress,previous,start,cancel,exportFile,cancelExport,exportState}=useIntegerStudy<RooflineStudyRequest,RooflineStudyResult>(key,{
    createWorker:()=>new Worker(new URL('./roofline-study-worker.ts',import.meta.url),{type:'module'}),
    label:' Roofline 研究',filename:'roofline-study.json',
  });
  useEffect(()=>setSourceTarget(undefined),[key]);
  function run(){try{
    if(targetError)throw Error(targetError);
    if(scan&&(!min.trim()||!max.trim()))throw Error('请填写明确整数范围');
    const request=RooflineStudyRequest.parse({target:chosen==='model'?{kind:'model'}:chosen.startsWith('module:')?{kind:'module',nodeId:chosen.slice(7)}:{kind:'node',nodeId:chosen.slice(5)},...(result.decode?{decodeStep:Number(step)}:{}),...(scan?{scan:{variable:selectedVariable.startsWith('parameter:')?{kind:'parameter',parameterKey:selectedVariable.slice(10)}:{kind:'workload',field:selectedVariable.slice(9)},searchRange:{min:Number(min),max:Number(max)}}}:{})});
    setSourceTarget(undefined);setSeriesPage(0);
    start({scenario,assets,request},value=>{
      const study=RooflineStudyAttempt.parse(value);
      if(study.status==='available'){
        const {engineVersion,scenario:pinned,request:actual,analysis}=study.result;
        if(engineVersion!==ENGINE_VERSION||pinned.scenarioId!==scenario.scenarioId||stableStringify(actual)!==stableStringify(request)||
          (analysis.status==='available'&&analysis.result.inputHash!==result.inputHash)){
          throw Error('后台 Roofline 结果与当前计算输入不同');
        }
      }
      return study;
    });
  }catch(e){setError(e instanceof Error?e.message:'Roofline输入无效');}}
  const {series,seriesLabels}=useMemo(()=>{
    const seriesLabels=new Map<string,string>();
    if(report)for(const sample of [report.base,...report.samples]){
      for(const observation of sample.observations){
        if(!seriesLabels.has(observation.seriesId))seriesLabels.set(observation.seriesId,label(observation));
      }
    }
    const series=[{id:'',label:'全部分类'},...Array.from(seriesLabels,([id,label])=>({id,label}))];
    return {series,seriesLabels};
  },[report]);
  const selectedFilter=seriesLabels.has(filter)?filter:'';
  const seriesIds=useMemo(()=>new Set(selectedFilter?[selectedFilter]:series.slice(1+seriesPage*rooflineSeriesPageSize,1+(seriesPage+1)*rooflineSeriesPageSize).map(option=>option.id)),[selectedFilter,series,seriesPage]);
  const observations=useMemo(()=>report?.base.observations.filter(o=>seriesIds.has(o.seriesId))??[],[report,seriesIds]);
  const transitions=useMemo(()=>report?.transitions.filter(t=>seriesIds.has(t.seriesId))??[],[report,seriesIds]);
  const showSource:ShowRooflineSource=(observation,field,sample)=>{
    if(!report)return;
    if(sample&&sample.value===undefined){setError('请求的整数样本缺少取值，未改用基础点。');return;}
    setSourceTarget({report,seriesId:observation.seriesId,field,sampleValue:sample?.value});
  };
  return <section className="roofline-study"><h3>范围 Roofline 与参数拐点</h3><p className="scope-note">按节点、模块或模型研究。拐点为计算屋顶/带宽，不预设存在唯一长度拐点；参数变化会使旧结果失效。</p><div className="roofline-controls"><AnalysisTargetPicker label="Roofline范围" searchLabel="查找 Roofline 范围" value={chosen} targets={targets} unavailableLabel={focus?.label??chosen} disabled={busy} onChange={setTarget}/>{result.decode&&<label>Roofline decode步骤<select aria-label="Roofline decode步骤" value={step} disabled={busy} onChange={e=>setStep(e.target.value)}>{!source&&<option value={step} disabled>缺失步骤 · {step}</option>}{result.decode.steps.map(s=><option key={s.index} value={s.index}>步骤{s.index+1} · context {s.evaluatedContext}</option>)}</select></label>}</div>
    <label className="roofline-check"><input type="checkbox" aria-label="扫描 Roofline 参数拐点" checked={scan} disabled={busy} onChange={e=>setScan(e.target.checked)}/>扫描 Roofline 参数拐点</label>{scan&&<div className="roofline-controls"><label>Roofline扫描变量<select aria-label="Roofline扫描变量" value={selectedVariable} disabled={busy} onChange={e=>setVariable(e.target.value)}>{variables.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><label>最小整数<input type="number" aria-label="Roofline扫描最小值" value={min} disabled={busy} onChange={e=>setMin(e.target.value)}/></label><label>最大整数<input type="number" aria-label="Roofline扫描最大值" value={max} disabled={busy} onChange={e=>setMax(e.target.value)}/></label></div>}
    {targetError&&<p className="scope-note roofline-target-error">{targetError}</p>}<div className="asset-actions"><button disabled={busy||!!targetError} onClick={run}>计算 Roofline 拐点</button>{busy&&<button disabled={cancelling} onClick={cancel}>取消 Roofline 扫描</button>}</div><p className="scope-note">基础分析和扫描总计最多512次；其余输入固定，参数候选不写入方案。</p>{busy&&<p role="status">Roofline已完成 {progress.completed}/{progress.total}</p>}{error&&<p className="error" role="alert">{error}</p>}{previous&&<p>输入或选项已变化，旧Roofline研究已失效。</p>}{attempt?.status==='unavailable'&&attempt.diagnostics.map(d=><p className="error" key={d.diagnosticId}>{d.message}</p>)}
    {report&&<div className="roofline-study-results"><p><strong>{report.completion==='complete'?'Roofline研究完成':'Roofline研究已取消，仅保留已完成证据'}</strong>{report.base.evaluatedContext!==undefined?' · 步骤上下文 '+report.base.evaluatedContext:''}</p>
      <div className="asset-actions">
        <button disabled={exportState?.kind==='running'} onClick={exportFile}>导出 Roofline 研究 JSON</button>
        {exportState?.kind==='running'&&<><span role="status">正在后台生成 Roofline 研究 JSON…</span><button onClick={cancelExport}>取消 Roofline 导出</button></>}
        {exportState?.kind==='cancelled'&&<span role="status">Roofline 导出已取消，可用当前结果重试。</span>}
        {exportState?.kind==='error'&&<span role="alert">{exportState.message}</span>}
      </div>
      <AnalysisTargetPicker label="筛选Roofline分类" searchLabel="查找 Roofline 分类" value={selectedFilter} targets={series} unavailableLabel={selectedFilter}
        onChange={value=>{setFilter(value);setSeriesPage(0);setSourceTarget(undefined);}}/>
      {!selectedFilter&&<StudyEvidencePager label="计算分类" page={seriesPage} size={rooflineSeriesPageSize} total={seriesLabels.size}
        onChange={page=>{setSeriesPage(page);setSourceTarget(undefined);}}/>}
      <Plot observations={observations}/>
      <div className="analysis-table"><table><thead><tr><th>物理范围 / 精度</th><th>执行工作 / 流量 / 强度</th><th>硬件声明屋顶</th><th>有效屋顶</th><th>理论预测性能</th></tr></thead><tbody>{observations.map(o=><tr key={o.seriesId}><td>{label(o)}<small>{o.aggregation==='pooled'?'池化聚合，可能掩盖局部瓶颈':'单叶局部'} · {o.point.scope.aggregation}</small></td><td><ScalarButton label="Roofline 执行工作" onClick={()=>showSource(o,"operations")}>{metric(o.point.operations)} op</ScalarButton><br/><ScalarButton label="Roofline 流量" onClick={()=>showSource(o,"traffic")}>{metric(o.point.trafficBytes)}</ScalarButton><small>{o.point.trafficBasis}</small><ScalarButton label="Roofline 运算强度" onClick={()=>showSource(o,"intensity")}>{o.point.arithmeticIntensity.status==='available'?num(o.point.arithmeticIntensity.operationsPerByte)+' op/B':'强度不可用'}</ScalarButton></td><td><ScalarButton label="Roofline 硬件计算屋顶" onClick={()=>showSource(o,"hardware-compute")}>{metric(o.hardwareComputeCeiling)} op/s</ScalarButton> · {o.hardwareComputeKind}<br/><ScalarButton label="Roofline 硬件带宽" onClick={()=>showSource(o,"hardware-memory")}>{metric(o.hardwareMemoryBandwidth)} B/s</ScalarButton> · {o.hardwareMemoryKind}<Balance value={o.hardwareBalance} prefix="硬件" onSource={field=>showSource(o,field)}/></td><td><ScalarButton label="Roofline 有效计算屋顶" onClick={()=>showSource(o,"effective-compute")}>{metric(o.point.computeCeiling)} op/s</ScalarButton><br/><ScalarButton label="Roofline 有效带宽" onClick={()=>showSource(o,"effective-memory")}>{metric(o.point.memoryBandwidth)} B/s</ScalarButton><Balance value={o.effectiveBalance} prefix="有效" onSource={field=>showSource(o,field)}/></td><td><ScalarButton label="Roofline 理论预测性能" onClick={()=>showSource(o,"predicted")}>{metric(o.point.actualOrPredictedPerformance)} op/s</ScalarButton><StudyEvidenceDetails summary="指标与公式来源" render={()=> <pre>{JSON.stringify(o,null,2)}</pre>}/></td></tr>)}</tbody></table></div>{!observations.length&&<p>当前选择在基础输入下没有可用计算分类。</p>}
      <StudyEvidenceDetails summary={'基础输入、公式与诊断 · '+report.base.diagnostics.length+'项'} render={()=> <pre>{JSON.stringify({scenario:report.scenario,request:report.request,diagnostics:report.base.diagnostics},null,2)}</pre>}/>
      {report.request.scan&&<>
        <h4>整数参数拐点证据</h4>
        {transitions.map(transition=><RooflineTransitionEvidence key={transition.seriesId+':'+transition.roof} transition={transition}
          title={seriesLabels.get(transition.seriesId)??transition.seriesId}/>)}
        {report.scan?.status==='unavailable'&&report.scan.diagnostics.map(d=><p key={d.diagnosticId} className="error">{d.message}</p>)}
        <StudyEvidenceDetails className="roofline-samples" summary={'逐整数指标与诊断 · '+report.samples.length+'点'}
          render={()=> <RooflineSampleTable report={report} seriesIds={seriesIds} showSource={showSource}/>}/>
      </>}
      {sourceTarget?.report===report&&<RooflineSourcePanel key={sourceTarget.seriesId+":"+sourceTarget.field+":"+sourceTarget.sampleValue} target={sourceTarget} onClose={()=>setSourceTarget(undefined)}/>}
      {report.assumptions.map(a=><p className="scope-note" key={a}>{a}</p>)}
    </div>}
  </section>;
}
