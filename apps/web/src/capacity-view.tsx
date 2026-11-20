import { useEffect,useMemo,useRef,useState } from 'react';
import { CapacitySearchAttempt,CapacitySearchRequest,type AssetDocument,type CapacitySearchResult,type Scenario } from '@model-analyser/contracts';
import { calculationInput,ENGINE_VERSION,hashCanonicalInput,MAX_CAPACITY_POINTS,stableStringify } from '@model-analyser/core';
import { CapacitySourcePanel,capacityMaximumEvidence,type CapacitySourceTarget } from './capacity-source-view.js';
import { ScalarButton,ScalarSourcePanel,useScalarSource } from './scalar-source.js';
import { CapacityChart } from './capacity-chart.js';
import { CapacityEvidence } from './capacity-evidence.js';
import { useIntegerStudy } from './use-integer-study.js';

const labels={batchSize:'并发 batch',queryTokensPerRequest:'每请求查询长度',pastTokensPerRequest:'prefill 历史长度',contextTokensPerRequest:'decode 上下文长度'};
const numbers=new Intl.NumberFormat('en-US',{maximumFractionDigits:3});
const number=(n:number)=>n!==0&&(Math.abs(n)<0.001||Math.abs(n)>=1e12)?n.toExponential(3):numbers.format(n);

export function CapacityView({scenario,assets}:{scenario:Scenario;assets:AssetDocument[]}){
  const input=useMemo(()=>{
    try{return calculationInput(scenario,assets).canonicalInput;}
    catch{return stableStringify({scenario,assets});}
  },[scenario,assets]);
  const root=assets.find(asset=>asset.assetId===scenario.model.assetId&&asset.revision===scenario.model.revision);
  const parameters=root?.parameters.filter(parameter=>parameter.type==='integer')??[];
  const [variable,setVariable]=useState('workload:batchSize'),[min,setMin]=useState('1'),[max,setMax]=useState('128');
  const choices=['workload:batchSize','workload:queryTokensPerRequest',scenario.workload.kind==='prefill'?'workload:pastTokensPerRequest':'workload:contextTokensPerRequest',...parameters.map(parameter=>'parameter:'+parameter.key)];
  const selected=choices.includes(variable)?variable:'workload:batchSize';
  const runKey=useMemo(()=>stableStringify([input,selected,min,max]),[input,selected,min,max]);
  const {attempt,report,busy,cancelling,error,setError,progress,previous,start,cancel,exportFile,cancelExport,exportState}=useIntegerStudy<CapacitySearchRequest,CapacitySearchResult>(runKey,{
    createWorker:()=>new Worker(new URL('./capacity-worker.ts',import.meta.url),{type:'module'}),
    label:'容量搜索',filename:'model-analyser-capacity.json',
  });
  const [pointSource,setPointSource]=useState<CapacitySourceTarget>();
  const pinnedAssets=useRef(assets);
  const scalar=useScalarSource(report),status=report?.capacityStatus,sourceAssets=pinnedAssets.current;
  useEffect(()=>setPointSource(undefined),[runKey]);

  function run(){
    try{
      if(!min.trim()||!max.trim())throw Error('请填写明确的整数范围');
      const request=CapacitySearchRequest.parse({
        variable:selected.startsWith('parameter:')?{kind:'parameter',parameterKey:selected.slice(10)}:{kind:'workload',field:selected.slice(9)},
        searchRange:{min:Number(min),max:Number(max)},
      });
      const total=request.searchRange.max-request.searchRange.min+1;
      if(total<1||total>MAX_CAPACITY_POINTS)throw Error(`搜索范围需有序，且不超过 ${MAX_CAPACITY_POINTS} 个整数`);
      setPointSource(undefined);
      pinnedAssets.current=assets;
      const expectedHash=hashCanonicalInput(input).catch(()=>undefined);
      start({scenario,assets,request},async value=>{
        const result=CapacitySearchAttempt.parse(value);
        if(result.status==='available'){
          const expected=await expectedHash;
          const {engineVersion,baseScenario,baseInputHash,request:actual}=result.result;
          if(!expected||baseInputHash!==expected||engineVersion!==ENGINE_VERSION||baseScenario.scenarioId!==scenario.scenarioId||stableStringify(actual)!==stableStringify(request)){
            throw Error('后台容量搜索结果与当前配置或搜索区间不同');
          }
        }
        return result;
      },total);
    }catch(failure){
      setError(failure instanceof Error?failure.message:'无效搜索参数');
    }
  }

  return <section className="capacity-panel">
    <div className="panel-title"><div><h2>容量搜索与整数扫描</h2><small>固定其他输入，在显式范围逐点重算</small></div></div>
    <div className="capacity-form">
      <label>求解变量<select aria-label="容量求解变量" value={selected} disabled={busy} onChange={event=>setVariable(event.target.value)}>
        {Object.entries(labels).filter(([field])=>field in scenario.workload).map(([field,label])=><option key={field} value={'workload:'+field}>{label}</option>)}
        {parameters.map(parameter=><option key={parameter.key} value={'parameter:'+parameter.key}>模型参数 {parameter.key}</option>)}
      </select></label>
      <label>最小值<input aria-label="容量搜索最小值" type="number" min="0" step="1" value={min} disabled={busy} onChange={event=>setMin(event.target.value)}/></label>
      <label>最大值<input aria-label="容量搜索最大值" type="number" min="0" step="1" value={max} disabled={busy} onChange={event=>setMax(event.target.value)}/></label>
      <button type="button" onClick={run} disabled={busy}>搜索容量</button>
      {busy&&<button type="button" onClick={cancel} disabled={cancelling}>{cancelling?'正在取消…':'取消搜索'}</button>}
    </div>
    <p className="scope-note">每次最多 {MAX_CAPACITY_POINTS} 个整数，在后台计算。模型参数搜索只替换该根参数的绑定与覆盖。更改输入会终止搜索并使旧结果失效。</p>
    {!!(scenario.memoryPeakOverrides?.length||scenario.numericOverrides.some(override=>override.target.kind==='device'&&override.field==='memory_bytes'))&&
      <p className="scope-note">当前容量按生效的用户总峰值覆盖判断；原理论分配与缺项保留在分析结果中。覆盖不提供分类或实际峰值时刻。</p>}
    {!!scenario.modulePeakOverrides?.length&&<p className="scope-note">模块私有预算按当前调用跨度和物理设备重算，保留权重、KV、边界与共享对象；重叠预算叠加。整数边界使用含预算的保守峰值。</p>}
    {busy&&<p role="status">已完成 {progress.completed}/{progress.total} 点</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    {previous&&<p className="scope-note">输入已变化，旧容量搜索已失效。</p>}
    {attempt?.status==='unavailable'&&<div className="error" role="alert">{attempt.diagnostics.map(diagnostic=><p key={diagnostic.diagnosticId}>{diagnostic.code} · {diagnostic.message}</p>)}</div>}
    {report&&<>
      <div className="capacity-summary">
        {status?.kind==='solved'?<>
          <strong><ScalarButton label="区间最大容量" onClick={()=>scalar.select(capacityMaximumEvidence(report,sourceAssets),{
            assets:sourceAssets,parameters:undefined,diagnostics:report.diagnostics,inputHash:report.baseInputHash,
            scope:'原容量扫描固定输入；区间极值不是某个单次分配。',
          })}>区间内最大可容纳值：{number(status.maximum)}</ScalarButton></strong>
          <p>变量 {status.solveVariable} · 区间 [{status.searchRange.min}, {status.searchRange.max}] · 限制/最紧设备 {status.limitingDeviceIds.join(', ')}</p>
        </>:<strong>{report.completion==='cancelled'?'搜索已取消，未证明最大容量':'当前证据无法确定最大容量'}</strong>}
        <small>{report.completion} · 已计算 {report.points.length} 点 · {report.method} · engine {report.engineVersion} · base input {report.baseInputHash.slice(0,16)}</small>
        <div className="asset-actions">
          <button type="button" onClick={exportFile} disabled={exportState?.kind==='running'}>导出容量搜索 JSON</button>
          {exportState?.kind==='running'&&<><span role="status">正在后台生成容量搜索 JSON…</span><button type="button" onClick={cancelExport}>取消容量导出</button></>}
          {exportState?.kind==='cancelled'&&<span role="status">容量导出已取消，可用当前结果重试。</span>}
          {exportState?.kind==='error'&&<span role="alert">{exportState.message}</span>}
        </div>
      </div>
      {report.diagnostics.map(diagnostic=><p key={diagnostic.diagnosticId} className="scope-note">{diagnostic.code} · {diagnostic.message}</p>)}
      {!!report.points.length&&<div className="capacity-chart"><CapacityChart points={report.points}/></div>}
      <CapacityEvidence report={report} onSource={setPointSource}/>
      {scalar.selection&&<ScalarSourcePanel selection={scalar.selection} onClose={scalar.close}/>}
      {pointSource?.report===report&&<CapacitySourcePanel key={report.baseInputHash+':'+pointSource.pointValue+':'+pointSource.field.kind+('deviceId' in pointSource.field?pointSource.field.deviceId:'')}
        target={pointSource} assets={sourceAssets} onClose={()=>setPointSource(undefined)}/>}
    </>}
  </section>;
}
