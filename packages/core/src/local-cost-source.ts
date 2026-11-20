import {z} from 'zod';
import {DeviceId,type MetricValue,type Quantity,type ValueExpr} from '@model-analyser/contracts';
import {canonical} from '../../contracts/src/validation.js';
import {jsonBytes} from '../../contracts/src/json-size.js';
import {LeafCostSelector,LeafCostSourceRequest} from './leaf-cost-context.js';
import {computeInputHash,stableStringify} from './input-hash.js';
import {resolveParallelPlan} from './parallel-plan.js';
import {explainValue} from './formula.js';
import {ENGINE_VERSION} from './version.js';
import {namespaceDiagnostics} from './decode.js';
import type {LocalCostDeclaration,LocalCostObservation} from './local-cost-observation.js';

export const LocalCostSelector=LeafCostSelector.extend({deviceId:DeviceId,computeIndex:z.number().int().nonnegative().optional()});
export type LocalCostSelector=z.infer<typeof LocalCostSelector>;
export const LocalCostSourceRequest=LeafCostSourceRequest.extend({selector:LocalCostSelector,decodeFrame:z.literal(true).optional()});
export type LocalCostSourceRequest=z.input<typeof LocalCostSourceRequest>;
const pageSize=20;

function compact(metric:MetricValue){
 return metric.status==='unavailable'?metric:{status:metric.status,quantity:metric.quantity,basis:metric.basis,diagnosticIds:metric.diagnosticIds};
}
function quantity(metric:ReturnType<typeof compact>,unit:Quantity['unit']){
 if(metric.status!=='available'||metric.quantity.unit!==unit)throw Error('原局部操作数或单位不可用');
 return metric.quantity;
}

export async function replayLocalCostSource(input:unknown){
 const request=LocalCostSourceRequest.parse(input),{scenario,assets,selector,stepContext,inputHash,engineVersion,page}=request;
 const {nodeId,deviceId,field,computeIndex,computeClass,scope}=selector;
 if(scenario.workload.kind==='decode'&&scenario.workload.steps!==1)throw Error('局部成本来源需要选择一个实际 Decode 步骤');
 if(request.decodeFrame&&!stepContext)throw Error('局部成本缺少实际 Decode 步骤上下文');
 const diagnosticPrefix=request.decodeFrame&&stepContext?`decode-step-${stepContext.index}::`:undefined;
 if(engineVersion!==ENGINE_VERSION||await computeInputHash(scenario,assets,stepContext)!==inputHash)throw Error('局部成本固定输入、实际步骤或引擎版本不匹配');

 const declarations=new Map<'local'|'global',LocalCostDeclaration>(),observations:LocalCostObservation[]=[];
 const replay=await resolveParallelPlan(scenario,assets,stepContext,{
  localCost:{nodeId,deviceId,timing:field==='seconds',record:record=>observations.push(record)},
  declaration:(record,kind)=>{if(declarations.has(kind))throw Error('成本声明身份不唯一');declarations.set(kind,record);},
 });
 if(replay.status!=='available'||replay.result.inputHash!==inputHash||replay.result.engineVersion!==engineVersion)throw Error('原局部布局身份不匹配或不能复算');
 const layout=replay.result,placed=layout.localCosts.nodes.find(n=>n.nodeId===nodeId)?.placement;
 const outcome=placed?.kind==='placed'?placed.perDevice.find(d=>d.deviceId===deviceId)?.outcome:undefined;
 const observed=observations[0];
 if(outcome?.status!=='available'||!observed||observations.length!==1||stableStringify(outcome)!==stableStringify(observed.outcome)||canonical(outcome.cost.scope)!==canonical(scope))throw Error('原局部节点、设备、求值或完整范围不匹配');
 const declaration=declarations.get(observed.singleDeviceBaseline?'global':'local');
 const participation=observed.singleDeviceBaseline?{kind:'complete_single_device' as const}:observed.rule?.participation;
 if(!declaration||!participation)throw Error('缺少原局部方程和词法参数');
 const {cost}=outcome;
 const isCompute=field==='usefulOperations'||field==='executedOperations';
 if(isCompute!==(computeIndex!==undefined)||isCompute!==!!computeClass)throw Error('局部计算指标须指定原计算段序号和完整类别');
 const row=computeIndex===undefined?undefined:cost.compute[computeIndex];
 if(isCompute&&(!row||canonical(row.computeClass)!==canonical(computeClass)))throw Error('原局部计算段序号或完整类别不同');
 const metric=isCompute?row?.[field]:cost[field];
 if(!metric||stableStringify(diagnosticPrefix?namespaceDiagnostics(metric,diagnosticPrefix):metric)!==stableStringify(request.metric))throw Error('原局部指标、单位或诊断不同');
 const timing=field==='seconds'?observed.effective.timing:undefined,roofline=timing?.kind==='roofline_bound';
 const {effective,accesses}=observed,authored=declaration.cost;
 const symbols={...declaration.symbols,...observed.symbols};
 const traffic=roofline||field==='logicalReadBytes'||field==='logicalWriteBytes'||field==='hbmBytes'?observed.overrides.find(o=>o.change.kind==='traffic'):undefined;
 const trafficChange=traffic?.change.kind==='traffic'?traffic.change:undefined;
 const timingOverrides=timing?observed.overrides.filter(o=>o.change.kind==='timing'):[];

 // Local equations use the actual device's placed data. Aliases resolve to the
 // allocation captured by the plan, while an access consumes all its copies.
 function storage(storageId:string){
  const allocation=layout.storageAllocations.find(s=>s.storageId===storageId||s.aliasIds.some(id=>id===storageId));
  const device=allocation?.allocation.perDevice.find(d=>d.deviceId===deviceId);
  if(!allocation||!device)throw Error('缺少局部方程使用的设备存储分配');
  const assignment=layout.storageLayouts.find(s=>s.nodeId===nodeId&&s.storageId===allocation.storageId);
  return {storageId,canonicalStorageId:allocation.storageId,assignmentIndices:allocation.assignmentIndices,
   ...(assignment?{distribution:assignment.distribution,overriddenIndices:assignment.overriddenIndices}:{}),
   copies:device.copies,allocatedShape:device.allocatedShape,allocation:device.allocation,totalBytes:compact(device.totalBytes)};
 }
 function bindingItem(binding:LocalCostObservation['outcome']['bindings'][number]){
  const {source}=binding;
  if(source.kind==='storage_bytes')return {kind:'binding' as const,binding,storage:storage(source.storageId)};
  const rule=layout.tensorLayouts.find(t=>t.nodeId===nodeId&&t.tensorId===source.tensorId);
  const device=rule?.partition.placements.find(p=>p.deviceId===deviceId);
  if(!rule||!device)throw Error('缺少局部方程读取的设备张量分布');
  const {logicalShape,allocatedShape,logicalElements,allocatedElements,slices,copies}=device;
  return {kind:'binding' as const,binding,tensor:{tensorId:source.tensorId,assignmentIndices:rule.assignmentIndices,overriddenIndices:rule.overriddenIndices,logicalShape,allocatedShape,logicalElements,allocatedElements,slices,copies}};
 }
 let complete=true;
 function formula(expr:ValueExpr,actual?:Quantity){
  const evidence=explainValue(expr,symbols,assets);
  if(actual&&canonical(evidence.quantity)!==canonical(actual))throw Error('声明公式与原局部操作数不同');
  if(evidence.truncated)complete=false;
  return evidence;
 }
 function computeItem(index:number,key:'usefulOperations'|'executedOperations'){
  const source=authored.compute[index],actual=cost.compute[index],bound=effective.compute[index];
  if(!source||!actual||!bound||source.segmentId!==bound.segmentId||canonical(source.computeClass)!==canonical(actual.computeClass))throw Error('声明计算段的身份或顺序不同');
  const operand=actual[key];
  return {kind:'compute' as const,index,segmentId:source.segmentId,computeClass:source.computeClass,field:key,metric:compact(operand),...(operand.status==='available'?{formula:formula(source[key],operand.quantity)}:{})};
 }
 let total=0;
 const accessSteps=new Map<number,{before:number;after:number}>();
 const accessIndices=effective.memoryAccess.flatMap((access,index)=>{
  const participates=roofline||field==='hbmBytes'||field==='logicalReadBytes'&&access.mode==='read'||field==='logicalWriteBytes'&&access.mode==='write';
  if(!participates&&!(trafficChange&&(field==='logicalReadBytes'||field==='logicalWriteBytes')))return [];
  const term=accesses[index];
  if(!term)throw Error('未记录实际成本访问项');
  const operand=roofline||field==='hbmBytes'?term.hbm:term.logical;
  if(participates&&operand.status==='available'){const before=total;total+=operand.quantity.value;accessSteps.set(index,{before,after:total});}
  return [index];
 });
 if((field==='hbmBytes'||field==='logicalReadBytes'||field==='logicalWriteBytes')&&metric.status==='available'&&total!==metric.quantity.value)throw Error('访问求和与原局部指标不同');
 if(roofline&&cost.hbmBytes.status==='available'&&total!==cost.hbmBytes.quantity.value)throw Error('访问求和与局部 Roofline 的 HBM 操作数不同');
 if(trafficChange&&traffic&&trafficChange.operands.reduce((n,operand)=>n+operand.originalBytes,0)!==trafficChange.originalTotal)throw Error('原局部流量覆盖分母与访问项不同');

 function accessItem(index:number){
  const source=authored.memoryAccess[index],access=effective.memoryAccess[index],term=accesses[index];
  if(!source||!access||!term||source.accessId!==access.accessId||source.mode!==access.mode)throw Error('声明访问项的身份或顺序不同');
  const {logical,hbm}=term,replacement=trafficChange?.operands[index];
  let logicalFormula:ReturnType<typeof formula>|undefined,allocation:ReturnType<typeof storage>|undefined;
  if(logical.status==='available'){
   const original=replacement?.originalBytes??quantity(logical,'byte').value;
   if(source.logicalBytes.kind==='storage_allocation'){
    logicalFormula=formula(source.logicalBytes.passes);
    const passed=logicalFormula.quantity;
    if(passed.unit!=='count'||!Number.isSafeInteger(passed.value)||passed.value<0)throw Error('局部分配访问 passes 无效');
    const bytes=passed.value===0?0:quantity((allocation=storage(access.storageId)).totalBytes,'byte').value*passed.value;
    if(bytes!==original)throw Error('每卡分配 × passes 与原局部逻辑流量不同');
   }else logicalFormula=formula(source.logicalBytes,{value:original,unit:'byte'});
   if(traffic&&trafficChange&&(!replacement||replacement.index!==index||replacement.originalBytes/trafficChange.originalTotal*traffic.override.value.value!==replacement.replacementBytes||replacement.replacementBytes!==logical.quantity.value))throw Error('记录的局部流量覆盖比例与实际访问不同');
  }
  const estimate=source.hbmEstimate;
  const hbmFormula=estimate?.kind==='bytes'&&hbm.status==='available'?formula(estimate.value,quantity(hbm,'byte')):undefined;
  if(estimate?.kind==='factor'&&logical.status==='available'&&hbm.status==='available'&&logical.quantity.value*estimate.value!==hbm.quantity.value)throw Error('局部 HBM 因子与实际访问不同');
  return {kind:'access' as const,index,accessId:access.accessId,mode:access.mode,storageId:access.storageId,
   logical:compact(logical),hbm:compact(hbm),accessKind:source.logicalBytes.kind,
   ...(logicalFormula?{logicalFormula}:{}),...(allocation?{allocation}:{}),...(replacement?{replacement}:{}),
   ...(estimate?.kind==='factor'?{hbmFactor:estimate.value}:{}),...(hbmFormula?{hbmFormula}:{}),
   ...(accessSteps.has(index)?{step:accessSteps.get(index)}:{})};
 }
 function durationItem(actual:MetricValue){
  if(!timing||roofline)throw Error('缺少局部固定或公式耗时');
  if(timing.kind==='fixed'){
   if(actual.status==='available'&&quantity(actual,'second').value!==timing.seconds)throw Error('生效固定耗时与原指标不同');
   return {kind:'fixed' as const,definition:timing};
  }
  if(authored.timing.kind!=='custom_formula')throw Error('缺少原局部耗时公式');
  return {kind:'custom_formula' as const,...(actual.status==='available'?{formula:formula(authored.timing.seconds,quantity(actual,'second'))}:{})};
 }
 const selectedCompute=computeIndex!==undefined?[computeIndex]:roofline?effective.compute.map((_,index)=>index):[];
 const componentReaders=[
  ...outcome.bindings.map(binding=>()=>bindingItem(binding)),
  ...selectedCompute.map(index=>()=>computeItem(index,field==='usefulOperations'?field:'executedOperations')),
  ...accessIndices.map(index=>()=>accessItem(index)),
  ...(timing&&!roofline?[()=>durationItem(metric)]:[]),
 ];
 const componentCount=componentReaders.length;
 const start=page*pageSize;
 if(page>0&&start>=componentCount)throw Error('请求的局部成本来源页不存在');
 const items=componentReaders.slice(start,start+pageSize).map(read=>read());
 const {timing:dag}=observed;
 if(roofline&&!dag)throw Error('缺少实际局部 Roofline 计算轨迹');
 const root=dag?.nodes.find(n=>n.id===dag.root);
 if(dag?.completeTiming&&(metric.status!=='available'||root?.value!==metric.quantity.value))throw Error('实际局部 Roofline 轨迹与原耗时不同');
 const diagnosticIds=new Set(metric.diagnosticIds);
 for(const item of items){
  if(item.kind==='access')for(const id of [...item.logical.diagnosticIds,...item.hbm.diagnosticIds])diagnosticIds.add(id);
  if(item.kind==='compute')for(const id of item.metric.diagnosticIds)diagnosticIds.add(id);
 }
 const diagnostics=layout.diagnostics.filter(d=>diagnosticIds.has(d.diagnosticId));
 const evidence={asset:declaration.asset,hardware:observed.hardware,metric,items,diagnostics,
  participation,
  deviceIds:observed.devices,...(observed.rule&&!observed.singleDeviceBaseline?{description:observed.rule.description}:{}),
  ...(timing?{timing}:{}),...(dag?{dag}:{}),timingOverrides,
  ...(traffic&&trafficChange?{trafficOverride:{index:traffic.index,override:traffic.override,originalTotal:trafficChange.originalTotal}}:{})};
 jsonBytes(evidence,8*1024*1024);
 return {kind:'local_cost_source' as const,schemaVersion:1 as const,inputHash,engineVersion,selector,page,pageSize,componentCount,
  complete:complete&&page===0&&componentCount<=pageSize&&metric.status==='available'&&(!dag||dag.completeTiming),...(diagnosticPrefix?namespaceDiagnostics(evidence,diagnosticPrefix):evidence),request};
}

export type LocalCostSourceReport=Awaited<ReturnType<typeof replayLocalCostSource>>;

export async function verifyLocalCostSourceReport(input:unknown){
 const saved=z.object({kind:z.literal('local_cost_source'),schemaVersion:z.literal(1),request:LocalCostSourceRequest}).passthrough().parse(input);
 const report=await replayLocalCostSource(saved.request);
 if(stableStringify(saved)!==stableStringify(report))throw Error('局部成本来源报告与固定输入复算不同');
 return report;
}
