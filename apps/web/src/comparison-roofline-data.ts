import type { MetricTarget,RooflineObservation,ScenarioComparisonResult } from '@model-analyser/contracts';
import { rooflineSample,stableStringify } from '@model-analyser/core';
import { targetProblem } from './analysis-focus.js';
import { rooflineActualFrame,rooflineObservationEvidence,type RooflineField } from './roofline-source.js';
import type { ScalarEvidence } from './scalar-source.js';

export const rooflineFields=[
  {id:'intensity',label:'运算强度',unit:'operation/byte'},
  {id:'predicted',label:'理论预测性能',unit:'operation_per_second'},
  {id:'roof',label:'有效屋顶上的性能上界',unit:'operation_per_second'},
  {id:'hardware-compute',label:'硬件声明计算屋顶',unit:'operation_per_second'},
  {id:'hardware-memory',label:'硬件声明带宽',unit:'byte_per_second'},
  {id:'effective-compute',label:'有效计算屋顶',unit:'operation_per_second'},
  {id:'effective-memory',label:'有效带宽',unit:'byte_per_second'},
  {id:'hardware-ridge',label:'硬件拐点',unit:'operation/byte'},
  {id:'effective-ridge',label:'有效拐点',unit:'operation/byte'},
] as const satisfies readonly {id:RooflineField;label:string;unit:string}[];

export function rooflineEvidenceValue(evidence:ScalarEvidence|undefined){
  if(!evidence)return undefined;
  if(evidence.kind!=='metric')return evidence.value;
  return evidence.metric.status==='available'?evidence.metric.quantity.value:undefined;
}

function seriesKey(observation:RooflineObservation){
  const {scope,computeClass,trafficBasis}=observation.point;
  return stableStringify({scope:{...scope,deviceIds:[...scope.deviceIds].sort()},computeClass,trafficBasis});
}

export function rooflineDifference(value:number|undefined,baseline:number|undefined){
  return value===undefined||baseline===undefined?undefined:value-baseline;
}

export type RooflineComparisonRequest={target:MetricTarget;fieldId:typeof rooflineFields[number]['id'];decodeStep?:number|undefined};

export function readRooflineComparison(report:ScenarioComparisonResult,target:MetricTarget,requestedStep:number|undefined){
  const entries=report.entries.map(({analysis,scenario})=>{
    const decodeStep=analysis.status==='available'&&analysis.result.decode?requestedStep:undefined;
    const frame=analysis.status==='available'?rooflineActualFrame(analysis.result,decodeStep):undefined;
    const problem=frame?targetProblem(frame,target,true):undefined;
    const sample=rooflineSample(analysis,scenario,report.assets,{target,...(decodeStep===undefined?{}:{decodeStep})});
    if(problem)sample.observations=[];
    const bySeries=new Map<string,RooflineObservation|null>();
    for(const observation of sample.observations){
      const key=seriesKey(observation);
      bySeries.set(key,bySeries.has(key)?null:observation);
    }
    return {scenario,frame,sample,bySeries,problem};
  });

  const keyed=new Map<string,RooflineObservation>();
  for(const entry of entries)for(const point of entry.sample.observations)keyed.set(seriesKey(point),point);
  return {entries,points:[...keyed]};
}

export function rooflineComparisonEvidence(report:ScenarioComparisonResult,{target,fieldId,decodeStep}:RooflineComparisonRequest){
  const field=rooflineFields.find(f=>f.id===fieldId);
  if(!field)throw Error('Roofline 导出指标无效');
  const {entries,points}=readRooflineComparison(report,target,decodeStep);
  return {
    target,
    ...(decodeStep===undefined?{}:{decodeStep}),
    engineVersion:report.engineVersion,
    comparisonCompletion:report.completion,
    assets:report.assets,
    metric:field,
    entries:entries.map(({scenario,sample,problem})=>({scenario,sample,problem})),
    rows:points.map(([key])=>{
      const values=entries.map(e=>{
        const observation=e.bySeries.get(key);
        return observation?rooflineEvidenceValue(rooflineObservationEvidence(observation,field.id)):undefined;
      });
      return {series:JSON.parse(key),values:values.map((value,index)=>{
        const delta=index>0?rooflineDifference(value,values[0]):undefined;
        return {value:value??null,delta:delta!==undefined&&Number.isFinite(delta)?delta:null};
      })};
    }),
  };
}
