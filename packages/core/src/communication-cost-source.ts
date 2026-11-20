import {z} from 'zod';
import {MetricScope,NodeId,type CommunicationEvaluation,type MetricValue,type Quantity,type ValueExpr} from '@model-analyser/contracts';
import {jsonBytes} from '../../contracts/src/json-size.js';
import {canonical} from '../../contracts/src/validation.js';
import {LeafCostSourceRequest} from './leaf-cost-context.js';
import {computeInputHash,stableStringify} from './input-hash.js';
import {ENGINE_VERSION} from './version.js';
import {resolveParallelPlan} from './parallel-plan.js';
import {explainValue} from './formula.js';
import {namespaceDiagnostics} from './decode.js';
import {communicationParameterBindingGraph,parameterReads,type AdditionalParameterRoot} from './parameter-binding-graph.js';
import {assetParameterFrameId,workloadParameterFrameId,type ParameterCaptureTrace} from './parameter-observation.js';
import type {CommunicationPlanObservation} from './communication-observation.js';

export const CommunicationCostSelector=z.strictObject({
 index:z.number().int().nonnegative(),nativeNodeId:NodeId.optional(),scope:MetricScope,
 field:z.enum(['seconds','sendBytesPerMember','receiveBytesPerMember','algorithmTrafficBytesPerMember','groupSendBytes','groupReceiveBytes']),
});
export type CommunicationCostSelector=z.infer<typeof CommunicationCostSelector>;
export const CommunicationCostSourceRequest=LeafCostSourceRequest.extend({selector:CommunicationCostSelector,proofVersion:z.literal(2).optional(),decodeFrame:z.literal(true).optional()});
export type CommunicationCostSourceRequest=z.input<typeof CommunicationCostSourceRequest>;
const pageSize=20;
type FormulaEvidence=Omit<ReturnType<typeof explainValue>,'proof'>&{proof?:ReturnType<typeof explainValue>['proof']};

function selectedMetric(evaluation:CommunicationEvaluation,field:CommunicationCostSelector['field']){
 return field==='seconds'?evaluation.cost.seconds:evaluation.cost.communications[0]?.[field];
}

function compact(metric:MetricValue){
 return metric.status==='unavailable'?metric:{status:metric.status,quantity:metric.quantity,basis:metric.basis,diagnosticIds:metric.diagnosticIds};
}

const isNumber=(metric:MetricValue,value:number)=>metric.status==='available'&&metric.quantity.value===value;

export async function replayCommunicationCostSource(input:unknown){
 const request=CommunicationCostSourceRequest.parse(input),{scenario,assets,stepContext,selector,page,inputHash,engineVersion}=request;
 const extended=request.proofVersion===2;
 if(scenario.workload.kind==='decode'&&scenario.workload.steps!==1)throw Error('通信来源需要选择一个实际 Decode 步骤');
 if(request.decodeFrame&&!stepContext)throw Error('通信来源缺少实际 Decode 步骤上下文');
 const prefix=request.decodeFrame&&stepContext?`decode-step-${stepContext.index}::`:undefined;
 if(engineVersion!==ENGINE_VERSION||await computeInputHash(scenario,assets,stepContext)!==inputHash)throw Error('通信固定输入、实际步骤或引擎版本不匹配');
 const observations:CommunicationPlanObservation[]=[];
 let bindingTrace:ParameterCaptureTrace|undefined;
 const resolved=await resolveParallelPlan(scenario,assets,stepContext,{
  index:selector.index,...(selector.nativeNodeId?{nativeNodeId:selector.nativeNodeId}:{}),record:trace=>observations.push(trace),
  ...(extended?{bindings:(trace:ParameterCaptureTrace)=>{bindingTrace=trace;}}:{}),
 });
 if(resolved.status!=='available')throw Error('原通信布局不能复算');
 const row=resolved.result.communications.find(entry=>entry.index===selector.index),observed=observations[0];
 if(!row||!observed||observations.length!==1||row.origin?.nodeId!==selector.nativeNodeId||canonical(row.evaluation.cost.scope)!==canonical(selector.scope))throw Error('通信序号、图内身份或实际设备范围不匹配');
 if(resolved.result.inputHash!==inputHash||resolved.result.engineVersion!==engineVersion)throw Error('复算的通信布局身份不匹配');
 const {evaluation}=row,metric=selectedMetric(evaluation,selector.field),summary=evaluation.cost.communications[0];
 if(!summary||!metric||stableStringify(prefix?namespaceDiagnostics(metric,prefix):metric)!==stableStringify(request.metric))throw Error('原通信指标、单位或诊断不同');
 const effective=evaluation.definition,collective=observed.collective;
 if(row.origin&&!collective)throw Error('未采集到此实际图内调用的声明和参数');
 const authored=collective?.authored??scenario.parallelPlan.communications[selector.index],boundRoles=collective?.roleBound??authored;
 if(!authored||!boundRoles)throw Error('缺少原通信声明');
 const symbols=collective?.symbols??observed.symbols;
 const planKeys=new Set(observed.planParameterKeys);
 const start=page*pageSize,componentCount=evaluation.perDevice.length;
 if(page>0&&start>=componentCount)throw Error('请求的通信设备页不存在');
 const uniform=!effective.perDevicePayloads,sendRecv=effective.operation==='send_recv',factor=effective.algorithm.trafficFactor;
 if(!!boundRoles.perDevicePayloads===uniform)throw Error('通信逐设备声明类型不同');

 let complete=true,proofBytes=0,readsTruncated=false;
 const reads:AdditionalParameterRoot[]=[];
 function frameFor(name:string){
  if(collective)return collective.parameterFrameId;
  if(planKeys.has(name))return assetParameterFrameId('$model');
  return Object.hasOwn(scenario.workload,name)&&typeof Reflect.get(scenario.workload,name)==='number'?workloadParameterFrameId():undefined;
 }
 function formula(expr:ValueExpr,unit:Quantity['unit'],actual:number,target:string):FormulaEvidence{
  const evidence=explainValue(expr,symbols,assets);
  if(evidence.quantity.value!==actual||evidence.quantity.unit!==unit)throw Error('原通信公式与实际操作数不同');
  try{proofBytes+=jsonBytes(evidence,8*1024*1024-proofBytes);}catch{complete=false;return {quantity:evidence.quantity,truncated:true};}
  if(evidence.truncated)complete=false;
  if(extended&&!readsTruncated){
   for(const read of parameterReads(evidence.proof,(name,quantity)=>({name,quantity,target,frameId:frameFor(name)??'unrecorded-communication-frame'}))){
    if(reads.length===256){readsTruncated=true;break;}
    reads.push(read);
   }
  }
  return evidence;
 }
 function available(metric:MetricValue){if(metric.status!=='available')throw Error('原通信消息操作数不可用');return metric.quantity.value;}
 const uniformMessages=uniform?{
  send:formula(authored.sendBytesPerMember,'byte',available(summary.sendBytesPerMember),'每成员发送量'),
  receive:formula(authored.receiveBytesPerMember,'byte',available(summary.receiveBytesPerMember),'每成员接收量'),
  factor,count:sendRecv?1:componentCount,
 }:undefined;
 if(uniformMessages){
  const {send,receive,count}=uniformMessages;
  if(summary.groupSendBytes.status==='available'&&!isNumber(summary.groupSendBytes,send.quantity.value*count)||summary.groupReceiveBytes.status==='available'&&!isNumber(summary.groupReceiveBytes,receive.quantity.value*count))throw Error('统一消息数量与组总量不同');
  if(summary.algorithmTrafficBytesPerMember.status==='available'&&!isNumber(summary.algorithmTrafficBytesPerMember,send.quantity.value*factor))throw Error('算法流量与声明系数不同');
 }
 const rawByDevice=new Map(boundRoles.perDevicePayloads?.map(payload=>[payload.deviceId,payload])),effectiveByDevice=new Map(effective.perDevicePayloads?.map(payload=>[payload.deviceId,payload]));
 const items=[];
 let totalSend=0,totalReceive=0,maxTraffic=0,missingTraffic=false;
 for(const [index,device] of evaluation.perDevice.entries()){
  const send=available(device.sendBytes),receive=available(device.receiveBytes),raw=rawByDevice.get(device.deviceId),bound=effectiveByDevice.get(device.deviceId);
  const deviceFactor=bound?.trafficFactor??factor;
  const beforeSend=totalSend,beforeReceive=totalReceive;
  totalSend+=send;totalReceive+=receive;
  const traffic=device.algorithmTrafficBytes;
  if(traffic.status==='available'){
   if(traffic.quantity.value!==send*deviceFactor)throw Error('实际设备算法流量与声明系数不同');
   maxTraffic=Math.max(maxTraffic,traffic.quantity.value);
  }else missingTraffic=true;
  if(index<start||index>=start+pageSize)continue;
  if(!uniform&&(!raw||!bound))throw Error('设备有效荷载缺少实际声明');
  items.push({deviceId:device.deviceId,send:compact(device.sendBytes),receive:compact(device.receiveBytes),traffic:compact(traffic),factor:deviceFactor,
   ...(raw?{sendFormula:formula(raw.sendBytes,'byte',send,device.deviceId+' 发送量'),receiveFormula:formula(raw.receiveBytes,'byte',receive,device.deviceId+' 接收量'),sendSum:{before:beforeSend,after:totalSend},receiveSum:{before:beforeReceive,after:totalReceive}}:{}),
   ...(sendRecv?{role:device.deviceId===effective.sourceDeviceId?'sender' as const:'receiver' as const}:{}),
  });
 }
 if(!uniform&&(summary.groupSendBytes.status==='available'&&!isNumber(summary.groupSendBytes,totalSend)||summary.groupReceiveBytes.status==='available'&&!isNumber(summary.groupReceiveBytes,totalReceive)))throw Error('逐设备消息求和与组总量不同');
 const timing=observed.timing;
 if(timing&&!isNumber(evaluation.cost.seconds,timing.seconds))throw Error('实际通信耗时运算与评估不同');
 if(timing?.kind==='bandwidth_latency'&&(missingTraffic||timing.maxTraffic!==maxTraffic))throw Error('实际链路发送量与最大发送者不同');
 const timingFormula=effective.timing.kind==='custom_formula'&&authored.timing.kind==='custom_formula'&&timing?formula(authored.timing.seconds,'second',timing.seconds,'自定义网络耗时'):undefined;
 const diagnosticIds=new Set([...metric.diagnosticIds,...evaluation.cost.seconds.diagnosticIds,...Object.values(summary).flatMap(value=>typeof value==='object'?'diagnosticIds'in value?value.diagnosticIds:[]:[])]);
 const diagnostics=resolved.result.diagnostics.filter(item=>diagnosticIds.has(item.diagnosticId));
 const evidence={metric,
  declaration:collective?{kind:'graph' as const,nodeId:collective.nodeId,asset:collective.asset,authoredGroup:authored.groupId}:{kind:'plan' as const,index:selector.index},
  endpoints:{source:effective.source.tensorId,destination:effective.destination.tensorId},algorithm:effective.algorithm,groupId:effective.groupId,operation:effective.operation,
  ...(scenario.parallelPlan.generatedFrom&&!collective?{preset:scenario.parallelPlan.generatedFrom}:{}),
  network:{authored:authored.timing,roleBound:boundRoles.timing,effective:effective.timing,overrides:observed.overrides},
  summary:{send:compact(summary.sendBytesPerMember),receive:compact(summary.receiveBytesPerMember),traffic:compact(summary.algorithmTrafficBytesPerMember),groupSend:compact(summary.groupSendBytes),groupReceive:compact(summary.groupReceiveBytes)},
  ...(uniformMessages?{uniformMessages}:{}),items,...(timing?{timing}:{}),...(timingFormula?{timingFormula}:{}),diagnostics};
 if(extended&&!bindingTrace)throw Error('未采集到实际通信参数域');
 const parameterBindings=bindingTrace?communicationParameterBindingGraph({...bindingTrace,truncated:bindingTrace.truncated||!complete||readsTruncated},assets,reads):undefined;
 return {schemaVersion:extended?2 as const:1 as const,kind:'communication_cost_source' as const,inputHash,engineVersion,selector,page,pageSize,componentCount,complete,
  ...(prefix?namespaceDiagnostics(evidence,prefix):evidence),...(parameterBindings?{parameterBindings}:{}),request};
}

export type CommunicationCostSourceReport=Awaited<ReturnType<typeof replayCommunicationCostSource>>;

export async function verifyCommunicationCostSourceReport(input:unknown){
 if(!input||typeof input!=='object'||!('kind'in input)||input.kind!=='communication_cost_source'||!('schemaVersion'in input)||(input.schemaVersion!==1&&input.schemaVersion!==2)||!('request'in input))throw Error('无效的通信来源报告');
 const actual=await replayCommunicationCostSource(input.request);
 if(stableStringify(actual)!==stableStringify(input))throw Error('通信来源与固定输入复算不同');
 return actual;
}
