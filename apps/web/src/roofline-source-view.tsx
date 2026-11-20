import { useMemo } from 'react';
import type { RooflineStudyResult,AnalysisResult,RooflineStudySample } from '@model-analyser/contracts';
import { stableStringify } from '@model-analyser/core';
import { useCapacitySourceReplay } from './capacity-source-view.js';
import { rooflineObservationEvidence,rooflineSourceContext,type RooflineField } from './roofline-source.js';
import { ScalarSourcePanel } from './scalar-source.js';
export type RooflineSourceTarget={report:RooflineStudyResult;sampleValue:number|undefined;seriesId:string;field:RooflineField};
function Proof({target,result,verifiedSample,onClose}:{target:RooflineSourceTarget;result:AnalysisResult;verifiedSample?:RooflineStudySample|undefined;onClose:()=>void}){
  const {report,sampleValue,seriesId,field}=target,sample=sampleValue===undefined?report.base:report.samples.find(s=>s.value===sampleValue),o=sample?.observations.find(o=>o.seriesId===seriesId),context=rooflineSourceContext(report,result,sample),evidence=o?rooflineObservationEvidence(o,field):undefined;
  let error:string|undefined;
  if(sampleValue!==undefined&&stableStringify(verifiedSample)!==stableStringify(sample))error='该整数样本没有匹配的后台来源证明。';
  if(sampleValue===undefined&&(sample?.inputHash!==result.inputHash||(result.decode&&sample.stepInputHash!==context?.inputHash)))error='基础样本缺少与实际调用匹配的输入hash，未补填其他步骤。';
  if(error||!context||!evidence)return <p role="status">{error??'请求的样本、实际步骤、完整分类或指标不存在，未改选其他范围。'}</p>;
  return <ScalarSourcePanel selection={{evidence:{...evidence,note:(evidence.note??'')+' '+(sampleValue===undefined?'基础固定输入。':'按原固定整数 '+sampleValue+' 后台复核，未补填基础点参数。')},context}} onClose={onClose}/>;
}
function SampleProof({target,onClose}:{target:RooflineSourceTarget;onClose:()=>void}){
  const scan=target.report.scan?.status==='available'?target.report.scan.result:undefined;
  if(!scan||target.sampleValue===undefined)return <p role="status">此样本缺少原扫描点证据，不能用当前输入重建来源。</p>;
  return <Replay target={target} scan={scan} value={target.sampleValue} onClose={onClose}/>;
}
function Replay({target,scan,value,onClose}:{target:RooflineSourceTarget;scan:NonNullable<Extract<RooflineStudyResult['scan'],{status:'available'}>>['result'];value:number;onClose:()=>void}){
  const replay=useMemo(()=>({report:scan,pointValue:value,roofline:target.report.samples.find(s=>s.value===value)?{scenario:target.report.scenario,request:target.report.request,sample:target.report.samples.find(s=>s.value===value)!}:undefined}),[target,scan,value]),state=useCapacitySourceReplay(replay,target.report.assets);
  return <>{state.status==='running'?<><p role="status">正在后台复核Roofline整数样本 {value}…</p><button onClick={state.cancel}>取消Roofline来源复核</button></>:state.status!=='complete'?<><p role="status">{state.message??'来源复核已取消，原研究保留。'}</p><button onClick={state.retry}>重试Roofline来源复核</button></>:null}{state.result&&<Proof target={target} result={state.result} verifiedSample={state.rooflineSample} onClose={onClose}/>}</>;
}
export function RooflineSourcePanel({target,onClose}:{target:RooflineSourceTarget;onClose:()=>void}){
  return <section className="roofline-source-panel" aria-label="Roofline指标来源">{target.sampleValue===undefined?target.report.analysis.status==='available'?<Proof target={target} result={target.report.analysis.result} onClose={onClose}/>:<p role="status">基础分析不可用。</p>:<SampleProof target={target} onClose={onClose}/>}<button onClick={onClose}>关闭Roofline来源</button></section>;
}
