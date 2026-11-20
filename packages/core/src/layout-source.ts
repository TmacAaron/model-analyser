import {z} from 'zod';
import {DeviceId,NodeId,StorageId,TensorId,type Quantity,type Shape,type TensorDistribution,type ValueExpr} from '@model-analyser/contracts';
import {canonical} from '../../contracts/src/validation.js';
import {jsonBytes} from '../../contracts/src/json-size.js';
import {LeafCostSourceRequest} from './leaf-cost-context.js';
import {calculationInput,computeInputHash,stableStringify} from './input-hash.js';
import {resolveParallelPlan} from './parallel-plan.js';
import {partitionTensor} from './partition.js';
import {allocateDistributedStorage} from './distributed-storage.js';
import {namespaceDiagnostics} from './decode.js';
import {explainValue,evaluateValue} from './formula.js';
import {ENGINE_VERSION} from './version.js';
import type {AllocationObservation} from './storage.js';
import type {LayoutDeclaration,LayoutRecipe,LayoutRuleEvidence,PartitionOperation,StorageLayoutOrigin} from './layout-observation.js';
import type {QuantizationObservation} from './quantization-observation.js';

export const LayoutSourceSelector=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('tensor'),nodeId:NodeId,tensorId:TensorId,deviceId:DeviceId}),
 z.strictObject({kind:z.literal('storage'),storageId:StorageId,deviceId:DeviceId}),
]);
export type LayoutSourceSelector=z.infer<typeof LayoutSourceSelector>;
export const LayoutSourceRequest=LeafCostSourceRequest.omit({selector:true,metric:true}).extend({selector:LayoutSourceSelector});
export type LayoutSourceRequest=z.input<typeof LayoutSourceRequest>;
const pageSize=20;

function deviceDistribution(distribution:TensorDistribution,deviceId:DeviceId){
 if(distribution.kind==='manual')return {kind:distribution.kind,groupId:distribution.groupId,description:distribution.description,
  memberCount:distribution.members.length,member:distribution.members.find(m=>m.deviceId===deviceId)};
 if(distribution.kind==='sharded'&&distribution.policy.kind==='explicit')return {...distribution,policy:{kind:'explicit' as const,
  slices:distribution.policy.slices.filter(s=>s.deviceId===deviceId),totalSlices:distribution.policy.slices.length}};
 return distribution;
}
type Distribution=ReturnType<typeof deviceDistribution>;
type FormulaEntry={field:string;expression:ValueExpr;expected:ValueExpr;symbols:Record<string,Quantity>};
type QuantizationDecision=Extract<QuantizationObservation,{kind:'rule_decision'}>;
type LayoutItem=
 |{kind:'rule';rule:Omit<LayoutRuleEvidence,'declared'|'effective'>&{declared:Distribution;effective:Distribution}}
 |{kind:'origin';origin:Omit<StorageLayoutOrigin,'distribution'>&{distribution:Distribution}}
 |{kind:'formula';field:string;formula:ReturnType<typeof explainValue>}
 |{kind:'partition';operation:PartitionOperation}
 |{kind:'allocation';operation:AllocationObservation}
 |{kind:'copies';perCopyBytes:number;copies:number;totalBytes:number}
 |{kind:'quantization';nodeId:NodeId;winners:QuantizationDecision['winners'];losers:QuantizationDecision['losers']};

function sameQuantity(quantity:Quantity,expected:Quantity){
 if(quantity.value!==expected.value||quantity.unit!==expected.unit)throw Error('原布局公式返回值与实际操作数不同');
}

export async function replayLayoutSource(input:unknown){
 const request=LayoutSourceRequest.parse(input),{scenario,assets,stepContext,selector,engineVersion,inputHash,page}=request;
 const {deviceId}=selector;
 if(scenario.workload.kind==='decode'&&scenario.workload.steps!==1)throw Error('设备布局来源需要单个实际 Decode 步骤');
 if(engineVersion!==ENGINE_VERSION||await computeInputHash(scenario,assets,stepContext)!==inputHash)throw Error('原设备布局的固定输入、步骤或引擎版本不同');
 const recipes:LayoutRecipe[]=[],declarations:LayoutDeclaration[]=[],quantizationEvents:QuantizationObservation[]=[];
 let quantizationTruncated=false;
 const attempt=await resolveParallelPlan(scenario,assets,stepContext,{layout:{
  target:selector,record:record=>recipes.push(record),declaration:record=>declarations.push(record),
  ...(selector.kind==='storage'?{quantization:{storageIds:new Set([selector.storageId]),record:event=>{quantizationEvents.push(event);},truncated:()=>{quantizationTruncated=true;}}}:{}),
 }});
 if(attempt.status!=='available'||attempt.result.inputHash!==inputHash||attempt.result.engineVersion!==engineVersion)throw Error('原设备布局未能按固定输入复算');
 const recipe=recipes[0],declaration=declarations[0];
 if(!recipe||recipes.length!==1||recipe.kind!==selector.kind||declarations.length>1)throw Error('原张量或规范存储不存在或作用域不唯一');
 const {assets:library}=calculationInput(scenario,assets),context={symbols:recipe.symbols,assets:library},partitionEvents:PartitionOperation[]=[],allocationEvents:AllocationObservation[]=[];
 const partition={deviceId,record:(operation:PartitionOperation)=>partitionEvents.push(operation)};
 const formulas:FormulaEntry[]=[];
 function axes(field:string,source:Shape,expected:Shape,symbols:Record<string,Quantity>){
  for(const axis of source){
   const effective=expected.find(a=>a.axisId===axis.axisId);
   if(!effective)throw Error('原布局轴缺少稳定映射 '+axis.axisId);
   formulas.push({field:field+' · '+axis.axisId,expression:axis.size,expected:effective.size,symbols});
  }
 }

 const decisions=quantizationEvents.filter(event=>event.kind==='rule_decision');
 const origins:StorageLayoutOrigin[]=recipe.kind==='storage'?recipe.origins:[];
 let allocationTruncated=false,copies:Extract<LayoutItem,{kind:'copies'}>|undefined;
 let storageEvidence:{
  copies:number;allocatedShape:Shape;perCopyBytes?:number;totalBytes?:number;materialization:'materialized'|'elided';
  canonicalStorageId:StorageId;aliases:StorageId[];assignmentIndices:number[];elidedBy?:NodeId;override?:Extract<LayoutRecipe,{kind:'storage'}>['override'];
  quantization?:{payloadBits:number;packingUnitElements:number;alignmentBytes:number;stage:'effective'|'overridden'|'elided';ruleIndex?:number;nodeId?:NodeId};
 }|undefined;
 let tensorEvidence:{
  globalShape:Shape;logicalShape:Shape;allocatedShape:Shape;logicalElements:number;allocatedElements:number;copies:number;
  assignmentIndices:number[];overriddenIndices:number[];coverage:string;
 }|undefined;
 let diagnostics:typeof attempt.result.diagnostics=[];
 const effectiveDistribution=recipe.kind==='tensor'?recipe.row.partition.distribution:recipe.row.allocation.distribution;

 if(recipe.kind==='tensor'&&selector.kind==='tensor'){
  const recorded=attempt.result.tensorLayouts.find(t=>t.nodeId===selector.nodeId&&t.tensorId===selector.tensorId);
  const replay=partitionTensor(recipe.tensor,effectiveDistribution,recipe.topology,context,partition);
  if(!recorded||canonical(recorded)!==canonical(recipe.row)||replay.status!=='available'||canonical(replay.result)!==canonical(recorded.partition))throw Error('设备张量推导与原分布不同');
  const p=recorded.partition.placements.find(row=>row.deviceId===deviceId);
  if(!p)throw Error('张量分布未使用所选设备');
  tensorEvidence={globalShape:recorded.partition.globalShape,logicalShape:p.logicalShape,allocatedShape:p.allocatedShape,logicalElements:p.logicalElements,allocatedElements:p.allocatedElements,
   copies:p.copies,assignmentIndices:recorded.assignmentIndices,overriddenIndices:recorded.overriddenIndices,coverage:recorded.partition.coverage};
  if(declaration?.object.kind==='tensor')axes('原张量维度',declaration.object.tensor.shape,recorded.partition.globalShape,declaration.symbols);
 }else if(recipe.kind==='storage'&&selector.kind==='storage'){
  const recorded=attempt.result.storageAllocations.find(row=>row.storageId===selector.storageId);
  if(!recorded||canonical(recorded)!==canonical(recipe.row))throw Error('规范存储或实际分布不同');
  const elided=recorded.allocation.materialization==='elided';
  const replay=allocateDistributedStorage(selector.storageId,[recipe.storage],effectiveDistribution,recipe.topology,context,{
   partition,allocation:event=>{if(elided)return;if(allocationEvents.length<256)allocationEvents.push(event);else allocationTruncated=true;},
   copies:event=>{if(!elided)copies={kind:'copies',...event};},
  });
  const p=recorded.allocation.perDevice.find(row=>row.deviceId===deviceId),actual=replay.status==='available'?replay.result.perDevice.find(row=>row.deviceId===deviceId):undefined;
  if(!p||!actual||replay.status!=='available')throw Error('存储分布未使用所选设备或未能复算');
  if(elided){
   if(!recipe.elidedBy||p.copies!==actual.copies||canonical(p.allocatedShape)!==canonical(actual.allocatedShape)||
    [p.totalBytes,p.allocation.payloadBytes,p.allocation.totalBytes].some(m=>m.status!=='available'||m.quantity.value!==0)||p.allocation.auxiliaryBytes.length)throw Error('原融合分配未正确取消物化');
  }else if(canonical(namespaceDiagnostics(replay.result,recipe.namespace))!==canonical(recorded.allocation))throw Error('逐卡分配与原分布不同');
  storageEvidence={canonicalStorageId:recorded.storageId,aliases:recorded.aliasIds,assignmentIndices:recorded.assignmentIndices,copies:p.copies,allocatedShape:p.allocatedShape,
   materialization:elided?'elided':'materialized',...(recipe.elidedBy?{elidedBy:recipe.elidedBy}:{}),...(recipe.override?{override:recipe.override}:{}),
   ...(p.totalBytes.status==='available'?{totalBytes:p.totalBytes.quantity.value}:{}),
   ...(p.allocation.totalBytes.status==='available'?{perCopyBytes:p.allocation.totalBytes.quantity.value}:{})};
  const ids=new Set([...p.totalBytes.diagnosticIds,...p.allocation.totalBytes.diagnosticIds]);
  diagnostics=attempt.result.diagnostics.filter(d=>ids.has(d.diagnosticId));
  const original=declaration?.object.kind==='storage'?declaration.object.storage.allocation:undefined,effective=recipe.storage.allocation,inputAllocation=recipe.override?.before??effective;
  if(declaration&&original?.kind==='bytes'&&inputAllocation.kind==='bytes')formulas.push({field:'声明字节数',expression:original.value,expected:inputAllocation.value,symbols:declaration.symbols});
  if(declaration&&original?.kind==='tensor'&&inputAllocation.kind==='tensor')axes('原存储维度',original.shape,inputAllocation.shape,declaration.symbols);
  const winning=decisions.find(d=>d.winners.length),ruleIndex=winning?.winners[0]?.ruleIndex;
  const bound=quantizationEvents.find(event=>event.kind==='specification_bound'&&event.nodeId===winning?.nodeId&&event.ruleIndex===ruleIndex);
  const specification=inputAllocation.kind==='tensor'?inputAllocation.quantization:undefined;
  if(specification){
   if(recipe.quantization&&(!bound||bound.kind!=='specification_bound')){
    if(!quantizationTruncated)throw Error('缺少实际量化规则的求值证据');
   }else if(recipe.quantization&&bound?.kind==='specification_bound'&&canonical(bound.specification)!==canonical(specification))throw Error('生效量化规则与实际分配规格不同');
   storageEvidence.quantization={payloadBits:specification.payloadBits,packingUnitElements:specification.packingUnitElements,alignmentBytes:specification.alignmentBytes,
    stage:elided?'elided':recipe.override?'overridden':'effective',...(winning&&ruleIndex!==undefined?{ruleIndex,nodeId:winning.nodeId}:{})};
   if(!elided&&!recipe.override){
    const raw=recipe.quantization?(bound?.kind==='specification_bound'?bound.raw:undefined):original?.kind==='tensor'?original.quantization:undefined;
    const lexical=recipe.quantization?Object.fromEntries(quantizationEvents.flatMap(event=>event.kind==='scope_assignment'&&event.nodeId===winning?.nodeId&&event.ruleIndex===ruleIndex?[[event.assignment.name,event.assignment.quantity] as const]:[])):declaration?.symbols??{};
    for(const auxiliary of raw?.auxiliaries??[]){
     const active=specification.auxiliaries.find(entry=>entry.name===auxiliary.name);
     if(auxiliary.count.kind==='formula'&&active?.count.kind==='formula')formulas.push({field:'量化辅助项 '+auxiliary.name+' 个数',expression:auxiliary.count.value,expected:active.count.value,symbols:lexical});
    }
   }
  }
 }

 const distribution=deviceDistribution(effectiveDistribution,deviceId);
 const allocatedShape=storageEvidence?.allocatedShape??tensorEvidence?.allocatedShape;
 if(distribution.kind==='manual'&&distribution.member&&allocatedShape)axes('设备手工分配维度',distribution.member.localShape,allocatedShape,recipe.symbols);
 const ruleItems=recipe.rules.map(rule=>({kind:'rule' as const,rule:{...rule,declared:deviceDistribution(rule.declared,deviceId),effective:deviceDistribution(rule.effective,deviceId)}}));
 const candidates=[...ruleItems,...origins.map(origin=>({kind:'origin' as const,origin:{...origin,distribution:deviceDistribution(origin.distribution,deviceId)}}))];
 const numeric:LayoutItem[]=[
  ...partitionEvents.map(operation=>({kind:'partition' as const,operation})),
  ...allocationEvents.map(operation=>({kind:'allocation' as const,operation})),...(copies?[copies]:[]),
 ];
 const quantizationItems=decisions.map(({nodeId,winners,losers})=>({kind:'quantization' as const,nodeId,winners,losers}));
 const start=page*pageSize,componentCount=numeric.length+formulas.length+candidates.length+quantizationItems.length;
 if(page>0&&start>=componentCount)throw Error('设备布局来源页不存在');
 const items:LayoutItem[]=[];
 let index=0;
 for(const item of numeric)if(index++>=start&&items.length<pageSize)items.push(item);
 for(const entry of formulas)if(index++>=start&&items.length<pageSize){
  const formula=explainValue(entry.expression,entry.symbols,library);
  sameQuantity(formula.quantity,evaluateValue(entry.expected,recipe.symbols,library));
  items.push({kind:'formula',field:entry.field,formula});
 }
 for(const item of [...candidates,...quantizationItems])if(index++>=start&&items.length<pageSize)items.push(item);
 const group=recipe.topology.groups.find(g=>g.groupId===effectiveDistribution.groupId);
 if(!group)throw Error('实际分布组缺失');
 const evidence={distribution,deviceId,group:{groupId:group.groupId,memberCount:group.members.length,
  ...(group.mesh?{axes:group.mesh.axes,coordinates:group.mesh.coordinates.find(c=>c.deviceId===deviceId)?.coordinates??[]}:{} )},
  syntheticBaseline:recipe.syntheticBaseline,origin:declaration?{asset:declaration.asset,nodeId:declaration.nodeId}:null,
  ...(scenario.parallelPlan.generatedFrom?{preset:scenario.parallelPlan.generatedFrom}:{}),
  ...(storageEvidence?{storage:storageEvidence}:{}),...(tensorEvidence?{tensor:tensorEvidence}:{}),
  allocationTruncated,quantizationTruncated,items,diagnostics};
 jsonBytes(evidence,8*1024*1024);
 return {kind:'layout_source' as const,schemaVersion:1 as const,inputHash,engineVersion,selector,page,pageSize,componentCount,...evidence,request};
}

export type LayoutSourceReport=Awaited<ReturnType<typeof replayLayoutSource>>;
export async function verifyLayoutSourceReport(input:unknown){
 const saved=z.object({kind:z.literal('layout_source'),schemaVersion:z.literal(1),request:LayoutSourceRequest}).passthrough().parse(input);
 const report=await replayLayoutSource(saved.request);
 if(stableStringify(saved)!==stableStringify(report))throw Error('布局来源报告与固定输入复算不同');
 return report;
}
