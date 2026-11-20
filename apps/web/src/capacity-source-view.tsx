import { useEffect,useRef,useState } from 'react';
import type { AnalysisResult,AssetDocument,CapacitySearchResult,Scenario,MemoryPeak,RooflineStudySample } from '@model-analyser/contracts';
import { capacityCandidate,stableStringify } from '@model-analyser/core';
import { CapacitySourceResponse,verifyCapacitySource,type CapacitySourceRequest,type CapacitySourceRoofline } from './capacity-source-task.js';
import { ScalarSourcePanel,type ScalarEvidence,type ScalarContext } from './scalar-source.js';
export type CapacitySourceField={kind:'seconds'}|{kind:'hbm'}|{kind:'peak';deviceId:string}|{kind:'capacity';deviceId:string};
export type CapacitySourceTarget={report:CapacitySearchResult;pointValue:number;field:CapacitySourceField};
export function capacityScalarEvidence(result:AnalysisResult,scenario:Scenario,assets:AssetDocument[],field:CapacitySourceField,memory:MemoryPeak[]=result.memory):ScalarEvidence|undefined{
  if(field.kind==='seconds'||field.kind==='hbm')return {kind:'metric',label:field.kind==='seconds'?'整数点理论跨度':'整数点HBM',metric:field.kind==='seconds'?result.total.seconds:result.total.hbmBytes};
  const m=memory.find(m=>m.deviceScope.kind==='per_device'?m.deviceScope.deviceId===field.deviceId:m.deviceScope.deviceIds.some(id=>id===field.deviceId));if(!m)return undefined;
  if(field.kind==='peak')return {kind:'metric',label:field.deviceId+' 整数点生命周期峰值',metric:m.peakBytes,record:m,note:'总量覆盖、私有预算和原理论分别保留，不分摊为模块峰值。'};
  const device=scenario.deviceTopology.devices.find(d=>d.deviceId===field.deviceId),asset=device?assets.find(a=>a.assetId===device.hardware.assetId&&a.revision===device.hardware.revision&&a.definition.kind==='hardware'):undefined;
  return {kind:'declaration',label:field.deviceId+' 整数点硬件容量',value:m.capacityBytes,unit:'byte',note:'容量来自该物理设备的固定硬件声明；结果值不由其他卡或最新修订补填。',record:{device,hardware:asset,memoryCapacityBytes:m.capacityBytes}};
}
export function capacityMaximumEvidence(report:CapacitySearchResult,assets:AssetDocument[]):Extract<ScalarEvidence,{kind:'declaration'}>{
  const variable=report.request.variable,model=assets.find(a=>a.assetId===report.baseScenario.model.assetId&&a.revision===report.baseScenario.model.revision),unit=variable.kind==='workload'?'count':model?.parameters.find(p=>p.key===variable.parameterKey)?.unit??'integer';
  return {kind:'declaration',label:'区间内最大可容纳整数',value:report.capacityStatus.kind==='solved'?report.capacityStatus.maximum:undefined,unit,note:'依据原完整整数点集合与容量判定；不假定单调性，不声明范围外极值。取消或证据不完整时不补零。',record:{request:report.request,completion:report.completion,capacityStatus:report.capacityStatus,points:report.points.map(p=>({value:p.value,status:p.status,...(p.status==='available'?{inputHash:p.inputHash,fit:p.fit,memory:p.memory}:{}),diagnostics:p.diagnostics})),diagnostics:report.diagnostics}};
}
function VerifiedPoint({result,target,assets,onClose}:{result:AnalysisResult;target:CapacitySourceTarget;assets:AssetDocument[];onClose:()=>void}){
  const [step,setStep]=useState('aggregate'),candidate=capacityCandidate(target.report.baseScenario,target.report.request.variable,target.pointValue),frame=step==='aggregate'?undefined:result.decode?.steps.find(s=>String(s.index)===step),current=step==='aggregate'?result:frame?.result,scenario=frame?.scenario??candidate;
  const evidence=current?capacityScalarEvidence(current,scenario,assets,target.field,frame?.memory??current.memory):undefined;
  const context:ScalarContext={assets,parameters:current?.parameterTrace,diagnostics:current?.diagnostics??[],inputHash:current?.inputHash??'缺失实际步骤',scope:'原扫描整数 '+target.pointValue+' · '+(step==='aggregate'?'完整点结果':'实际步骤 '+(Number(step)+1)),missingParameterReason:step==='aggregate'&&result.decode?'这是完整Decode点的累计成本／最坏步骤显存；请选择实际步骤查看该步参数。':undefined};
  return <><p className="scope-note">已按原扫描固定输入后台复核，并核对全部已记录点值、范围、诊断与输入hash；未使用当前默认值。</p>{result.decode&&<label>来源实际步骤<select aria-label="整数点来源步骤" value={step} onChange={e=>setStep(e.target.value)}><option value="aggregate">完整整数点结果</option>{result.decode.steps.map(s=><option key={s.index} value={s.index}>步骤 {s.index+1} · context {s.evaluatedContext}</option>)}</select></label>}{evidence?<ScalarSourcePanel selection={{evidence,context}} onClose={onClose}/>:<p role="status">请求的步骤、设备或指标不存在，未回退其他范围。</p>}</>;
}
export function useCapacitySourceReplay(target:Pick<CapacitySourceTarget,"report"|"pointValue">&{roofline?:CapacitySourceRoofline|undefined},assets:AssetDocument[]){
  const [run,setRun]=useState(0),[state,setState]=useState<{status:'running'|'cancelled'|'error'|'complete';result?:AnalysisResult;rooflineSample?:RooflineStudySample;message?:string}>({status:'running'}),worker=useRef<Worker|null>(null),owner=useRef(target);owner.current=target;
  useEffect(()=>{
    const point=target.report.points.find(p=>p.value===target.pointValue);if(!point){setState({status:'error',message:'原报告中没有该整数点。'});return;}
    if(point.status==='unavailable'){setState({status:'error',message:point.diagnostics.map(d=>d.message).join('；')});return;}
    setState({status:'running'});let instance:Worker;
    try{instance=new Worker(new URL('./capacity-source-worker.ts',import.meta.url),{type:'module'});worker.current=instance;const request:CapacitySourceRequest={baseScenario:target.report.baseScenario,baseInputHash:target.report.baseInputHash,request:target.report.request,point,assets,...(target.roofline?{roofline:target.roofline}:{})};
      instance.onmessage=event=>{if(worker.current!==instance||owner.current!==target)return;try{const response=CapacitySourceResponse.parse(event.data);if(response.status==='error')throw Error(response.message);if(response.attempt.status!=='available')throw Error('复核没有有效结果。');verifyCapacitySource(point,response.attempt.result);if(target.roofline&&stableStringify(response.rooflineSample)!==stableStringify(target.roofline.sample))throw Error('后台回复缺少匹配的Roofline样本证明。');setState({status:'complete',result:response.attempt.result,...(response.rooflineSample?{rooflineSample:response.rooflineSample}:{})});}catch(e){setState({status:'error',message:e instanceof Error?e.message:'来源回复无效'});}instance.terminate();worker.current=null;};
      instance.onerror=()=>{if(worker.current===instance&&owner.current===target){setState({status:'error',message:'后台来源复核失败，可重试。'});instance.terminate();worker.current=null;}};instance.postMessage(request);
    }catch(e){worker.current?.terminate();worker.current=null;setState({status:'error',message:e instanceof Error?e.message:'无法启动来源复核'});}
    return ()=>{worker.current?.terminate();worker.current=null;};
  },[target,assets,run]);
  return {...state,cancel:()=>{worker.current?.terminate();worker.current=null;setState({status:"cancelled"});},retry:()=>setRun(n=>n+1)};
}
export function CapacitySourcePanel({target,assets,onClose}:{target:CapacitySourceTarget;assets:AssetDocument[];onClose:()=>void}){
  const state=useCapacitySourceReplay(target,assets);
  return <section className="capacity-source-replay" aria-label="整数点来源复核">{state.status==='running'?<><p role="status">正在后台复核整数 {target.pointValue} 的固定来源…</p><button onClick={state.cancel}>取消来源复核</button></>:state.status!=='complete'?<><p role="status">{state.message??'来源复核已取消，原扫描结果保持。'}</p><button onClick={state.retry}>重试来源复核</button></>:null}{state.result&&<VerifiedPoint key={state.result.inputHash+':'+target.field.kind+':'+('deviceId' in target.field?target.field.deviceId:'')} result={state.result} target={target} assets={assets} onClose={onClose}/>}<button onClick={onClose}>关闭整数点来源</button></section>;
}
