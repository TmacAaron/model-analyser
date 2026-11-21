import { useEffect,useMemo,useRef,useState } from 'react';
import type { AssetDocument,Scenario } from '@model-analyser/contracts';
import { calculationInput,hashCanonicalInput,stableStringify,type KvCapacityAttempt,type KvCapacityReport } from '@model-analyser/core';
import { CapacityView } from './capacity-view.js';
import { useDisplayUnits } from './display-units.js';
import { StudyEvidenceDetails,StudyEvidencePager } from './study-evidence.js';
import type { KvCapacityRequest } from './kv-capacity-worker.js';

type Result={kind:'running'|'cancelled'}|{kind:'error';message:string}|{kind:'ready';report:KvCapacityReport};
const integer=new Intl.NumberFormat('zh-CN');
const bytesPerToken=new Intl.NumberFormat('zh-CN',{maximumSignificantDigits:6});
const formatRate=(value:number)=>(Number.isInteger(value)?integer:bytesPerToken).format(value)+' B / token';
const pageSize=12;

function KvPhysicalDevices({report}:{report:KvCapacityReport}){
  const display=useDisplayUnits(),[page,setPage]=useState(0);
  const growth=useMemo(()=>new Map('more' in report.budget?report.budget.more.map(row=>[row.deviceId,row.bytes]):[]),[report.budget]);
  const bytes=(value:number|undefined)=>value===undefined?'—':display.bytes(value);
  return <>
    <StudyEvidencePager label="KV 设备" page={page} size={pageSize} total={report.devices.length} onChange={setPage}/>
    <div className="analysis-table"><table><thead><tr><th>设备</th><th>显存上限</th><th>当前 KV</th><th>其他持久状态</th><th>非 KV 峰值</th><th>可分给 KV</th><th>下一长度增量</th></tr></thead>
      <tbody>{report.devices.slice(page*pageSize,(page+1)*pageSize).map(device=><tr key={device.deviceId}>
        <td>{device.deviceId}</td><td>{display.bytes(device.capacityBytes)}</td><td>{bytes(device.kvBytes)}</td><td>{bytes(device.otherStateBytes)}</td>
        <td>{bytes(device.nonKvBytes)}</td><td>{bytes(device.nonKvBytes===undefined?undefined:Math.max(0,device.capacityBytes-device.nonKvBytes))}</td><td>{bytes(growth.get(device.deviceId))}</td>
      </tr>)}</tbody>
    </table></div>
  </>;
}

function KvSummary({report}:{report:KvCapacityReport}){
  const display=useDisplayUnits(),{budget,rowProfile}=report;
  const limiting=budget.status==='no_room'?report.devices.find(device=>budget.limitingDeviceIds.includes(device.deviceId)):undefined;
  const tokens=budget.status==='available'?budget.tokensPerRequest:budget.status==='no_room'?0:report.fixedSlotsPerRequest;
  return <>
    <div className="kv-budget-cards">
      <div className="metric-card"><span>KV 显存预算</span>
        <strong>{tokens!==undefined?integer.format(tokens)+' token / 请求':budget.status==='fixed'?'固定窗口':'无法计算'}</strong>
        {budget.status==='available'&&<small>当前 batch {report.batchSize} · 约束设备 {budget.limitingDeviceIds.join('、')}</small>}
        {report.fixedSlotsPerRequest!==undefined&&<small>固定槽位，已用 {integer.format(report.referenceTokensPerRequest??0)}</small>}
      </div>
      <div className="metric-card"><span>{report.fixedSlotsPerRequest===undefined?'当前 KV 平均占用':'每个 KV 槽位'}</span>
        <strong>{report.averageBytesPerToken===undefined?'—':formatRate(report.averageBytesPerToken)}</strong>
        {report.replicatedBytesPerToken!==undefined&&<small>每卡复制 {formatRate(report.replicatedBytesPerToken)}</small>}
        {report.shardedBytesPerToken!==undefined&&<small>每卡分片 {formatRate(report.shardedBytesPerToken)}</small>}
        {report.requestPartitionedBytesPerToken!==undefined&&<small>本组每卡 {formatRate(report.requestPartitionedBytesPerToken)}</small>}
        {report.currentKvBytes!==undefined&&<small>所有物理设备合计 {display.bytes(report.currentKvBytes)}{report.referenceTokensPerRequest!==undefined&&' · 每请求 '+integer.format(report.referenceTokensPerRequest)+' token'}</small>}
      </div>
    </div>
    {budget.status==='unavailable'&&<p className="scope-note">{budget.reason}</p>}
    {budget.status==='no_room'&&<p className="scope-note">显存不足。{limiting&&budget.reason==='non_kv'&&limiting.nonKvBytes!==undefined?
      <>设备 {limiting.deviceId} 已需 {display.bytes(limiting.nonKvBytes)}，可用 {display.bytes(limiting.capacityBytes)}。</>:
      <>设备 {budget.limitingDeviceIds.join('、')} 放不下固定缓存和其他显存占用。</>}</p>}
    {rowProfile&&<p className="scope-note">{[
      rowProfile.fixedWindows.length>0?'固定窗口 '+rowProfile.fixedWindows.join(' / ')+' token':'',
      rowProfile.groupSizes.length>0?'每 '+rowProfile.groupSizes.join(' / ')+' 个 token 生成一行压缩缓存':'',
      rowProfile.includesIndexer?'含索引缓存':'',
    ].filter(Boolean).join(' · ')}</p>}
    {report.stateCount>0&&<>
      <p className="scope-note">
        {report.fixedSlotsPerRequest===undefined?'平均占用按全批实际缓存 token 和所有物理副本计算。':'槽位占用按完整预留的缓存计算。'}
        {report.decodeStep!==undefined&&'当前占用来自实际 Decode 第 '+(report.decodeStep+1)+' 步。'}
      </p>
      <details className="kv-device-details">
        <summary>逐卡显存与缓存分配</summary>
        <p className="scope-note">可分给 KV 的显存为设备上限减去当前工作负载各步最大的非 KV 占用。</p>
        {'stride' in budget&&<p className="scope-note">表中的增量按每请求增加 {budget.stride} 个 token 重算。分片、打包和对齐可能使增量分段变化。</p>}
        <KvPhysicalDevices report={report}/>
      </details>
    </>}
    {budget.status==='available'&&<p className="scope-note">按当前非 KV 峰值、分片和量化规则计算缓存槽位。模型上下文限制及更长上下文下的临时开销需另行核对。</p>}
  </>;
}

export function KvCapacityView({scenario,assets}:{scenario:Scenario;assets:AssetDocument[]}){
  const input=useMemo(()=>{
    try{return calculationInput(scenario,assets).canonicalInput;}
    catch{return stableStringify({scenario,assets});}
  },[scenario,assets]);
  const worker=useRef<Worker|null>(null),latest=useRef(input);
  latest.current=input;
  const [cached,setCached]=useState<{key:string;result:Result}>();
  const result=cached?.key===input?cached.result:undefined;
  function stop(){worker.current?.terminate();worker.current=null;}
  function calculate(){
    stop();
    setCached({key:input,result:{kind:'running'}});
    try{
      const instance=new Worker(new URL('./kv-capacity-worker.ts',import.meta.url),{type:'module'});
      worker.current=instance;
      const matches=()=>worker.current===instance&&latest.current===input;
      const expectedHash=hashCanonicalInput(input).catch(()=>undefined);
      function finish(result:Result){
        if(!matches())return;
        stop();setCached({key:input,result});
      }
      instance.onmessage=async({data}:MessageEvent<KvCapacityAttempt>)=>{
        if(!matches())return;
        if(data?.status==='unavailable'){finish({kind:'error',message:data.message});return;}
        const report=data?.status==='available'?data.report:undefined,hash=await expectedHash;
        if(report&&hash&&report.inputHash===hash&&report.scenarioId===scenario.scenarioId&&report.phase===scenario.workload.kind&&
          Array.isArray(report.devices)&&report.devices.length===scenario.deviceTopology.devices.length&&
          report.devices.every((row,index)=>row.deviceId===scenario.deviceTopology.devices[index]?.deviceId)){
          finish({kind:'ready',report});
        }else finish({kind:'error',message:'KV 结果与当前配置不一致。'});
      };
      instance.onerror=()=>finish({kind:'error',message:'KV 预算计算失败，可重试。'});
      instance.onmessageerror=()=>finish({kind:'error',message:'无法读取 KV 结果，可重试。'});
      instance.postMessage({scenario,assets} satisfies KvCapacityRequest);
    }catch(error){
      stop();setCached({key:input,result:{kind:'error',message:error instanceof Error?error.message:'无法启动 KV 预算计算。'}});
    }
  }
  useEffect(()=>{calculate();return stop;},[input]);
  return <section className="kv-capacity-panel" aria-label="KV 缓存容量">
    <h2>KV 缓存容量</h2>
    {(!result||result.kind==='running')&&<p role="status">正在计算当前配置的 KV 预算… <button type="button" onClick={()=>{stop();setCached({key:input,result:{kind:'cancelled'}});}}>取消 KV 计算</button></p>}
    {result?.kind==='cancelled'&&<p>KV 预算计算已取消。 <button type="button" onClick={calculate}>重算 KV 预算</button></p>}
    {result?.kind==='error'&&<><p role="alert">{result.message}</p><button type="button" onClick={calculate}>重算 KV 预算</button></>}
    {result?.kind==='ready'&&<KvSummary key={result.report.inputHash} report={result.report}/>}
    <StudyEvidenceDetails summary="高级参数扫描" render={()=> <CapacityView scenario={scenario} assets={assets}/>}/>
  </section>;
}
