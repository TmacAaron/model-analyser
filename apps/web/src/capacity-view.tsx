import { CapacitySourcePanel,capacityMaximumEvidence,type CapacitySourceTarget } from './capacity-source-view.js';
import { ScalarButton,ScalarSourcePanel,useScalarSource } from './scalar-source.js';
import { useDisplayUnits } from './display-units.js';
import { displayBytes } from './display-format.js';
import { useEffect,useRef,useState } from 'react';
import { CapacitySearchAttempt,CapacitySearchRequest,type Scenario,type AssetDocument,type CapacitySearchPoint } from '@model-analyser/contracts';
import { calculationInput,stableStringify,MAX_CAPACITY_POINTS } from '@model-analyser/core';
import type { CapacityWorkerRequest,CapacityWorkerResponse } from './capacity-worker.js';

const labels={batchSize:'并发 batch',queryTokensPerRequest:'每请求查询长度',pastTokensPerRequest:'prefill 历史长度',contextTokensPerRequest:'decode 上下文长度'};
const number=(n:number)=>n!==0&&(Math.abs(n)<0.001||Math.abs(n)>=1e12)?n.toExponential(3):new Intl.NumberFormat('en-US',{maximumFractionDigits:3}).format(n);
function pointMemory(point:CapacitySearchPoint,bytes:(value:number)=>string=displayBytes){return point.status==='available'?point.memory.map(m=>m.deviceId+': '+(m.peakBytes.status==='available'?bytes(m.peakBytes.quantity.value)+' / '+bytes(m.capacityBytes):'未知')).join('; '):'不可计算';}
function chart(points:CapacitySearchPoint[],display:ReturnType<typeof useDisplayUnits>){
  const values=points.flatMap(p=>p.status==='available'?p.memory.flatMap(m=>m.peakBytes.status==='available'?[m.peakBytes.quantity.value,m.capacityBytes]:[]):[]),max=Math.max(1,...values),first=points[0]?.value??0,last=points.at(-1)?.value??first,x=(v:number)=>55+(v-first)/Math.max(1,last-first)*475,y=(v:number)=>195-v/max*155;
  return <svg role="img" aria-label="容量搜索显存曲线" width="600" height="235" viewBox="0 0 600 235"><path d="M55 25 V195 H540" fill="none" stroke="#a3b7a9"/><text x="55" y="16" fontSize="10" fill="#718a79">峰值 · 上限 {display.bytes(max)} · 每个整数点</text><text x="55" y="215" fontSize="10" fill="#718a79">{first}</text><text x="530" y="215" fontSize="10" fill="#718a79">{last}</text>{points.flatMap(p=>p.status==='available'?p.memory.map((m,i)=><g key={p.value+':'+m.deviceId}><title>{p.value} · {pointMemory(p,display.bytes)}</title><line x1={x(p.value)-2} x2={x(p.value)+2} y1={y(m.capacityBytes)} y2={y(m.capacityBytes)} stroke="#b27450"/>{m.peakBytes.status==='available'&&<circle cx={x(p.value)} cy={y(m.peakBytes.quantity.value)} r={points.length>200?1.5:3} fill={p.fit==='fits'?'#397954':'#bd704f'} data-device={i}/>}</g>):[])}<text x="160" y="232" fontSize="10" fill="#718a79">绿色可容纳 · 橙色超容量 · 短线为设备容量</text></svg>;
}
export function CapacityView({scenario,assets}:{scenario:Scenario;assets:AssetDocument[]}){
  const display=useDisplayUnits(),memory=(point:CapacitySearchPoint)=>pointMemory(point,display.bytes);
  let key:string;try{key=calculationInput(scenario,assets).canonicalInput;}catch{key=stableStringify({scenario,assets});}
  const root=assets.find(a=>a.assetId===scenario.model.assetId&&a.revision===scenario.model.revision),parameters=root?.parameters.filter(p=>p.type==='integer')??[];
  const [variable,setVariable]=useState('workload:batchSize'),[min,setMin]=useState('1'),[max,setMax]=useState('128'),[busy,setBusy]=useState(false),[cancelling,setCancelling]=useState(false),[progress,setProgress]=useState({completed:0,total:0}),[error,setError]=useState(''),[cached,setCached]=useState<{key:string;attempt:CapacitySearchAttempt;assets:AssetDocument[]}|null>(null);
  const choices=['workload:batchSize','workload:queryTokensPerRequest',scenario.workload.kind==='prefill'?'workload:pastTokensPerRequest':'workload:contextTokensPerRequest',...parameters.map(p=>'parameter:'+p.key)],selected=choices.includes(variable)?variable:'workload:batchSize',runKey=stableStringify([key,selected,min,max]);
  const [pointSource,setPointSource]=useState<CapacitySourceTarget>();
  const worker=useRef<Worker|null>(null),current=useRef(runKey);current.current=runKey;
  useEffect(()=>{worker.current?.terminate();worker.current=null;setBusy(false);setCancelling(false);setError('');setPointSource(undefined);},[runKey]);
  useEffect(()=>()=>worker.current?.terminate(),[]);
  function run(){
    try{
      if(!min.trim()||!max.trim())throw Error('请填写明确的整数范围');
      const request=CapacitySearchRequest.parse({variable:selected.startsWith('parameter:')?{kind:'parameter',parameterKey:selected.slice(10)}:{kind:'workload',field:selected.slice(9)},searchRange:{min:Number(min),max:Number(max)}});
      if(request.searchRange.max<request.searchRange.min||request.searchRange.max-request.searchRange.min+1>MAX_CAPACITY_POINTS)throw Error(`搜索范围需有序，且不超过 ${MAX_CAPACITY_POINTS} 个整数`);
      worker.current?.terminate();const sourceAssets=assets,instance=new Worker(new URL('./capacity-worker.ts',import.meta.url),{type:'module'}),snapshot=runKey;worker.current=instance;setBusy(true);setCancelling(false);setError('');setCached(null);setPointSource(undefined);setProgress({completed:0,total:request.searchRange.max-request.searchRange.min+1});
      instance.onmessage=(event:MessageEvent<CapacityWorkerResponse>)=>{if(worker.current!==instance||current.current!==snapshot)return;const message=event.data;if(message.kind==='progress'){setProgress({completed:message.completed,total:message.total});return;}
        try{setCached({key:snapshot,attempt:CapacitySearchAttempt.parse(message.attempt),assets:sourceAssets});}catch{setError('搜索线程返回了无效结果');}setBusy(false);setCancelling(false);instance.terminate();worker.current=null;
      };
      instance.onerror=()=>{if(worker.current!==instance)return;setError('后台搜索失败，请重试或缩小范围');setBusy(false);setCancelling(false);instance.terminate();worker.current=null;};
      const message:CapacityWorkerRequest={kind:'start',scenario,assets,request};instance.postMessage(message);
    }catch(e){worker.current?.terminate();worker.current=null;setBusy(false);setCancelling(false);setError(e instanceof Error?e.message:'无效搜索参数');}
  }
  function cancel(){const message:CapacityWorkerRequest={kind:'cancel'};worker.current?.postMessage(message);setCancelling(true);}
  const attempt=cached?.key===runKey?cached.attempt:null,r=attempt?.status==='available'?attempt.result:null,status=r?.capacityStatus;
  const scalar=useScalarSource(r),sourceAssets=cached?.assets??assets;
  const sourceContext={assets:sourceAssets,parameters:undefined,diagnostics:r?.diagnostics??[],inputHash:r?.baseInputHash??'',scope:'原容量扫描固定输入；区间极值不是某个单次分配。'};
  function exportResult(){if(!r)return;const url=URL.createObjectURL(new Blob([JSON.stringify(r,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='model-analyser-capacity.json';link.click();URL.revokeObjectURL(url);}
  return <section className="capacity-panel"><div className="panel-title"><div><h2>容量搜索与整数扫描</h2><small>固定其他输入，在显式范围逐点重算；不假定单调性</small></div></div>
    <div className="capacity-form"><label>求解变量<select aria-label="容量求解变量" value={selected} disabled={busy} onChange={e=>setVariable(e.target.value)}>{Object.entries(labels).filter(([field])=>field in scenario.workload).map(([field,label])=><option key={field} value={'workload:'+field}>{label}</option>)}{parameters.map(p=><option key={p.key} value={'parameter:'+p.key}>模型参数 {p.key}</option>)}</select></label><label>最小值<input aria-label="容量搜索最小值" type="number" min="0" step="1" value={min} disabled={busy} onChange={e=>setMin(e.target.value)}/></label><label>最大值<input aria-label="容量搜索最大值" type="number" min="0" step="1" value={max} disabled={busy} onChange={e=>setMax(e.target.value)}/></label><button onClick={run} disabled={busy}>搜索容量</button>{busy&&<button onClick={cancel} disabled={cancelling}>{cancelling?'正在取消…':'取消搜索'}</button>}</div>
    <p className="scope-note">每次最多 {MAX_CAPACITY_POINTS} 个整数，在后台计算，不修改当前方案。模型参数搜索只替换该根参数的绑定与覆盖；其他节点参数保持原配置。更改输入会终止搜索并使旧结果失效。</p>
    {(scenario.memoryPeakOverrides?.length||scenario.numericOverrides.some(o=>o.target.kind==='device'&&o.field==='memory_bytes'))&&<p className="scope-note">当前容量按生效的用户总峰值覆盖判断；原理论分配与缺项保留在分析结果中。覆盖不提供分类或实际峰值时刻。</p>}
    {!!scenario.modulePeakOverrides?.length&&<p className="scope-note">模块私有预算按当前调用跨度和物理设备重算，保留权重、KV、边界与共享对象；重叠预算叠加。整数边界使用含预算的保守峰值。</p>}
    {busy&&<p role="status">已完成 {progress.completed}/{progress.total} 点</p>}{error&&<p className="error" role="alert">{error}</p>}{cached&&!attempt&&<p className="scope-note">输入已变化，旧容量搜索已失效。</p>}
    {attempt?.status==='unavailable'&&<div className="error" role="alert">{attempt.diagnostics.map(d=><p key={d.diagnosticId}>{d.code} · {d.message}</p>)}</div>}
    {r&&<><div className="capacity-summary">{status?.kind==='solved'?<><strong><ScalarButton label="区间最大容量" onClick={()=>scalar.select(capacityMaximumEvidence(r,sourceAssets),sourceContext)}>区间内最大可容纳值：{number(status.maximum)}</ScalarButton></strong><p>变量 {status.solveVariable} · 区间 [{status.searchRange.min}, {status.searchRange.max}] · 限制/最紧设备 {status.limitingDeviceIds.join(', ')}</p></>:<strong>{r.completion==='cancelled'?'搜索已取消，未证明最大容量':'当前证据无法确定最大容量'}</strong>}<small>{r.completion} · 已计算 {r.points.length} 点 · {r.method} · engine {r.engineVersion} · base input {r.baseInputHash.slice(0,16)}</small><button onClick={exportResult}>导出容量搜索 JSON</button></div>
      {r.diagnostics.map(d=><p key={d.diagnosticId} className="scope-note">{d.code} · {d.message}</p>)}
      {!!r.points.length&&<div className="capacity-chart">{chart(r.points,display)}</div>}
      <div className="analysis-table capacity-table"><table><thead><tr><th>变量值</th><th>容量判定</th><th>设备峰值 / 容量</th><th>理论耗时</th><th>证据</th></tr></thead><tbody>{r.points.map(p=><tr key={p.value}><td>{p.value}</td><td>{p.status==='unavailable'?'不可计算':p.fit==='fits'?'可容纳':p.fit==='exceeds'?'超容量':'缺项'}</td><td>{p.status==='available'?p.memory.map(m=><div key={m.deviceId}>{m.deviceId}: <ScalarButton label={'整数 '+p.value+' '+m.deviceId+' 峰值'} onClick={()=>setPointSource({report:r,pointValue:p.value,field:{kind:'peak',deviceId:m.deviceId}})}>{display.metric(m.peakBytes)}</ScalarButton> / <ScalarButton label={'整数 '+p.value+' '+m.deviceId+' 容量'} onClick={()=>setPointSource({report:r,pointValue:p.value,field:{kind:'capacity',deviceId:m.deviceId}})}>{display.bytes(m.capacityBytes)}</ScalarButton></div>):'不可计算'}</td><td><ScalarButton label={'整数 '+p.value+' 理论耗时'} onClick={()=>setPointSource({report:r,pointValue:p.value,field:{kind:'seconds'}})}>{p.status==='available'?display.metric(p.seconds):'不可用'}</ScalarButton></td><td><details><summary>{p.status==='available'?p.inputHash.slice(0,8)+'…':'计算错误'} · {p.diagnostics.length} 诊断</summary>{p.diagnostics.map(d=><p key={d.diagnosticId}>{d.code} · {d.message}</p>)}</details></td></tr>)}</tbody></table></div>
      {scalar.selection&&<ScalarSourcePanel selection={scalar.selection} onClose={scalar.close}/>}
      {pointSource?.report===r&&<CapacitySourcePanel key={r.baseInputHash+":"+pointSource.pointValue+":"+pointSource.field.kind+("deviceId" in pointSource.field?pointSource.field.deviceId:"")} target={pointSource} assets={sourceAssets} onClose={()=>setPointSource(undefined)}/>}
      <details><summary>固定输入快照</summary><pre>{JSON.stringify(r.baseScenario,null,2)}</pre></details>
    </>}
  </section>;
}
