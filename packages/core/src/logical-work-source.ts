import {z} from 'zod';
import {ComputeClass,MetricScope,NodeId,type AssetRef,type CostDefinition,type MetricValue,type Quantity} from '@model-analyser/contracts';
import {canonical} from '../../contracts/src/validation.js';
import {jsonBytes} from '../../contracts/src/json-size.js';
import {LeafCostSourceRequest} from './leaf-cost-context.js';
import {analyzeScenario,ENGINE_VERSION} from './analyze.js';
import {computeInputHash,stableStringify} from './input-hash.js';
import {logicalFusionExtraRows,logicalWorkMembers,logicalWorkRows,type LogicalWorkRow} from './logical-work-members.js';
import {containedFusions} from './aggregate-members.js';
import {namespaceDiagnostics} from './decode.js';
import {explainValue} from './formula.js';
import {logicalParameterBindingGraph,parameterBindingGraph,parameterReads,type AdditionalParameterRoot,type ParameterBindingGraph} from './parameter-binding-graph.js';
import type {ParameterCaptureTrace} from './parameter-observation.js';
import type {LocalCostDeclaration} from './local-cost-observation.js';
import type {FusionDeclaration} from './fusion-observation.js';
import type {AnalysisObserver,LogicalExtraOperand,LogicalTerm} from './logical-work-observation.js';

export const LogicalWorkSelector=z.strictObject({
 scope:MetricScope,computeClass:ComputeClass,field:z.enum(['usefulOperations','executedOperations']),fusionNodeId:NodeId.optional(),
});
export type LogicalWorkSelector=z.infer<typeof LogicalWorkSelector>;
export const LogicalWorkSourceRequest=LeafCostSourceRequest.extend({selector:LogicalWorkSelector,decodeFrame:z.literal(true).optional(),proofVersion:z.literal(2).optional()});
export type LogicalWorkSourceRequest=z.input<typeof LogicalWorkSourceRequest>;
const pageSize=20;

type StepIdentity={index:number;inputHash:string;evaluatedContext:number};
export type LogicalWorkSourceMember={kind:'leaf'|'extra'|'step';scope:MetricScope;fusionNodeId?:NodeId;step?:StepIdentity};
type Segment={kind:'segment';segmentId:string;index:number;expression:CostDefinition['compute'][number]['usefulOperations']};
type LogicalInput=(LogicalWorkSourceMember|Segment)&{metric:MetricValue};
type FoldOperand={quantity?:Quantity;diagnosticIds:string[];addition?:{before:number;after:number}};
type EvidenceItem=(LogicalWorkSourceMember|Omit<Segment,'expression'>&{formula?:ReturnType<typeof explainValue>})&FoldOperand;

export async function replayLogicalWorkSource(input:unknown){
 const request=LogicalWorkSourceRequest.parse(input),{scenario,assets,inputHash,engineVersion,selector,stepContext,page,proofVersion}=request;
 const {scope,computeClass,field,fusionNodeId}=selector,target=scope.target;
 if(scope.aggregation!=='model_useful'||fusionNodeId!==undefined&&target.kind!=='node')throw Error('请选择模型逻辑工作范围或实际融合附加项');
 if(request.decodeFrame&&!stepContext)throw Error('逻辑来源缺少实际 Decode 步骤上下文');
 const prefix=request.decodeFrame&&stepContext?`decode-step-${stepContext.index}::`:undefined;
 if(engineVersion!==ENGINE_VERSION||await computeInputHash(scenario,assets,stepContext)!==inputHash)throw Error('逻辑工作来源的固定输入、步骤或引擎版本不匹配');
 const leaves:LocalCostDeclaration[]=[],terms:LogicalTerm[]=[],fusionDeclarations:FusionDeclaration[]=[],extraOperands:LogicalExtraOperand[]=[];
 let bindingTrace:ParameterCaptureTrace|undefined;
 const sequence=scenario.workload.kind==='decode'&&scenario.workload.steps!==1;
 if(sequence&&fusionNodeId!==undefined)throw Error('融合附加项需要选择一个实际 Decode 步骤');
 const observer:AnalysisObserver|undefined=fusionNodeId!==undefined?{fusion:{
  nodeId:fusionNodeId,declaration:record=>fusionDeclarations.push(record),logicalExtra:term=>extraOperands.push(term),
  ...(proofVersion===2?{bindings:(trace:ParameterCaptureTrace)=>{bindingTrace=trace;}}:{}),
 }}:target.kind==='node'&&!sequence?{logicalLeaf:{
  nodeId:target.nodeId,declaration:record=>leaves.push(record),term:record=>terms.push(record),
 }}:undefined;
 const attempt=await analyzeScenario(scenario,assets,stepContext,observer);
 if(attempt.status!=='available'||attempt.result.inputHash!==inputHash||attempt.result.engineVersion!==engineVersion)throw Error('原逻辑工作不能复算或固定结果身份不匹配');
 const result=attempt.result,targetKey=canonical(target),classKey=canonical(computeClass);
 const select=(compute:LogicalWorkRow['compute'])=>compute.find(row=>canonical(row.computeClass)===classKey)?.[field];
 const logicalRows=result.decode?.logicalCompute??logicalWorkRows(result);
 const extras=logicalFusionExtraRows(result);
 const selected=fusionNodeId===undefined?logicalRows.find(row=>canonical(row.scope.target)===targetKey):extras.find(extra=>extra.fusionNodeId===fusionNodeId&&canonical(extra.row.scope.target)===targetKey)?.row;
 const metric=selected?select(selected.compute):undefined;
 if(!selected||canonical(selected.scope)!==canonical(scope))throw Error('原节点或完整模型逻辑范围不匹配');
 if(!metric||stableStringify(prefix?namespaceDiagnostics(metric,prefix):metric)!==stableStringify(request.metric))throw Error('原逻辑指标、单位或诊断不同');
 const inputs:LogicalInput[]=[];
 let operation:'step_sum'|'member_sum'|'segment_sum',memberCount=0,assetsUsed:AssetRef|undefined,symbols:LocalCostDeclaration['symbols']={};
 let parameterBindings:ParameterBindingGraph|undefined,callFrame:string|undefined,fusionFrames:Record<string,string>|undefined;
 function addMember(identity:LogicalWorkSourceMember,compute:LogicalWorkRow['compute']){
  memberCount++;
  const value=select(compute);
  if(value)inputs.push({...identity,metric:value});
 }
 function addSegment(index:number,segment:CostDefinition['compute'][number],raw:MetricValue){
  memberCount++;
  inputs.push({kind:'segment',index,segmentId:segment.segmentId,expression:segment[field],metric:raw});
 }

 if(result.decode){
  operation='step_sum';
  for(const step of result.decode.steps){
   const row=logicalWorkRows(step.result).find(item=>canonical(item.scope.target)===targetKey);
   if(row)addMember({kind:'step',scope:row.scope,step:{index:step.index,inputHash:step.result.inputHash,evaluatedContext:step.evaluatedContext}},row.compute);
  }
 }else if(fusionNodeId!==undefined){
  operation='segment_sum';
  const fusion=result.fusions?.find(f=>f.evaluation.application.nodeId===fusionNodeId);
  const authored=scenario.fusionGroups.find(g=>g.groupId===fusion?.evaluation.application.groupId),declaration=fusionDeclarations[0];
  if(!authored||!declaration||fusionDeclarations.length!==1)throw Error('原融合附加项的数学方程缺失');
  assetsUsed=authored.origin?.asset??scenario.model;
  symbols=declaration.symbols;
  fusionFrames=declaration.parameterFrames?.root;
  const captured=new Map(extraOperands.filter(term=>term.field===field&&canonical(term.computeClass)===classKey).map(term=>[term.segmentId,term.metric]));
  for(const [index,segment] of authored.extraCost.compute.entries()){
   if(canonical(segment.computeClass)!==classKey)continue;
   const raw=captured.get(segment.segmentId);
   if(!raw)throw Error('缺少实际附加计算段的值');
   addSegment(index,segment,raw);
  }
 }else{
  const fusions=result.fusions??[],fusion=target.kind==='node'?fusions.find(row=>row.evaluation.application.nodeId===target.nodeId):undefined;
  if(target.kind==='node'&&!fusion){
   operation='segment_sum';
   const declaration=leaves[0];
   if(!declaration||leaves.some(row=>stableStringify(row)!==stableStringify(declaration)))throw Error('实际叶调用声明缺失或不一致');
   assetsUsed=declaration.asset;symbols=declaration.symbols;
   if(proofVersion===2){
    callFrame=declaration.bindingContext?.frameId;
    bindingTrace=declaration.bindingContext?.trace;
   }else if(declaration.bindingContext)parameterBindings=parameterBindingGraph({...declaration,nodeId:target.nodeId,storageRefs:[],storages:[]},assets);
   for(const term of terms){
    if(canonical(term.computeClass)!==classKey)continue;
    const segment=declaration.cost.compute[term.index];
    if(!segment||segment.segmentId!==term.segmentId||canonical(segment.computeClass)!==classKey)throw Error('原计算段的 ID、分类或顺序不匹配');
    addSegment(term.index,segment,term[field]);
   }
  }else{
   operation='member_sum';
   const fusedIds=new Set(fusions.map(row=>row.evaluation.application.nodeId));
   const leafScopes=new Map(logicalRows.flatMap(row=>row.scope.target.kind==='node'&&!fusedIds.has(row.scope.target.nodeId)?[[row.scope.target.nodeId,row] as const]:[]));
   const module=target.kind==='module'?result.modules.find(row=>row.nodeId===target.nodeId):undefined;
   if(target.kind==='module'&&!module)throw Error('原逻辑模块的叶成员缺失');
   const members=logicalWorkMembers(
    new Map([...leafScopes].map(([id,row])=>[id,row.compute])),
    (fusion?[fusion]:module?containedFusions(module.leafNodeIds,fusions):fusions).map(row=>row.evaluation),
    fusion?.evaluation.application.memberNodeIds??module?.leafNodeIds,
   );
   const extraScopes=new Map(extras.flatMap(extra=>extra.row.scope.target.kind==='node'?[[extra.row.scope.target.nodeId,extra.row.scope] as const]:[]));
   for(const member of members){
    const effective=member.kind==='extra'?extraScopes.get(member.nodeId):leafScopes.get(member.nodeId)?.scope;
    if(!effective)throw Error('原逻辑成员的实际范围缺失');
    addMember({kind:member.kind,scope:effective,...(member.kind==='extra'?{fusionNodeId:member.fusionNodeId}:{})},member.compute);
   }
  }
 }

 const start=page*pageSize,componentCount=inputs.length,items:EvidenceItem[]=[];
 if(page>0&&start>=componentCount)throw Error('请求的逻辑工作来源页不存在');
 const reads:AdditionalParameterRoot[]=[];
 let value=0,completeSum=true,truncatedReads=false;
 for(const [index,term] of inputs.entries()){
  const {metric:operand,...identity}=term;
  let addition:FoldOperand['addition'],quantity:Quantity|undefined;
  if(operand.status==='available'){
   quantity=operand.quantity;
   if(quantity.unit!=='operation')throw Error('工作量操作数的单位不同');
   if(completeSum){
    const next=value+quantity.value;
    if(Number.isFinite(next)){addition={before:value,after:next};value=next;}
    else completeSum=false;
   }
  }else completeSum=false;
  if(index<start||index>=start+pageSize)continue;
  const data:FoldOperand={diagnosticIds:operand.diagnosticIds,...(addition?{addition}:{}),...(quantity?{quantity}:{})};
  if(identity.kind==='segment'){
   const {expression,...segment}=identity,formula=quantity?explainValue(expression,symbols,assets):undefined;
   if(formula&&canonical(formula.quantity)!==canonical(quantity))throw Error('原公式计算值不同于实际操作数');
   if(proofVersion===2&&formula){
    const target=`计算段 ${segment.index+1} · ${segment.segmentId}`;
    const segmentReads=parameterReads(formula.proof,(name,quantity)=>({name,quantity,target,
     frameId:callFrame??(fusionFrames&&Object.hasOwn(fusionFrames,name)?fusionFrames[name]:undefined)??'unrecorded-logical-frame'}));
    const remaining=256-reads.length;
    truncatedReads||=formula.truncated||segmentReads.length>remaining;
    reads.push(...segmentReads.slice(0,remaining));
   }
   items.push({...segment,...data,...(formula?{formula}:{})});
  }else items.push({...identity,...data});
 }
 if(metric.status==='available'&&(!completeSum||metric.quantity.unit!=='operation'||metric.quantity.value!==value))throw Error('按原顺序累加的逻辑工作量与原指标不同');
 if(proofVersion===2&&operation==='segment_sum'){
  parameterBindings=logicalParameterBindingGraph(bindingTrace&&{...bindingTrace,truncated:bindingTrace.truncated||truncatedReads},assets,reads);
 }
 const diagnosticIds=new Set([...metric.diagnosticIds,...items.flatMap(item=>item.diagnosticIds)]);
 const diagnostics=result.diagnostics.filter(d=>diagnosticIds.has(d.diagnosticId));
 const evidence={items,metric,diagnostics,memberCount,componentCount,operation,
  ...(assetsUsed?{asset:assetsUsed}:{}),...(proofVersion===undefined&&parameterBindings?{parameterBindings}:{})};
 jsonBytes(evidence,8*1024*1024);
 return {kind:'logical_work_source' as const,schemaVersion:proofVersion??(1 as const),selector,inputHash,engineVersion,page,pageSize,
  ...(prefix?namespaceDiagnostics(evidence,prefix):evidence),...(proofVersion===2&&parameterBindings?{parameterBindings}:{}),request};
}

export type LogicalWorkSourceReport=Awaited<ReturnType<typeof replayLogicalWorkSource>>;
export async function verifyLogicalWorkSourceReport(input:unknown){
 const saved=z.object({kind:z.literal('logical_work_source'),schemaVersion:z.union([z.literal(1),z.literal(2)]),request:LogicalWorkSourceRequest}).passthrough().parse(input);
 const report=await replayLogicalWorkSource(saved.request);
 if(stableStringify(saved)!==stableStringify(report))throw Error('逻辑工作来源与固定输入复算不同');
 return report;
}
