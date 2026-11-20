import {expect,it} from 'vitest';
import {AssetDocument,NodeId,type MetricScope,type ProjectDocument} from '@model-analyser/contracts';
import {analyzeScenario,logicalFusionExtraRows,logicalWorkRows,replayLogicalWorkSource,verifyLogicalWorkSourceReport,type LogicalWorkSelector} from '@model-analyser/core';
import {canonical} from '../packages/contracts/src/validation.js';
import {readLogicalWorkSourceReply} from '../apps/web/src/logical-work-source-task.js';
import {makeLocalGemmProject} from '../scripts/local-gemm-project.js';
import {makeDecodeProject} from '../scripts/decode-project.js';
import {makeFusedProject} from '../scripts/fused-project.js';
import {c01Project} from './model-fixtures.js';
import {scopedLogicalFusionProject} from './logical-work-fixture.js';

const model={kind:'model' as const};
const leaf=(id:string)=>({kind:'node' as const,nodeId:NodeId.parse(id)});
const moduleScope=(id:string)=>({kind:'module' as const,nodeId:NodeId.parse(id)});
const lit=(value:number)=>({kind:'literal' as const,quantity:{value,unit:'operation' as const}});
function replicatedGemm(){
 const project=makeLocalGemmProject(c01Project()),scenario=project.scenarios[0]!;
 for(const assignment of scenario.parallelPlan.assignments)for(const tensor of assignment.tensorDistributions)tensor.distribution={kind:'replicated',groupId:'tp'};
 return project;
}
function operator(project:ProjectDocument){
 const asset=project.assetSnapshots.find(a=>a.definition.kind==='operator');
 if(asset?.definition.kind!=='operator')throw Error('Missing fixture operator');
 return asset.definition.operator;
}
async function request(project:ProjectDocument,target:MetricScope['target'],options:{step?:number;field?:LogicalWorkSelector['field'];fusionNodeId?:LogicalWorkSelector['fusionNodeId'];classIndex?:number}={}){
 const {step,field='usefulOperations',fusionNodeId,classIndex=0}=options;
 const scenario=project.scenarios[0]!,assets=project.assetSnapshots,attempt=await analyzeScenario(scenario,assets);
 if(attempt.status!=='available')throw Error(JSON.stringify(attempt.diagnostics));
 const actual=step===undefined?undefined:attempt.result.decode?.steps[step];
 if(step!==undefined&&!actual)throw Error('Missing fixture Decode step');
 const frame=actual?.result??attempt.result;
 const rows=fusionNodeId!==undefined?logicalFusionExtraRows(frame).filter(extra=>extra.fusionNodeId===fusionNodeId).map(extra=>extra.row):
  (actual?undefined:attempt.result.decode?.logicalCompute)??logicalWorkRows(frame);
 const source=rows.find(row=>canonical(row.scope.target)===canonical(target)),item=source?.compute[classIndex];
 if(!source||!item)throw Error('Missing fixture logical row');
 const fixed={scenario:actual?.scenario??scenario,assets,inputHash:frame.inputHash,engineVersion:frame.engineVersion,metric:item[field],
  selector:{scope:source.scope,field,computeClass:item.computeClass,...(fusionNodeId?{fusionNodeId}:{})},
  ...(frame.stepContext?{stepContext:frame.stepContext,...(actual?{decodeFrame:true as const}:{})}:{})};
 return {fixed,frame};
}

it('explains one logical model under replication and preserves module and original leaf operands',async()=>{
 const p=replicatedGemm(),{fixed,frame}=await request(p,model);
 expect(frame.total.compute[0]?.usefulOperations).toMatchObject({quantity:{value:2048}});
 const report=await replayLogicalWorkSource(fixed);
 expect(report).toMatchObject({operation:'member_sum',metric:{quantity:{value:1024,unit:'operation'}},items:[{kind:'leaf',scope:{target:{nodeId:'module/op'}},addition:{before:0,after:1024}}]});
 const module=await replayLogicalWorkSource((await request(p,moduleScope('module'))).fixed);
 expect(module.items).toEqual(report.items);
 const call=await replayLogicalWorkSource((await request(p,leaf('module/op'))).fixed);
 expect(call.schemaVersion).toBe(1);
 expect(call).toMatchObject({operation:'segment_sum',asset:{assetId:'example:operator:gemm-local'},items:[{segmentId:'matmul',formula:{proof:{definition:{expression:'2 * M * N * K'},bindings:[{name:'M',quantity:{value:4}},{name:'N',quantity:{value:8}},{name:'K',quantity:{value:16}}]}}}]});
 expect(call.parameterBindings?.nodes.some(n=>n.name==='N'&&n.value.value===8)).toBe(true);
 expect(await verifyLogicalWorkSourceReport(JSON.parse(JSON.stringify(call)))).toEqual(call);
});

it('isolates complete compute classes and includes both relevant primitive segments in order',async()=>{
 const p=replicatedGemm(),op=operator(p),original=op.cost.compute[0]!;
 op.cost.compute.push({...original,segmentId:'fp32-separate',computeClass:{...original.computeClass,multiplyDtype:{category:'float',bits:32,format:'fp32'}},usefulOperations:lit(2),executedOperations:lit(3)});
 op.cost.compute.push({...original,segmentId:'same-class',usefulOperations:lit(7),executedOperations:lit(9)});
 const field='executedOperations',first=await replayLogicalWorkSource((await request(p,leaf('module/op'),{field})).fixed);
 expect(first).toMatchObject({metric:{quantity:{value:1033}},items:[{segmentId:'matmul',index:0,addition:{after:1024}},{segmentId:'same-class',index:2,addition:{before:1024,after:1033}}]});
 const alternate=await replayLogicalWorkSource((await request(p,leaf('module/op'),{field,classIndex:1})).fixed);
 expect(alternate).toMatchObject({metric:{quantity:{value:3}},items:[{segmentId:'fp32-separate',index:1,addition:{after:3}}]});
});

it('sums mathematical members plus one declared fusion extra, then opens its actual formula',async()=>{
 const p=makeFusedProject(c01Project()),scenario=p.scenarios[0]!,group=scenario.fusionGroups[0]!;
 const work=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'test:logical:fusion-extra',revision:1,name:'Extra work',parameters:[],tags:[],sources:[],
  definition:{kind:'formula',formula:{inputs:{n:{unit:'count',integerRequired:true}},expression:'2 * n',output:{unit:'operation',integerRequired:true,nonNegative:true},description:'Explicit extra arithmetic'}}});
 p.assetSnapshots.push(work);
 group.extraCost.compute[0]!.executedOperations={kind:'formula',call:{formula:{assetId:work.assetId,revision:1,kind:'formula'},bindings:{n:{kind:'symbol',name:'N'}}}};
 const fusionNodeId=NodeId.parse('$fusion:pair'),field='executedOperations';
 const aggregate=await replayLogicalWorkSource((await request(p,model,{field})).fixed);
 expect(aggregate.metric).toMatchObject({quantity:{value:7}});
 expect(aggregate.items).toMatchObject([{kind:'leaf',scope:{target:{nodeId:'A'}}},{kind:'leaf',scope:{target:{nodeId:'B'}}},{kind:'extra',fusionNodeId,addition:{before:5,after:7}}]);
 const fused=await replayLogicalWorkSource((await request(p,leaf(fusionNodeId),{field})).fixed);
 expect(fused.items).toEqual(aggregate.items);
 const extra=await replayLogicalWorkSource((await request(p,leaf('$fusion:pair/extra'),{field,fusionNodeId})).fixed);
 expect(extra.items).toMatchObject([{kind:'segment',segmentId:'extra',formula:{proof:{bindings:[{quantity:{value:1},proof:{symbol:'N'}}]}}}]);
});

it('retains actual contexts and independent contributors for growing and fixed-context Decode',async()=>{
 const p=makeDecodeProject(c01Project()),scenario=p.scenarios[0]!;
 const sequence=await replayLogicalWorkSource((await request(p,model)).fixed);
 expect(sequence).toMatchObject({operation:'step_sum',metric:{quantity:{value:12}},items:[
  {step:{index:0,evaluatedContext:2},quantity:{value:3}},
  {step:{index:1,evaluatedContext:3},quantity:{value:4}},
  {step:{index:2,evaluatedContext:4},quantity:{value:5},addition:{before:7,after:12}},
 ]});
 const {fixed}=await request(p,leaf('update'),{step:2});
 const actual=await replayLogicalWorkSource(fixed);
 expect(actual.items).toMatchObject([{kind:'segment',formula:{proof:{bindings:[{name:'B',quantity:{value:1}},{name:'C',quantity:{value:4}},{name:'Q',quantity:{value:1}}]}}}]);
 const third=sequence.items.find(item=>item.kind==='step'&&item.step?.index===2);
 expect(actual.inputHash).toBe(third?.kind==='step'?third.step?.inputHash:undefined);
 if(scenario.workload.kind!=='decode')throw Error('Missing workload');
 scenario.workload.approximation='fixed_context';
 const fixedContext=await replayLogicalWorkSource((await request(p,model)).fixed);
 expect(fixedContext.metric).toMatchObject({quantity:{value:9}});
 expect(fixedContext.items.map(item=>item.quantity?.value)).toEqual([3,3,3]);
 await expect(replayLogicalWorkSource({...fixed,stepContext:{...fixed.stepContext,index:0}})).rejects.toThrow('版本不匹配');
});

it('binds fusion extra work to the actual preset and Decode context',async()=>{
 const p=scopedLogicalFusionProject(),fusionNodeId=NodeId.parse('$fusion:scope-proof'),target=leaf('$fusion:scope-proof/extra');
 const {fixed}=await request(p,target,{step:2,fusionNodeId});
 const original=await replayLogicalWorkSource(fixed);
 expect(original.parameterBindings).toBeUndefined();
 const report=await replayLogicalWorkSource({...fixed,proofVersion:2});
 expect(report).toMatchObject({schemaVersion:2,metric:{quantity:{value:12,unit:'operation'}},parameterBindings:{scope:'actual_logical_parameter_context',complete:true}});
 expect(report.items).toEqual(original.items);
 expect(report.parameterBindings?.roots).toMatchObject(['B','C'].map(name=>({role:'logical',name,frameId:'["asset","A"]',target:'计算段 1 · scoped-extra'})));
 expect(report.parameterBindings?.nodes).toEqual(expect.arrayContaining([
  expect.objectContaining({name:'B',frameId:'["asset","A"]',value:{kind:'integer',value:3},source:expect.objectContaining({kind:'node_override'})}),
  expect.objectContaining({name:'contextTokensPerRequest',value:{kind:'number',value:4}}),
 ]));
 const earlier=await request(p,target,{step:0,fusionNodeId});
 const first=await replayLogicalWorkSource({...earlier.fixed,proofVersion:2});
 expect(first.metric).toMatchObject({quantity:{value:6}});
 expect(first.parameterBindings?.nodes.find(node=>node.kind==='workload'&&node.name==='contextTokensPerRequest')?.value.value).toBe(2);
 expect(await verifyLogicalWorkSourceReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
 const forged=structuredClone(report);
 const root=forged.parameterBindings?.roots[0];
 if(!root)throw Error('Missing fusion root');
 root.frameId='["asset","$model"]';
 await expect(verifyLogicalWorkSourceReport(forged)).rejects.toThrow('固定输入复算不同');
});

it('keeps the running total across pages and rejects altered replies, evidence and scopes',async()=>{
 const p=replicatedGemm(),op=operator(p),segment=op.cost.compute[0]!;
 for(let i=0;i<24;i++)op.cost.compute.push({...segment,segmentId:'other'+i,usefulOperations:lit(1),executedOperations:lit(1)});
 const {fixed}=await request(p,leaf('module/op')),report=await replayLogicalWorkSource({...fixed,page:1});
 expect(report).toMatchObject({page:1,componentCount:25,metric:{quantity:{value:1048}}});
 expect(report.items[0]).toMatchObject({index:20,addition:{before:1043,after:1044}});
 expect(report.items).toHaveLength(5);
 const first=await replayLogicalWorkSource({...fixed,proofVersion:2});
 expect(first.parameterBindings?.roots.map(root=>root.name).sort()).toEqual(['K','M','N']);
 expect(first.parameterBindings?.roots.every(root=>root.target==='计算段 1 · matmul')).toBe(true);
 const second=await replayLogicalWorkSource({...fixed,page:1,proofVersion:2});
 expect(second.parameterBindings).toMatchObject({complete:true,roots:[]});
 expect(second.items).toEqual(report.items);
 const scopedTask={taskId:'logical',phase:'logical_work_source',request:{...fixed,page:1,proofVersion:2 as const}};
 const scopedReply={taskId:'logical',phase:'logical_work_source',status:'available',report:second};
 expect(readLogicalWorkSourceReply(scopedReply,scopedTask)).toEqual(scopedReply);
 expect(()=>readLogicalWorkSourceReply({...scopedReply,report:{...second,parameterBindings:undefined}},scopedTask)).toThrow('实际公式');
 const task={taskId:'logical',phase:'logical_work_source',request:{...fixed,page:1}},reply={taskId:task.taskId,phase:task.phase,status:'available',report};
 expect(readLogicalWorkSourceReply(reply,task)).toBe(reply);
 expect(()=>readLogicalWorkSourceReply({...reply,report:{...report,items:[]}},task)).toThrow('分页');
 expect(()=>readLogicalWorkSourceReply({...reply,phase:'aggregate_cost_source'},task)).toThrow('任务身份');
 const altered=structuredClone(report);altered.items.reverse();
 await expect(verifyLogicalWorkSourceReport(altered)).rejects.toThrow('固定输入复算不同');
 await expect(replayLogicalWorkSource({...fixed,page:2})).rejects.toThrow('页不存在');
 await expect(replayLogicalWorkSource({...fixed,selector:{...fixed.selector,scope:{...fixed.selector.scope,aggregation:'group_total'}}})).rejects.toThrow('模型逻辑工作范围');
});

it('retains missing aggregate work and namespaced diagnostics when the selected Decode sum overflows',async()=>{
 const p=makeDecodeProject(c01Project()),model=p.assetSnapshots.find(a=>a.definition.kind==='model');
 if(model?.definition.kind!=='model')throw Error('Missing model');
 const node=model.definition.graph.nodes[0];
 if(node?.body.kind!=='opaque'||!node.body.cost.compute[0])throw Error('Missing compute segment');
 const large={...node.body.cost.compute[0],usefulOperations:lit(1e308),executedOperations:lit(1e308)};
 node.body.cost.compute=[large,{...large,segmentId:'overflow-term'}];
 node.body.cost.timing={kind:'fixed',seconds:.1,description:'Explicit fixture duration'};
 const {fixed}=await request(p,leaf('update'),{step:2,field:'executedOperations'});
 const report=await replayLogicalWorkSource(fixed);
 expect(report).toMatchObject({metric:{status:'unavailable'},items:[{segmentId:'work',quantity:{value:1e308},addition:{before:0,after:1e308}},{segmentId:'overflow-term',quantity:{value:1e308}}]});
 expect(report.diagnostics.find(d=>d.code==='numeric_overflow')?.diagnosticId).toMatch(/^decode-step-2::/);
 expect(report.items[1]).not.toHaveProperty('addition');
 expect(await verifyLogicalWorkSourceReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
});
