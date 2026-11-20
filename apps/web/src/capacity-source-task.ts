import { z } from 'zod';
import { Scenario,AssetDocument,CapacitySearchRequest,CapacitySearchPoint,AnalysisAttempt,RooflineStudyRequest,RooflineStudySample,type AnalysisResult } from '@model-analyser/contracts';
import { analyzeScenario,capacityCandidate,capacityPoint,computeInputHash,stableStringify,rooflineSample,calculationInput } from '@model-analyser/core';
export const CapacitySourceRoofline=z.strictObject({scenario:Scenario,request:RooflineStudyRequest,sample:RooflineStudySample});
export type CapacitySourceRoofline=z.infer<typeof CapacitySourceRoofline>;
export const CapacitySourceRequest=z.strictObject({baseScenario:Scenario,baseInputHash:z.string().min(1),request:CapacitySearchRequest,point:CapacitySearchPoint,assets:z.array(AssetDocument),roofline:CapacitySourceRoofline.optional()});
export type CapacitySourceRequest=z.infer<typeof CapacitySourceRequest>;
export const CapacitySourceResponse=z.discriminatedUnion('status',[z.strictObject({status:z.literal('available'),attempt:AnalysisAttempt,rooflineSample:RooflineStudySample.optional()}),z.strictObject({status:z.literal('error'),message:z.string()})]);
export type CapacitySourceResponse=z.infer<typeof CapacitySourceResponse>;
export function verifyCapacitySource(point:CapacitySourceRequest['point'],result:AnalysisResult){
  if(point.status!=='available'||point.inputHash!==result.inputHash)throw Error('来源复核的实际输入hash不匹配该整数点。');
  const actual=capacityPoint(result,point.value);if(!point.scope)delete actual.scope;if(!point.modelUsefulCompute)delete actual.modelUsefulCompute;
  if(stableStringify(actual)!==stableStringify(point))throw Error('来源复核与原整数点的值、设备、范围或诊断不一致。');
}
export async function replayCapacitySource(input:unknown):Promise<CapacitySourceResponse>{
  try{
    const r=CapacitySourceRequest.parse(input),p=r.point;
    if(p.status!=='available')throw Error('不可用点只有原诊断，不能生成有效指标来源。');
    if(p.value<r.request.searchRange.min||p.value>r.request.searchRange.max)throw Error('请求点不在原扫描范围中。');
    if(await computeInputHash(r.baseScenario,r.assets)!==r.baseInputHash)throw Error('固定扫描输入或资产快照不匹配原baseInputHash。');
    const scenario=capacityCandidate(r.baseScenario,r.request.variable,p.value);
    if(await computeInputHash(scenario,r.assets)!==p.inputHash)throw Error('候选输入不匹配原整数点，未使用当前默认值补填。');
    const attempt=await analyzeScenario(scenario,r.assets);if(attempt.status!=='available')throw Error('该固定点目前无法复核：'+attempt.diagnostics.map(d=>d.message).join('；'));
    verifyCapacitySource(p,attempt.result);
    if(r.roofline){
      if(!r.roofline.request.scan||stableStringify(r.roofline.request.scan)!==stableStringify(r.request)||stableStringify(r.roofline.scenario)!==stableStringify(r.baseScenario))throw Error('Roofline来源缺少匹配的原扫描输入。');
      const fixed=calculationInput(r.roofline.scenario,r.assets);
      const actual=rooflineSample(attempt,fixed.scenario,fixed.assets,r.roofline.request,p.value);
      if(stableStringify(actual)!==stableStringify(r.roofline.sample))throw Error('Roofline样本的实际hash、步骤、分类、数值或诊断与原记录不一致。');
      return {status:'available',attempt,rooflineSample:actual};
    }
    return {status:'available',attempt};
  }catch(e){return {status:'error',message:e instanceof Error?e.message:'来源复核失败'};}
}
