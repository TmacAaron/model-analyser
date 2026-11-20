import type { AnalysisResult,RooflinePoint,RooflineObservation,RooflineStudyResult,RooflineStudySample } from '@model-analyser/contracts';
import type { ScalarEvidence,ScalarContext,ScalarOperand } from './scalar-source.js';
export type RooflineField='operations'|'traffic'|'intensity'|'predicted'|'roof'|'effective-compute'|'effective-memory'|'hardware-compute'|'hardware-memory'|'effective-ridge'|'effective-compute-time'|'effective-memory-time'|'hardware-ridge'|'hardware-compute-time'|'hardware-memory-time';
export function rooflinePointEvidence(p:RooflinePoint,field:RooflineField):ScalarEvidence|undefined{
  const metric=field==='operations'?p.operations:field==='traffic'?p.trafficBytes:field==='predicted'?p.actualOrPredictedPerformance:field==='roof'?p.roofPerformance:field==='effective-compute'?p.computeCeiling:field==='effective-memory'?p.memoryBandwidth:undefined;
  if(metric)return {kind:'metric',label:'Roofline '+field,metric,record:p,note:'范围／设备／完整计算类别、sourceNodeIds与trafficBasis沿原点记录，未改用第一叶节点。'};
  if(field==='intensity')return {kind:'derived',label:'Roofline 运算强度',value:p.arithmeticIntensity.status==='available'?p.arithmeticIntensity.operationsPerByte:undefined,unit:'operation/byte',diagnosticIds:p.arithmeticIntensity.status==='unavailable'?p.arithmeticIntensity.diagnosticIds:[],expression:'运算强度 = 该点执行operations / 该点trafficBytes',operands:[{label:'该点执行工作',metric:p.operations},{label:'该点流量 · '+p.trafficBasis,metric:p.trafficBytes}],record:p,note:'每类共享流量假设沿原trafficBasis；不同类别的流量不能当成独立贡献再次相加。'};
  return undefined;
}
export function rooflineObservationEvidence(o:RooflineObservation,field:RooflineField):ScalarEvidence|undefined{
  const point=rooflinePointEvidence(o.point,field);if(point)return {...point,record:o};
  const hardware=field.startsWith('hardware-'),compute=hardware?o.hardwareComputeCeiling:o.point.computeCeiling,memory=hardware?o.hardwareMemoryBandwidth:o.point.memoryBandwidth,balance=hardware?o.hardwareBalance:o.effectiveBalance,prefix=hardware?'硬件声明':'有效';
  if(field==='hardware-compute'||field==='hardware-memory')return {kind:'metric',label:'Roofline '+field,metric:field==='hardware-compute'?compute:memory,record:o,note:'硬件kind='+o.hardwareComputeKind+'/'+o.hardwareMemoryKind+'；不隐式重复应用效率。'};
  const ridge=field.endsWith('-ridge'),ct=field.endsWith('-compute-time');if(!ridge&&!ct&&!field.endsWith('-memory-time'))return undefined;
  const operands:ScalarOperand[]=ridge?[{label:prefix+'计算屋顶',metric:compute},{label:prefix+'带宽',metric:memory}]:ct?[{label:'该点执行工作',metric:o.point.operations},{label:prefix+'计算屋顶',metric:compute}]:[{label:'该点流量',metric:o.point.trafficBytes},{label:prefix+'带宽',metric:memory}];
  return {kind:'derived',label:prefix+(ridge?' 拐点':ct?' 计算分量时间':' 搬运分量时间'),value:balance.status==='available'?(ridge?balance.ridgeOperationsPerByte:ct?balance.computeSeconds:balance.memorySeconds):undefined,unit:ridge?'operation/byte':'second',diagnosticIds:balance.status==='unavailable'?balance.diagnosticIds:[],expression:ridge?'拐点 = 同一屋顶的计算能力 / 带宽':ct?'计算分量秒数 = 执行operations / 同一屋顶计算能力':'搬运分量秒数 = trafficBytes / 同一屋顶带宽',operands,record:o,note:'按原Balance记录解释，未重新判定限制侧；零能力、空工作或不可表示数值保持原不可用。'};
}
export function rooflineActualFrame(result:AnalysisResult,step:number|undefined){return result.decode?result.decode.steps.find(s=>s.index===(step??0))?.result:step===undefined||step===0?result:undefined;}
export function rooflineSourceContext(report:RooflineStudyResult,result:AnalysisResult,sample?:RooflineStudySample):ScalarContext|undefined{
  const frame=rooflineActualFrame(result,report.request.decodeStep);return frame?{assets:report.assets,parameters:frame.parameterTrace,diagnostics:sample?.diagnostics??frame.diagnostics,inputHash:frame.inputHash,scope:JSON.stringify(report.request.target)+' · '+(result.decode?'实际步骤 '+((report.request.decodeStep??0)+1):'单次实际调用')}:undefined;
}
