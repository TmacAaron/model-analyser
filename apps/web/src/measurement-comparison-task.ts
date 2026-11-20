import { z } from 'zod';
import { AnalysisResult,AssetDocument,MeasurementRecord,Scenario,MeasurementComparisonAttempt } from '@model-analyser/contracts';
import { compareMeasurement } from '@model-analyser/core';
import { measurementFrame } from './analysis-focus.js';

export const MeasurementComparisonRequest=z.strictObject({scenario:Scenario,assets:z.array(AssetDocument),result:AnalysisResult,
  records:z.array(MeasurementRecord).max(20).refine(records=>new Set(records.map(r=>r.measurementId)).size===records.length,'重复的测量 ID')});
export type MeasurementComparisonRequest=z.infer<typeof MeasurementComparisonRequest>;
export const MeasurementComparisonMessage=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('item'),index:z.number().int().nonnegative(),id:z.string(),attempt:MeasurementComparisonAttempt}),
  z.strictObject({kind:z.literal('complete'),count:z.number().int().nonnegative()}),
  z.strictObject({kind:z.literal('error'),message:z.string()})
]);
export type MeasurementComparisonMessage=z.infer<typeof MeasurementComparisonMessage>;
export type ComparedMeasurement={id:string;attempt:MeasurementComparisonAttempt};

/** Runs only in the dedicated worker in the app; every record retains the exact call/hash dispatch. */
export async function runMeasurementComparisons(input:unknown,emit:(message:MeasurementComparisonMessage)=>void){
  const request=MeasurementComparisonRequest.parse(input);
  for(const [index,record] of request.records.entries()){
    const frame=measurementFrame(request.result,record.inputHash);
    const attempt=await compareMeasurement(record,frame?.scenario??request.scenario,frame?.result??request.result,request.assets);
    emit({kind:'item',index,id:record.measurementId,attempt});
  }
  emit({kind:'complete',count:request.records.length});
}

/** The client accepts only the next expected record; a partial page is never marked complete. */
export function acceptComparisonMessage(ids:readonly string[],items:readonly ComparedMeasurement[],data:unknown){
  const message=MeasurementComparisonMessage.parse(data);
  if(message.kind==='error')throw Error(message.message);
  if(message.kind==='complete'){
    if(message.count!==ids.length||items.length!==ids.length)throw Error('测量比较未返回完整的当前页');
    return {complete:true,items:[...items]};
  }
  if(message.index!==items.length||ids[message.index]!==message.id||
    (message.attempt.status==='available'&&message.attempt.comparison.measurementId!==message.id))throw Error('测量比较返回的记录与当前页不匹配');
  return {complete:false,items:[...items,{id:message.id,attempt:message.attempt}]};
}
