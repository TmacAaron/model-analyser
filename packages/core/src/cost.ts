import type {CostObserver,CostObservation,CostDurationOrigin} from './cost-observation.js';
import type {LocalCostTerms} from './local-cost-observation.js';
import { CostResult,type CostDefinition,type HardwareDefinition,type MetricScope,type Diagnostic,type Quantity,type MetricValue } from '@model-analyser/contracts';
import { numericValue,type EvaluationContext } from './storage.js';
import { FormulaError } from './formula.js';
import { canonical,collectRefs } from '../../contracts/src/validation.js';
import { StorageId } from '@model-analyser/contracts';

export function memoryAccessBytes(access:CostDefinition['memoryAccess'][number],context:EvaluationContext):number{
  const expr=access.logicalBytes;if(expr.kind!=='storage_allocation')return numericValue(expr,'byte',context);
  const passes=numericValue(expr.passes,'count',context,true);if(passes===0)return 0;const allocation=context.storageBytes?.get(access.storageId);
  if(allocation?.status!=='available'||allocation.quantity.unit!=='byte')throw new FormulaError('missing_storage_allocation','访问 '+access.accessId+' 需要当前设备的已知物理分配 '+access.storageId);
  const bytes=allocation.quantity.value*passes;if(!Number.isFinite(bytes))throw new FormulaError('numeric_overflow','访问分配 × passes 超出数值范围');return bytes;
}
export function evaluateAggregateTiming(cost:CostResult,timing:CostDefinition['timing'],context:EvaluationContext,hardware?:HardwareDefinition):{seconds:MetricValue;diagnostics:Diagnostic[]}{
  const missing=[cost.hbmBytes,...cost.compute.map(c=>c.executedOperations)].filter(m=>m.status==='unavailable');if(timing.kind==='roofline_bound'&&missing.length)return {seconds:{status:'unavailable',diagnosticIds:[...new Set(missing.flatMap(m=>m.diagnosticIds))]},diagnostics:[]};
  const definition:CostDefinition={compute:cost.compute.map((c,index)=>({segmentId:String(index),computeClass:c.computeClass,usefulOperations:{kind:'literal',quantity:{value:0,unit:'operation'}},executedOperations:{kind:'literal',quantity:{value:c.executedOperations.status==='available'?c.executedOperations.quantity.value:0,unit:'operation'}}})),memoryAccess:[{accessId:'aggregate-hbm',storageId:StorageId.parse('$aggregate-hbm'),mode:'read',logicalBytes:{kind:'literal',quantity:{value:cost.hbmBytes.status==='available'?cost.hbmBytes.quantity.value:0,unit:'byte'}},hbmEstimate:{kind:'factor',value:1}}],temporaryStorageIds:[],timing};const evaluated=evaluateCost(definition,cost.scope,context,hardware);return {seconds:evaluated.cost.seconds,diagnostics:evaluated.diagnostics};
}

/** Evaluate a single declared leaf cost; no implicit graph expansion, replication or fusion. */
export function evaluateCost(cost:CostDefinition,scope:MetricScope,context:EvaluationContext,hardware?:HardwareDefinition,observe?:CostObserver,terms?:LocalCostTerms):{cost:CostResult;diagnostics:Diagnostic[]} {
  const emit=observe?(event:CostObservation)=>observe(structuredClone(event)):undefined;
  const diagnostics:Diagnostic[]=[];
  const prefix=`cost-${scope.phase}-${scope.target.kind}${scope.target.kind==='model'?'':scope.target.nodeId}-${scope.deviceIds.join('|')}`;
  const provenance=context.provenance??{assetRefs:context.assets.map(a=>({assetId:a.assetId,revision:a.revision,kind:a.definition.kind})),formulaRefs:collectRefs(cost),parameterSources:Object.keys(context.symbols).map(parameterKey=>({parameterKey,source:'evaluation_context'})),assumptions:['Only declared memory accesses are counted; HBM estimates require an explicit factor or bytes expression.']};
  function error(code:string,message:string){emit?.({kind:'error',code,message});const diagnosticId=`${prefix}-${diagnostics.length+1}`;diagnostics.push({diagnosticId,severity:'error',code,message,location:{kind:'file',name:'cost'}});return {status:'unavailable' as const,diagnosticIds:[diagnosticId]};}
  function metric(value:number,unit:Quantity['unit']):MetricValue {
    if(!Number.isFinite(value)||value<0)return error('numeric_overflow','成本结果不是非负有限数');
    const diagnosticIds:string[]=[];
    if(value>Number.MAX_SAFE_INTEGER){const diagnosticId=`${prefix}-${diagnostics.length+1}`;diagnostics.push({diagnosticId,severity:'warning',code:'precision_estimate',message:'超过安全整数，以浮点估计表示',location:{kind:'file',name:'cost'}});diagnosticIds.push(diagnosticId);}
    return {status:'available',quantity:{value,unit},basis:'theoretical',provenance,diagnosticIds};
  }
  function attempt(fn:()=>number,unit:Quantity['unit']):MetricValue{try{return metric(fn(),unit);}catch(e){return error(e instanceof FormulaError?e.code:'invalid_cost',e instanceof Error?e.message:'成本计算失败');}}
  function sum(values:MetricValue[],unit:Quantity['unit'],field?:'compute_seconds'):MetricValue {
    const missing=values.filter(v=>v.status==='unavailable');
    if(missing.length)return {status:'unavailable',diagnosticIds:[...new Set(missing.flatMap(v=>v.diagnosticIds))]};
    const value=values.reduce((n,v,index)=>{const operand=v.status==='available'?v.quantity.value:0,next=n+operand;if(field)emit?.({kind:'sum_step',field,index,left:n,right:operand,value:next});return next;},0);if(field)emit?.({kind:'sum_complete',field,value,count:values.length});return metric(value,unit);
  }
  function duration(work:number,peak:number,efficiency:number,origin?:CostDurationOrigin):MetricValue{
    if(work===0){emit?.({kind:'duration',origin,work,peak,efficiency,method:'zero',seconds:0});return metric(0,'second');}
    const denominator=peak*efficiency;let seconds=work/denominator;const direct=seconds;
    if(seconds===0||!Number.isFinite(seconds)){const logWork=Math.log(work),logPeak=Math.log(peak),logEfficiency=Math.log(efficiency),firstDifference=logWork-logPeak,logSeconds=firstDifference-logEfficiency;seconds=Math.exp(logSeconds);emit?.({kind:'log_fallback',origin,logWork,logPeak,logEfficiency,firstDifference,logSeconds,seconds});}
    emit?.({kind:'duration',origin,work,peak,efficiency,denominator,direct,method:direct===0||!Number.isFinite(direct)?'log_fallback':'division',seconds});return seconds===0?error('numeric_overflow','非零工作量的耗时下溢，不能报告为零'):metric(seconds,'second');
  }
  const compute=cost.compute.map(c=>{
    const usefulOperations=attempt(()=>numericValue(c.usefulOperations,'operation',context),'operation');
    let executedOperations=attempt(()=>numericValue(c.executedOperations,'operation',context),'operation');
    if(usefulOperations.status==='available'&&executedOperations.status==='available'&&executedOperations.quantity.value<usefulOperations.quantity.value)executedOperations=error('invalid_cost','执行工作量不得小于有效工作量');
    return {computeClass:c.computeClass,usefulOperations,executedOperations};
  });
  const accesses=cost.memoryAccess.map((a,index)=>{
    const logical=attempt(()=>memoryAccessBytes(a,context),'byte');
    let hbm:MetricValue;const estimate=a.hbmEstimate;
    if(!estimate)hbm=error('missing_hbm_estimate',`访问 ${a.accessId} 未声明 HBM 估计`);
    else if(estimate.kind==='bytes')hbm=attempt(()=>numericValue(estimate.value,'byte',context),'byte');
    else if(logical.status==='unavailable')hbm=logical;
    else {const bytes=logical.quantity.value*estimate.value;hbm=logical.quantity.value>0&&estimate.value>0&&bytes===0?error('numeric_overflow','非零 HBM 估计下溢，不能报告为零'):metric(bytes,'byte');}
    terms?.access?.(index,logical,hbm);
    return {mode:a.mode,logical,hbm};
  });
  const logicalReadBytes=sum(accesses.filter(a=>a.mode==='read').map(a=>a.logical),'byte'),logicalWriteBytes=sum(accesses.filter(a=>a.mode==='write').map(a=>a.logical),'byte'),hbmBytes=sum(accesses.map(a=>a.hbm),'byte');
  let seconds:MetricValue;
  const timing=cost.timing;
  if(timing.kind==='fixed')seconds=metric(timing.seconds,'second');
  else if(timing.kind==='custom_formula')seconds=attempt(()=>numericValue(timing.seconds,'second',context),'second');
  else {
    const computeTimes=compute.map((c,index)=>{
      if(c.executedOperations.status==='unavailable')return c.executedOperations;
      const matching=hardware?.computeCapabilities.filter(h=>canonical(h.computeClass)===canonical(c.computeClass))??[];emit?.({kind:'compute_capability',segmentId:cost.compute[index]?.segmentId,computeClass:c.computeClass,matchingCount:matching.length,matches:matching.slice(0,2),declaredEfficiency:timing.computeEfficiency});
      if(matching.length!==1)return error('missing_compute_capability','需要唯一匹配的计算精度/资源能力；不按位宽猜测倍速');
      const capability=matching[0];if(!capability)return error('missing_compute_capability','缺少计算能力');
      if(capability.kind==='effective'&&timing.computeEfficiency!==1)return error('invalid_efficiency','有效计算能力不能再次乘效率');
      return duration(c.executedOperations.quantity.value,capability.operationsPerSecond,capability.kind==='peak'?timing.computeEfficiency:1,observe?{kind:'compute',evaluationIndex:index,segmentId:cost.compute[index]?.segmentId,computeClass:c.computeClass,capabilityIndex:hardware?.computeCapabilities.indexOf(capability),capabilityKind:capability.kind}:undefined);
    });
    const computeSeconds=sum(computeTimes,'second','compute_seconds'),memory=hardware?.memoryCapabilities.filter(m=>m.key==='hbm')??[];
    emit?.({kind:'memory_capability',key:'hbm',matchingCount:memory.length,matches:memory.slice(0,2),declaredEfficiency:timing.memoryEfficiency});let memorySeconds:MetricValue;
    if(hbmBytes.status==='unavailable')memorySeconds=hbmBytes;
    else if(memory.length!==1||!memory[0])memorySeconds=error('missing_memory_capability','需要唯一匹配的 hbm 带宽能力');
    else if(memory[0].kind==='effective'&&timing.memoryEfficiency!==1)memorySeconds=error('invalid_efficiency','有效带宽不能再次乘效率');
    else memorySeconds=duration(hbmBytes.quantity.value,memory[0].bytesPerSecond,memory[0].kind==='peak'?timing.memoryEfficiency:1,observe?{kind:'memory',capabilityIndex:hardware?.memoryCapabilities.indexOf(memory[0]),capabilityKind:memory[0].kind}:undefined);
    if(computeSeconds.status==='available'&&memorySeconds.status==='available'){const combined=timing.computeMemoryOverlap==='ideal'?Math.max(computeSeconds.quantity.value,memorySeconds.quantity.value):computeSeconds.quantity.value+memorySeconds.quantity.value,finalSeconds=combined+timing.launchSeconds;emit?.({kind:'overlap',operation:timing.computeMemoryOverlap==='ideal'?'max':'sum',computeSeconds:computeSeconds.quantity.value,memorySeconds:memorySeconds.quantity.value,value:combined});emit?.({kind:'launch',operation:'add',combined,launchSeconds:timing.launchSeconds,seconds:finalSeconds});seconds=metric(finalSeconds,'second');}
    else seconds=sum([computeSeconds,memorySeconds],'second');
  }
  return {cost:CostResult.parse({scope,compute,logicalReadBytes,logicalWriteBytes,hbmBytes,communications:[],seconds}),diagnostics};
}
