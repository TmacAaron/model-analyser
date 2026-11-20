import {z} from 'zod';
import {DeviceId,NodeId,type MetricValue,type Quantity,type ValueExpr} from '@model-analyser/contracts';
import {canonical} from '../../contracts/src/validation.js';
import {jsonBytes} from '../../contracts/src/json-size.js';
import {LeafCostSelector,LeafCostSourceRequest} from './leaf-cost-context.js';
import {computeInputHash,stableStringify} from './input-hash.js';
import {resolveParallelPlan} from './parallel-plan.js';
import {explainValue} from './formula.js';
import {ENGINE_VERSION} from './version.js';
import {namespaceDiagnostics} from './decode.js';
import {localParameterBindingGraph,parameterReads,type AdditionalParameterRoot} from './parameter-binding-graph.js';
import type {LocalCostDeclaration,LocalCostObservation} from './local-cost-observation.js';
import type {FusionDeclaration} from './fusion-observation.js';
import type {LayoutSourceSelector} from './layout-source.js';
import type {ParameterCaptureTrace} from './parameter-observation.js';
import {rooflineMetricInputs} from './timing-dag.js';

export const LocalCostSelector=LeafCostSelector.extend({deviceId:DeviceId,computeIndex:z.number().int().nonnegative().optional(),fusionNodeId:NodeId.optional()});
export type LocalCostSelector=z.infer<typeof LocalCostSelector>;
export const LocalCostSourceRequest=LeafCostSourceRequest.extend({selector:LocalCostSelector,decodeFrame:z.literal(true).optional(),proofVersion:z.union([z.literal(2),z.literal(3)]).optional()});
export type LocalCostSourceRequest=z.input<typeof LocalCostSourceRequest>;
const pageSize=20;
type LocalBinding=LocalCostObservation['outcome']['bindings'][number];
type ExpressionField=
 |{kind:'compute';index:number;segmentId:string;field:'usefulOperations'|'executedOperations'}
 |{kind:'access';index:number;accessId:string;field:'logicalBytes'|'passes'|'hbmBytes'}
 |{kind:'timing';field:'seconds'};
type PhysicalSource={kind:'physical';bindingIndex:number;source:LocalBinding['source'];layout:LayoutSourceSelector};
type ExpressionRead={expression:ExpressionField;label:string;name:string;quantity:Quantity;source:PhysicalSource|{kind:'parameter';frameId?:string}};

function expressionLabel(expression:ExpressionField){
 if(expression.kind==='compute')return expression.segmentId+' · '+(expression.field==='usefulOperations'?'有效工作':'执行工作');
 if(expression.kind==='access')return expression.accessId+' · '+({logicalBytes:'逻辑流量',passes:'访问次数',hbmBytes:'HBM 字节'}[expression.field]);
 return '自定义逐卡耗时';
}

function compact(metric:MetricValue){
 return metric.status==='unavailable'?metric:{status:metric.status,quantity:metric.quantity,basis:metric.basis,diagnosticIds:metric.diagnosticIds};
}
function quantity(metric:ReturnType<typeof compact>,unit:Quantity['unit']){
 if(metric.status!=='available'||metric.quantity.unit!==unit)throw Error('原局部操作数或单位不可用');
 return metric.quantity;
}

export async function replayLocalCostSource(input:unknown){
 const request=LocalCostSourceRequest.parse(input),{scenario,assets,selector,stepContext,inputHash,engineVersion,page}=request;
 const extended=request.proofVersion!==undefined;
 const {nodeId,deviceId,field,computeIndex,computeClass,scope,fusionNodeId}=selector;
 if(scenario.workload.kind==='decode'&&scenario.workload.steps!==1)throw Error('局部成本来源需要选择一个实际 Decode 步骤');
 if(request.decodeFrame&&!stepContext)throw Error('局部成本缺少实际 Decode 步骤上下文');
 const diagnosticPrefix=request.decodeFrame&&stepContext?`decode-step-${stepContext.index}::`:undefined;
 if(engineVersion!==ENGINE_VERSION||await computeInputHash(scenario,assets,stepContext)!==inputHash)throw Error('局部成本固定输入、实际步骤或引擎版本不匹配');

 const declarations=new Map<'local'|'global',LocalCostDeclaration>(),observations:LocalCostObservation[]=[];
 const fusionDeclarations:FusionDeclaration[]=[];
 let fusionBindingTrace:ParameterCaptureTrace|undefined;
 const localCost={nodeId,deviceId,timing:field==='seconds',record:(record:LocalCostObservation)=>observations.push(record)};
 const replay=await resolveParallelPlan(scenario,assets,stepContext,fusionNodeId?{fusion:{
  nodeId:fusionNodeId,extra:localCost,declaration:record=>fusionDeclarations.push(record),
  ...(extended?{bindings:(trace:ParameterCaptureTrace)=>{fusionBindingTrace=trace;}}:{}),
 }}:{
  localCost,
  declaration:(record,kind)=>{if(declarations.has(kind))throw Error('成本声明身份不唯一');declarations.set(kind,record);},
  ...(extended?{bindings:true as const}:{}),
 });
 if(replay.status!=='available'||replay.result.inputHash!==inputHash||replay.result.engineVersion!==engineVersion)throw Error('原局部布局身份不匹配或不能复算');
 const layout=replay.result,placed=layout.localCosts.nodes.find(n=>n.nodeId===nodeId)?.placement;
 const fusion=fusionNodeId?layout.fusions.find(f=>f.application.nodeId===fusionNodeId&&f.application.extraNodeId===nodeId):undefined;
 const deviceRows=fusionNodeId?fusion?.extraPerDevice:placed?.kind==='placed'?placed.perDevice:undefined;
 const outcome=deviceRows?.find(d=>d.deviceId===deviceId)?.outcome;
 const observed=observations[0];
 if(outcome?.status!=='available'||!observed||observations.length!==1||stableStringify(outcome)!==stableStringify(observed.outcome)||canonical(outcome.cost.scope)!==canonical(scope))throw Error('原局部节点、设备、求值或完整范围不匹配');
 const authoredFusion=fusion?scenario.fusionGroups.find(g=>g.groupId===fusion.application.groupId):undefined;
 const fusionDeclaration=fusionDeclarations[0];
 const useLocalRule=!observed.singleDeviceBaseline&&!!observed.rule;
 const declaration:LocalCostDeclaration|undefined=authoredFusion&&fusionDeclaration?{
  asset:authoredFusion.origin?.asset??scenario.model,
  cost:useLocalRule&&authoredFusion.extraLocalCost?authoredFusion.extraLocalCost.rule.cost:authoredFusion.extraCost,
  symbols:useLocalRule?fusionDeclaration.extraLocalSymbols??{}:fusionDeclaration.symbols,
 }:declarations.get(useLocalRule?'local':'global');
 const participation=useLocalRule?observed.rule?.participation:fusion?{kind:'fusion_extra_device' as const}:observed.singleDeviceBaseline?{kind:'complete_single_device' as const}:undefined;
 if(!declaration||!participation)throw Error('缺少原局部方程和词法参数');
 const layoutNodeId=useLocalRule&&fusion?fusion.application.extraLocalCost?.contextNodeId??nodeId:nodeId;
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
  const assignment=layout.storageLayouts.find(s=>s.nodeId===layoutNodeId&&s.storageId===allocation.storageId);
  return {storageId,canonicalStorageId:allocation.storageId,assignmentIndices:allocation.assignmentIndices,
   ...(assignment?{distribution:assignment.distribution,overriddenIndices:assignment.overriddenIndices}:{}),
   copies:device.copies,allocatedShape:device.allocatedShape,allocation:device.allocation,totalBytes:compact(device.totalBytes)};
 }
 function bindingItem(binding:LocalBinding){
  const {source}=binding;
  if(source.kind==='storage_bytes')return {kind:'binding' as const,binding,storage:storage(source.storageId)};
  const rule=layout.tensorLayouts.find(t=>t.nodeId===layoutNodeId&&t.tensorId===source.tensorId);
  const device=rule?.partition.placements.find(p=>p.deviceId===deviceId);
  if(!rule||!device)throw Error('缺少局部方程读取的设备张量分布');
  const {logicalShape,allocatedShape,logicalElements,allocatedElements,slices,copies}=device;
  return {kind:'binding' as const,binding,tensor:{tensorId:source.tensorId,assignmentIndices:rule.assignmentIndices,overriddenIndices:rule.overriddenIndices,logicalShape,allocatedShape,logicalElements,allocatedElements,slices,copies}};
 }
 const reads:ExpressionRead[]=[],parameterRoots:AdditionalParameterRoot[]=[];
 const physicalBindings=new Map(extended?outcome.bindings.map((binding,index)=>[binding.symbol,{binding,index}] as const):[]);
 const physicalSources=new Map<string,PhysicalSource>();
 const frameBySymbol=useLocalRule?fusionDeclaration?.parameterFrames?.extraLocal:fusionDeclaration?.parameterFrames?.root;
 function parameterFrame(name:string){
  if(declaration?.bindingContext?.frameId)return declaration.bindingContext.frameId;
  return frameBySymbol&&Object.hasOwn(frameBySymbol,name)?frameBySymbol[name]:undefined;
 }
 function physicalSource(binding:LocalBinding,index:number):PhysicalSource{
  const cached=physicalSources.get(binding.symbol);
  if(cached)return cached;
  const {source}=binding,item=bindingItem(binding);
  let selector:LayoutSourceSelector,expected:Quantity|undefined;
  if(source.kind==='storage_bytes'&&'storage'in item&&item.storage){
   const value=item.storage;
   expected=quantity(source.basis==='per_copy'?value.allocation.totalBytes:value.totalBytes,'byte');
   selector={kind:'storage',storageId:value.canonicalStorageId,deviceId};
  }else if(source.kind!=='storage_bytes'&&'tensor'in item&&item.tensor){
   const value=item.tensor;
   selector={kind:'tensor',nodeId:layoutNodeId,tensorId:source.tensorId,deviceId};
   if(source.kind==='tensor_copies')expected={value:value.copies,unit:'count'};
   else if(source.kind==='tensor_elements')expected={value:source.basis==='logical'?value.logicalElements:value.allocatedElements,unit:'count'};
   else if(source.kind==='tensor_axis'){
    const axis=(source.basis==='logical'?value.logicalShape:value.allocatedShape).find(a=>a.axisId===source.axisId);
    if(axis?.size.kind==='literal')expected=axis.size.quantity;
   }else{
    const slice=value.slices.find(s=>s.axisId===source.axisId);
    if(slice)expected={value:slice[source.edge],unit:'count'};
   }
  }else throw Error('未找到逐卡实参的原布局');
  if(!expected||canonical(expected)!==canonical(binding.quantity))throw Error('设备布局与原逐卡实参不同');
  const result={kind:'physical' as const,bindingIndex:index,source,layout:selector};
  physicalSources.set(binding.symbol,result);
  return result;
 }
 let complete=true,readsTruncated=false;
 function formula(expr:ValueExpr,expression:ExpressionField,actual?:Quantity){
  const evidence=explainValue(expr,symbols,assets);
  if(actual&&canonical(evidence.quantity)!==canonical(actual))throw Error('声明公式与原局部操作数不同');
  if(evidence.truncated)complete=false;
  if(extended&&!readsTruncated){
   const operands=parameterReads(evidence.proof,(name,quantity)=>({name,quantity,target:expressionLabel(expression),frameId:parameterFrame(name)??'unrecorded-local-frame'}));
   for(const read of operands){
    if(reads.length===256){readsTruncated=true;break;}
    const physical=physicalBindings.get(read.name);
    if(physical){
     if(canonical(physical.binding.quantity)!==canonical(read.quantity))throw Error('公式读取值与实际设备绑定不同');
     reads.push({expression,label:read.target,name:read.name,quantity:read.quantity,source:physicalSource(physical.binding,physical.index)});
    }else{
     parameterRoots.push(read);
     const frameId=parameterFrame(read.name);
     reads.push({expression,label:read.target,name:read.name,quantity:read.quantity,source:{kind:'parameter',...(frameId?{frameId}:{})}});
    }
   }
  }
  return evidence;
 }
 function computeItem(index:number,key:'usefulOperations'|'executedOperations'){
  const source=authored.compute[index],actual=cost.compute[index],bound=effective.compute[index];
  if(!source||!actual||!bound||source.segmentId!==bound.segmentId||canonical(source.computeClass)!==canonical(actual.computeClass))throw Error('声明计算段的身份或顺序不同');
  const operand=actual[key];
  return {kind:'compute' as const,index,segmentId:source.segmentId,computeClass:source.computeClass,field:key,metric:compact(operand),...(operand.status==='available'?{
   formula:formula(source[key],{kind:'compute',index,segmentId:source.segmentId,field:key},operand.quantity),
  }:{})};
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

 const authoredAccess=new Map(authored.memoryAccess.map(access=>[access.accessId,access]));
 function accessItem(index:number){
  const access=effective.memoryAccess[index],term=accesses[index],source=access?authoredAccess.get(access.accessId):undefined;
  if(!source||!access||!term||source.mode!==access.mode)throw Error('找不到生效访问项的原声明');
  const {logical,hbm}=term,replacement=trafficChange?.operands[index];
  let logicalFormula:ReturnType<typeof formula>|undefined,allocation:ReturnType<typeof storage>|undefined;
  if(logical.status==='available'){
   const original=replacement?.originalBytes??quantity(logical,'byte').value;
   if(source.logicalBytes.kind==='storage_allocation'){
    logicalFormula=formula(source.logicalBytes.passes,{kind:'access',index,accessId:source.accessId,field:'passes'});
    const passed=logicalFormula.quantity;
    if(passed.unit!=='count'||!Number.isSafeInteger(passed.value)||passed.value<0)throw Error('局部分配访问 passes 无效');
    const bytes=passed.value===0?0:quantity((allocation=storage(access.storageId)).totalBytes,'byte').value*passed.value;
    if(bytes!==original)throw Error('每卡分配 × passes 与原局部逻辑流量不同');
   }else logicalFormula=formula(source.logicalBytes,{kind:'access',index,accessId:source.accessId,field:'logicalBytes'},{value:original,unit:'byte'});
   if(traffic&&trafficChange&&(!replacement||replacement.index!==index||replacement.originalBytes/trafficChange.originalTotal*traffic.override.value.value!==replacement.replacementBytes||replacement.replacementBytes!==logical.quantity.value))throw Error('记录的局部流量覆盖比例与实际访问不同');
  }
  const estimate=source.hbmEstimate;
  const hbmFormula=estimate?.kind==='bytes'&&hbm.status==='available'?formula(estimate.value,{kind:'access',index,accessId:source.accessId,field:'hbmBytes'},quantity(hbm,'byte')):undefined;
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
  return {kind:'custom_formula' as const,...(actual.status==='available'?{formula:formula(authored.timing.seconds,{kind:'timing',field:'seconds'},quantity(actual,'second'))}:{})};
 }
 const selectedCompute=computeIndex!==undefined?[computeIndex]:roofline?effective.compute.map((_,index)=>index):[];
 const bindings=outcome.bindings.map(binding=>()=>bindingItem(binding));
 const equations=[
  ...selectedCompute.map(index=>()=>computeItem(index,field==='usefulOperations'?field:'executedOperations')),
  ...accessIndices.map(index=>()=>accessItem(index)),
  ...(timing&&!roofline?[()=>durationItem(metric)]:[]),
 ];
 const componentReaders=request.proofVersion===3?[...equations,...bindings]:[...bindings,...equations];
 const componentCount=componentReaders.length;
 const start=page*pageSize;
 if(page>0&&start>=componentCount)throw Error('请求的局部成本来源页不存在');
 const items=componentReaders.slice(start,start+pageSize).map(read=>read());
 const {timing:dag}=observed;
 if(roofline&&!dag)throw Error('缺少实际局部 Roofline 计算轨迹');
 const root=dag?.nodes.find(n=>n.id===dag.root);
 if(dag?.completeTiming&&(metric.status!=='available'||root?.value!==metric.quantity.value))throw Error('实际局部 Roofline 轨迹与原耗时不同');
 const rooflineOperands=request.proofVersion===3&&dag?rooflineMetricInputs(dag,cost,index=>effective.compute[index]?.segmentId).map(input=>({
  timingNodeId:input.timingNodeId,quantity:input.quantity,
  selector:{nodeId,deviceId,scope,field:input.field,...(fusionNodeId?{fusionNodeId}:{}),
   ...(input.field==='executedOperations'?{computeIndex:input.computeIndex,computeClass:input.computeClass}:{})},
  ...(input.field==='executedOperations'?{segmentId:input.segmentId}:{}),
 })):undefined;
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
 const trace=declaration.bindingContext?.trace??fusionBindingTrace;
 if(extended&&!trace)throw Error('未采集到原逐卡词法参数域');
 const parameterBindings=trace?localParameterBindingGraph({...trace,truncated:trace.truncated||!complete||readsTruncated},assets,parameterRoots):undefined;
 const expressionOperandsComplete=complete&&!readsTruncated&&(parameterBindings?.complete??false);
 return {kind:'local_cost_source' as const,schemaVersion:request.proofVersion??(1 as const),inputHash,engineVersion,selector,page,pageSize,componentCount,
  complete:complete&&page===0&&componentCount<=pageSize&&metric.status==='available'&&(!dag||dag.completeTiming)&&(!extended||expressionOperandsComplete),
  ...(diagnosticPrefix?namespaceDiagnostics(evidence,diagnosticPrefix):evidence),
  ...(extended?{expressionOperands:reads,expressionOperandsComplete,parameterBindings}:{}),...(rooflineOperands?{rooflineOperands}:{}),request};
}

export type LocalCostSourceReport=Awaited<ReturnType<typeof replayLocalCostSource>>;

export async function verifyLocalCostSourceReport(input:unknown){
 const saved=z.object({kind:z.literal('local_cost_source'),schemaVersion:z.union([z.literal(1),z.literal(2),z.literal(3)]),request:LocalCostSourceRequest}).passthrough().parse(input);
 const report=await replayLocalCostSource(saved.request);
 if(stableStringify(saved)!==stableStringify(report))throw Error('局部成本来源报告与固定输入复算不同');
 return report;
}
