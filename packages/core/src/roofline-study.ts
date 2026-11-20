import { RooflineStudyRequest,RooflineStudyAttempt,RooflinePoint,type AnalysisAttempt,type AnalysisResult,type AssetDocument,type Scenario,type RooflineStudySample,type RooflineObservation,type RooflineBalance,type RooflineStudyTransition,type MetricValue,type CostResult } from '@model-analyser/contracts';
import { analyzeScenario,ENGINE_VERSION } from './analyze.js';
import { calculationInput,stableStringify } from './input-hash.js';
import { MetricFactory } from './metrics.js';
import { searchCapacity,type CapacitySearchControl } from './capacity.js';
import { validateRooflineStudy } from '../../contracts/src/roofline-study-validation.js';

export const MAX_ROOFLINE_ANALYSES=512;
type Result=Omit<AnalysisResult,'decode'>;
/** Compare compute/HBM components of the selected roof, not the actual end-to-end bottleneck. */
export function rooflineBalance(point:RooflinePoint,compute:MetricValue,memory:MetricValue,metrics:MetricFactory):RooflineBalance{
  if(compute.status!=='available'||memory.status!=='available'||point.operations.status!=='available'||point.trafficBytes.status!=='available')return {status:'unavailable',diagnosticIds:[...new Set([compute,memory,point.operations,point.trafficBytes].flatMap(m=>m.status==='unavailable'?m.diagnosticIds:[]))]};
  const c=compute.quantity.value,b=memory.quantity.value,ops=point.operations.quantity.value,bytes=point.trafficBytes.quantity.value,ridge=c/b,ct=ops/c,mt=bytes/b;
  if(!(c>0&&b>0&&ridge>0&&Number.isFinite(ridge)&&Number.isFinite(ct)&&Number.isFinite(mt))||ops>0&&ct===0||bytes>0&&mt===0||ops===0&&bytes===0)return metrics.unavailable('unrepresentable_roofline_balance','空工作、零能力或数值溢出/下溢时，不声明有限拐点与限制侧');
  return {status:'available',ridgeOperationsPerByte:ridge,computeSeconds:ct,memorySeconds:mt,side:ct===mt?'balanced':ct>mt?'compute':'memory'};
}
function sources(result:Result,target:RooflineStudyRequest['target']):{cost:CostResult;ids:string[]}|undefined{
  const active=result.nodes.filter(n=>!result.fusions?.some(f=>f.evaluation.application.memberNodeIds.includes(n.nodeId))),fusions=result.fusions??[];
  if(target.kind==='node'){const node=active.find(n=>n.nodeId===target.nodeId),fusion=fusions.find(f=>f.evaluation.application.nodeId===target.nodeId);return node?{cost:node.cost,ids:[node.nodeId]}:fusion?{cost:fusion.cost,ids:[fusion.evaluation.application.nodeId]}:undefined;}
  if(target.kind==='model')return {cost:result.total,ids:[...active.map(n=>n.nodeId),...fusions.map(f=>f.evaluation.application.nodeId)]};
  const module=result.modules.find(m=>m.nodeId===target.nodeId);return module?{cost:module.cost,ids:[...module.leafNodeIds.filter(id=>active.some(n=>n.nodeId===id)),...fusions.filter(f=>f.evaluation.application.memberNodeIds.every(id=>module.leafNodeIds.includes(id))).map(f=>f.evaluation.application.nodeId)]}:undefined;
}
export function rooflineSample(attempt:AnalysisAttempt,scenario:Scenario,assets:AssetDocument[],request:RooflineStudyRequest,value?:number):RooflineStudySample{
  if(attempt.status==='unavailable')return {observations:[],diagnostics:attempt.diagnostics,...(value===undefined?{}:{value})};
  const whole=attempt.result,index=request.decodeStep??0,step=whole.decode?.steps[index],result=whole.decode?step?.result:whole;
  const sample:RooflineStudySample={inputHash:whole.inputHash,...(value===undefined?{}:{value}),observations:[],diagnostics:result?[...result.diagnostics]:[]};
  const metrics=new MetricFactory(sample.diagnostics,{assetRefs:assets.map(a=>({assetId:a.assetId,revision:a.revision,kind:a.definition.kind})),formulaRefs:assets.filter(a=>a.definition.kind==='formula').map(a=>({assetId:a.assetId,revision:a.revision,kind:'formula'})),parameterSources:[],assumptions:['Aggregate roofs pool distinct physical devices once and may hide imbalance. Unknown effective ceilings are not replaced with peak values.']},scenario.scenarioId,'roofline-study');
  if(!result||!whole.decode&&index!==0){metrics.unavailable('invalid_decode_step','所选 decode 步骤不存在');return sample;}
  if(step){sample.stepInputHash=result.inputHash;sample.evaluatedContext=step.evaluatedContext;}
  const selected=sources(result,request.target);if(!selected){metrics.unavailable('missing_roofline_target','范围不存在，或属于不能单独计时的融合成员');return sample;}
  const leaves=result.roofline.filter(p=>p.scope.target.kind!=='model'&&selected.ids.includes(p.scope.target.nodeId));
  function hardware(scope:RooflinePoint['scope'],cls:RooflinePoint['computeClass']){
    const cards=[...new Set(scope.deviceIds)].map(id=>{const ref=scenario.deviceTopology.devices.find(d=>d.deviceId===id)?.hardware;return assets.find(a=>a.assetId===ref?.assetId&&a.revision===ref.revision);});
    const c=cards.map(a=>a?.definition.kind==='hardware'?a.definition.hardware.computeCapabilities.filter(c=>stableStringify(c.computeClass)===stableStringify(cls)):[]),m=cards.map(a=>a?.definition.kind==='hardware'?a.definition.hardware.memoryCapabilities.filter(b=>b.key==='hbm'):[]);
    const compute=c.length&&c.every(v=>v.length===1)?metrics.available(c.reduce((n,v)=>n+(v[0]?.operationsPerSecond??0),0),'operation_per_second',c.some(v=>v[0]?.kind==='effective')?'estimated':'theoretical'):metrics.unavailable('missing_compute_capability','范围内每个物理设备都需要唯一匹配的计算能力');
    const memory=m.length&&m.every(v=>v.length===1)?metrics.available(m.reduce((n,v)=>n+(v[0]?.bytesPerSecond??0),0),'byte_per_second',m.some(v=>v[0]?.kind==='effective')?'estimated':'theoretical'):metrics.unavailable('missing_memory_capability','范围内每个物理设备都需要唯一HBM能力');
    const kind=(v:{kind:'peak'|'effective'}[][]):RooflineObservation['hardwareComputeKind']=>v.some(v=>v.length!==1)?'unavailable':new Set(v.flat().map(v=>v.kind)).size===1?v[0]?.[0]?.kind??'unavailable':'mixed';
    return {compute,memory,computeKind:kind(c),memoryKind:kind(m)};
  }
  function add(point:RooflinePoint,aggregation:'leaf'|'pooled',ids:RooflineObservation['sourceNodeIds']){
    const h=hardware(point.scope,point.computeClass);sample.observations.push({seriesId:stableStringify({scope:point.scope,computeClass:point.computeClass}),point,sourceNodeIds:ids,aggregation,hardwareComputeCeiling:h.compute,hardwareMemoryBandwidth:h.memory,hardwareComputeKind:h.computeKind,hardwareMemoryKind:h.memoryKind,effectiveBalance:rooflineBalance(point,point.computeCeiling,point.memoryBandwidth,metrics),hardwareBalance:rooflineBalance(point,h.compute,h.memory,metrics)} as RooflineObservation);
  }
  if(request.target.kind==='node'){for(const p of leaves)add(p,'leaf',selected.ids as RooflineObservation['sourceNodeIds']);return sample;}
  for(const segment of selected.cost.compute){
    const scope={...selected.cost.scope,target:request.target},matching=leaves.filter(p=>stableStringify(p.computeClass)===stableStringify(segment.computeClass));
    // A unique effective ceiling per device is required; heterogeneous efficiencies remain unavailable.
    function effective(field:'computeCeiling'|'memoryBandwidth',unit:'operation_per_second'|'byte_per_second'){
      const perDevice=scope.deviceIds.map(id=>{const values=matching.filter(p=>p.scope.deviceIds.includes(id)).map(p=>p[field]);return values.length&&values.every(v=>v.status==='available')?new Set(values.flatMap(v=>v.status==='available'?[v.quantity.value]:[])):undefined;});
      return perDevice.length&&perDevice.every(s=>s?.size===1)?metrics.available(perDevice.reduce((n,s)=>n+([...(s??[])][0]??0),0),unit,'estimated'):metrics.unavailable('heterogeneous_effective_roof','聚合范围的逐设备有效屋顶不唯一或缺失；保留硬件声明屋顶与局部点，不猜测平均效率');
    }
    const compute=effective('computeCeiling','operation_per_second'),memory=effective('memoryBandwidth','byte_per_second'),traffic=selected.cost.hbmBytes.status==='available'?selected.cost.hbmBytes:metrics.sum([selected.cost.logicalReadBytes,selected.cost.logicalWriteBytes],'byte'),trafficBasis=selected.cost.hbmBytes.status==='available'?'estimated_hbm':'logical';
    const ops=segment.executedOperations,ai=ops.status==='available'&&traffic.status==='available'&&traffic.quantity.value>0&&Number.isFinite(ops.quantity.value/traffic.quantity.value)?{status:'available',operationsPerByte:ops.quantity.value/traffic.quantity.value}:metrics.unavailable('unknown_arithmetic_intensity','工作量或有限非零流量不足，算术强度不可用');
    const roof=compute.status==='available'&&memory.status==='available'&&ai.status==='available'?metrics.available(Math.min(compute.quantity.value,memory.quantity.value*ai.operationsPerByte),'operation_per_second','estimated'):metrics.unavailable('unknown_aggregate_roof','聚合有效屋顶缺少必要输入');
    const performance=ops.status==='available'&&selected.cost.seconds.status==='available'&&selected.cost.seconds.quantity.value>0?metrics.available(ops.quantity.value/selected.cost.seconds.quantity.value,'operation_per_second','estimated'):metrics.unavailable('unknown_aggregate_performance','工作量或范围跨度不可用');
    add(RooflinePoint.parse({scope,computeClass:segment.computeClass,operations:ops,trafficBytes:traffic,arithmeticIntensity:ai,computeCeiling:compute,memoryBandwidth:memory,roofPerformance:roof,actualOrPredictedPerformance:performance,trafficBasis}),'pooled',selected.ids as RooflineObservation['sourceNodeIds']);
  }
  return sample;
}
export function rooflineTransitions(base:RooflineStudySample,samples:RooflineStudySample[],expected:number):RooflineStudyTransition[]{
  const ids=[...new Set([base,...samples].flatMap(s=>s.observations.map(o=>o.seriesId)))],out:RooflineStudyTransition[]=[];
  for(const seriesId of ids)for(const roof of ['effective','hardware'] as const){
    const events:RooflineStudyTransition['events']=[];let knownPoints=0,previous:{value:number;side:string}|undefined;
    for(const sample of samples){const observation=sample.observations.find(o=>o.seriesId===seriesId),balance=roof==='effective'?observation?.effectiveBalance:observation?.hardwareBalance,x=sample.value;
      if(x===undefined||balance?.status!=='available'){previous=undefined;continue;}knownPoints++;
      if(balance.side==='balanced'){const last=events.at(-1);if(last?.kind==='balanced_samples'&&last.upper===x-1)last.upper=x;else events.push({kind:'balanced_samples',lower:x,upper:x});}
      else if(previous&&previous.value===x-1&&previous.side!=='balanced'&&previous.side!==balance.side)events.push({kind:'regime_change',lower:previous.value,upper:x});
      previous={value:x,side:balance.side};
    }out.push({seriesId,roof,knownPoints,expectedPoints:expected,events});
  }return out;
}
export async function studyRoofline(input:Scenario,library:AssetDocument[],inputRequest:RooflineStudyRequest,control:CapacitySearchControl={}):Promise<RooflineStudyAttempt>{
  try{
    const pack=calculationInput(input,library),request=RooflineStudyRequest.parse(inputRequest),count=request.scan?request.scan.searchRange.max-request.scan.searchRange.min+1:0;
    if(request.scan&&(!Number.isSafeInteger(count)||count<1||count+1>MAX_ROOFLINE_ANALYSES))throw Error('扫描需有序且基础分析与逐点总计不超过512次');
    const analysis=await analyzeScenario(pack.scenario,pack.assets),base=rooflineSample(analysis,pack.scenario,pack.assets,request),samples:RooflineStudySample[]=[];control.onProgress?.(1,count+1);await control.yieldControl?.();
    const scan=request.scan&&!control.isCancelled?.()?await searchCapacity(pack.scenario,pack.assets,request.scan,{...control,onProgress:(n)=>control.onProgress?.(n+1,count+1),onAnalysis:(value,a)=>{samples.push(rooflineSample(a,pack.scenario,pack.assets,request,value));control.onAnalysis?.(value,a);}}):undefined;
    const attempt=RooflineStudyAttempt.parse({status:'available',result:{version:'roofline-study.1',engineVersion:ENGINE_VERSION,scenario:pack.scenario,assets:pack.assets,request,completion:control.isCancelled?.()||scan?.status==='available'&&scan.result.completion==='cancelled'?'cancelled':'complete',analysis,base,samples,...(scan?{scan}:{}),transitions:request.scan?rooflineTransitions(base,samples,count):[],assumptions:[
      '拐点为选定计算屋顶除以HBM带宽，单位operation/byte；限制侧比较operations/compute与bytes/bandwidth，只表示该Roofline假设，不识别真实内核瓶颈。',
      '模块/模型点使用物理执行工作与完整范围流量、范围跨度，屋顶池化唯一物理设备；可能掩盖异构、负载不均、局部瓶颈和多流争用，不是线性加速承诺。',
      '有效屋顶仅在每设备同一精度的局部屋顶唯一时池化；效率不一致或缺少参与点则不可用，原始硬件声明屋顶独立保留。',
      '混合精度分别列出，每类使用完整选定范围流量作为共享流量假设；logical代理流量不是完整物理HBM，不将未知HBM补零。',
      '整数扫描仅报告平衡采样点与相邻限制侧变化，不插值、不证明连续根、唯一性或范围外行为；缺项断开，固定输入/公式和每点hash随报告导出。',
      '多步decode明确选择单个步骤研究，不将不同上下文/效率的步骤聚合成一个屋顶；完整序列时间与容量仍使用原始分析和容量结果。',
      '屋顶不把多流争用折算成恒定效率；预测点保留原执行计划的时间。超容量点仍可研究公式，但不构成可运行建议，容量判断沿原逐点结果单列。',
    ]}});
    if(attempt.status==='available'){const issues=validateRooflineStudy(attempt.result);if(issues.length)return {status:'unavailable',diagnostics:issues};}return attempt;
  }catch(e){return {status:'unavailable',diagnostics:[{diagnosticId:'roofline-study-invalid',severity:'error',code:'invalid_roofline_study',message:e instanceof Error?e.message:'Roofline研究失败',location:{kind:'file',name:'roofline-study'}}]};}
}
