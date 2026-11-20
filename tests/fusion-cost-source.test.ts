import {expect,it} from 'vitest';
import {AssetDocument,DeviceId,LocalCostRule,NodeId,StorageId,type AnalysisResult,type DeviceId as Rank,type ProjectDocument} from '@model-analyser/contracts';
import {analyzeScenario,replayFusionCostSource,replayLocalCostSource,verifyFusionCostSourceReport,type FusionCostSelector} from '@model-analyser/core';
import {makeFusedProject} from '../scripts/fused-project.js';
import {readFusionSourceReply} from '../apps/web/src/fusion-source-task.js';
import {c01Project} from './model-fixtures.js';

const gpu0=DeviceId.parse('gpu0'),gpu1=DeviceId.parse('gpu1');
const roofline={kind:'roofline_bound' as const,computeEfficiency:1,memoryEfficiency:1,computeMemoryOverlap:'ideal' as const,launchSeconds:0};
const fused=()=>makeFusedProject(c01Project());
function replicated(){
 const project=fused(),s=project.scenarios[0]!,base=s.deviceTopology.devices[0]!;
 const model=project.assetSnapshots.find(a=>a.assetId===s.model.assetId);
 if(model?.definition.kind!=='model')throw Error('Missing model');
 const graph=model.definition.graph,distribution={kind:'replicated' as const,groupId:'pair'};
 s.deviceTopology={devices:[base,{...base,deviceId:gpu1}],groups:[{groupId:'pair',members:[gpu0,gpu1]}]};
 s.parallelPlan.assignments=[{selector:{kind:'subtree',rootNodeId:NodeId.parse('$model')},phases:['decode'],tensorDistributions:graph.tensors.map(t=>({tensorId:t.tensorId,distribution})),storageDistributions:graph.storages.map(t=>({storageId:t.storageId,distribution}))}];
 for(const n of graph.nodes){
  if(n.body.kind!=='opaque')throw Error('Missing fixture member');
  n.body.localCost=LocalCostRule.parse({participation:{kind:'tensor_layout',tensorId:n.body.outputs[0]?.tensorId},bindings:[],cost:n.body.cost,description:'Explicit replicated equations'});
 }
 const group=s.fusionGroups[0]!;
 group.extraLocalCost={contextNodeId:NodeId.parse('B'),rule:LocalCostRule.parse({participation:{kind:'tensor_layout',tensorId:'Y'},bindings:[],cost:group.extraCost,description:'Explicit extra costs once per device'})};
 return {project,s,graph,group};
}

async function frame(project:ProjectDocument,step?:number){
 const scenario=project.scenarios[0]!,assets=project.assetSnapshots,attempt=await analyzeScenario(scenario,assets);
 if(attempt.status!=='available')throw Error(JSON.stringify(attempt.diagnostics));
 const actualStep=step===undefined?undefined:attempt.result.decode?.steps[step];
 if(step!==undefined&&!actualStep)throw Error('Missing actual Decode frame');
 const result=actualStep?.result??attempt.result;
 const fixed={scenario:actualStep?.scenario??scenario,assets,engineVersion:result.engineVersion,inputHash:result.inputHash,
  ...(result.stepContext?{stepContext:result.stepContext,...(actualStep?{decodeFrame:true as const}:{})}:{})};
 return {fixed,result};
}
function select(cost:AnalysisResult['total'],field:FusionCostSelector['field']){
 const compute=field==='usefulOperations'||field==='executedOperations';
 const row=cost.compute[0],metric=compute?row?.[field]:cost[field];
 if(!metric)throw Error('Missing fixture metric');
 return {metric,selector:{scope:cost.scope,field,...(compute&&row?{computeClass:row.computeClass}:{})}};
}
async function request(project:ProjectDocument,field:FusionCostSelector['field']='seconds',device?:Rank,step?:number){
 const {fixed,result}=await frame(project,step),fusion=result.fusions?.[0];
 if(!fusion)throw Error('Missing fixture fusion');
 const local=fusion.evaluation.perDevice.find(d=>d.deviceId===device)?.outcome;
 const cost=device?(local?.status==='available'?local.cost:undefined):fusion.cost;
 if(!cost)throw Error('Missing fixture device');
 return {...fixed,...select(cost,field)};
}

it('preserves exact physical summation and actual elision identities, including a shifted retained access',async()=>{
 const p=fused();
 const fixed=await request(p,'hbmBytes'),summary=await replayFusionCostSource(fixed);
 expect(summary).toMatchObject({operation:'sum_devices',metric:{quantity:{value:4}},removedCount:2});
 expect(summary.items).toMatchObject([
  {kind:'device',deviceId:gpu0,step:{before:0,after:4}},
  {kind:'access',resourceRemoved:true,nodeId:'A',accessId:'writeT',canonicalStorageId:'sT'},
  {kind:'access',resourceRemoved:true,nodeId:'B',accessId:'readT',canonicalStorageId:'sT'},
  {kind:'elided_allocation',storageId:'sT',deviceId:gpu0,quantity:{value:0,unit:'byte'}},
 ]);
 expect(await verifyFusionCostSourceReport(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
 const fabricated=structuredClone(summary);fabricated.items.reverse();
 await expect(verifyFusionCostSourceReport(fabricated)).rejects.toThrow('固定输入复算不同');
 const {fixed:localFixed,result}=await frame(p),node=result.distributed?.layout.localCosts.nodes.find(n=>n.nodeId==='B');
 const local=node?.placement.kind==='placed'?node.placement.perDevice[0]?.outcome:undefined;
 if(!node||local?.status!=='available')throw Error('Missing test member');
 const localProof=await replayLocalCostSource({...localFixed,metric:local.cost.hbmBytes,selector:{scope:local.cost.scope,nodeId:node.nodeId,deviceId:gpu0,field:'hbmBytes'}});
 expect(localProof.items).toMatchObject([{kind:'access',index:0,accessId:'writeY',allocation:{canonicalStorageId:'sY'},hbm:{quantity:{value:2}}}]);
});

it('counts distributed members and extra equations once per device and uses the actual extra tensor context',async()=>{
 const {project,group}=replicated(),rule=group.extraLocalCost?.rule;
 if(!rule)throw Error('Missing local extra rule');
 rule.bindings.push({symbol:'scratchRead',source:{kind:'storage_bytes',storageId:StorageId.parse('sY'),basis:'per_copy'}});
 rule.cost.memoryAccess.push({accessId:'extra-read',storageId:StorageId.parse('sY'),mode:'read',logicalBytes:{kind:'symbol',name:'scratchRead'},hbmEstimate:{kind:'factor',value:1}});
 const groupReport=await replayFusionCostSource(await request(project,'executedOperations'));
 expect(groupReport.items.slice(0,2)).toMatchObject([{deviceId:gpu0,step:{before:0,after:6}},{deviceId:gpu1,step:{before:6,after:12}}]);
 const rankReport=await replayFusionCostSource(await request(project,'hbmBytes',gpu1));
 expect(rankReport).toMatchObject({metric:{quantity:{value:6}},operation:'sum_device_terms',extraDevices:[gpu0,gpu1]});
 expect(rankReport.items.slice(0,3)).toMatchObject([{kind:'member',nodeId:'A',step:{after:2}},{kind:'member',nodeId:'B',step:{after:4}},{kind:'extra',nodeId:'$fusion:pair/extra',step:{after:6}}]);
 const {fixed,result}=await frame(project),f=result.fusions?.[0]?.evaluation,extra=f?.extraPerDevice.find(d=>d.deviceId===gpu1)?.outcome;
 if(!f||extra?.status!=='available')throw Error('Missing test extra');
 const proof=await replayLocalCostSource({...fixed,metric:extra.cost.hbmBytes,selector:{nodeId:f.application.extraNodeId,fusionNodeId:f.application.nodeId,deviceId:gpu1,scope:extra.cost.scope,field:'hbmBytes'}});
 expect(proof.items).toMatchObject([{kind:'binding',binding:{symbol:'scratchRead',quantity:{value:2}},storage:{canonicalStorageId:'sY',distribution:{kind:'replicated'}}},{kind:'access',hbm:{quantity:{value:2}},logicalFormula:{proof:{symbol:'scratchRead'}}}]);
});

it('sums independent member barriers with different bottleneck devices',async()=>{
 const {project,s,graph}=replicated();
 const base=project.assetSnapshots.find(a=>a.assetId===s.deviceTopology.devices[0]?.hardware.assetId);
 if(base?.definition.kind!=='hardware')throw Error('Missing hardware');
 for(const [i,device] of s.deviceTopology.devices.entries()){
  const next=AssetDocument.parse({...base,assetId:'test:fusion:hardware-'+i});
  if(next.definition.kind!=='hardware')throw Error('Missing hardware revision');
  for(const c of next.definition.hardware.computeCapabilities)c.operationsPerSecond=i===0?1:100;
  for(const c of next.definition.hardware.memoryCapabilities)c.bytesPerSecond=i===0?100:10;
  project.assetSnapshots.push(next);device.hardware={assetId:next.assetId,revision:next.revision,kind:'hardware'};
 }
 for(const n of graph.nodes){
  if(n.body.kind!=='opaque'||!n.body.localCost)throw Error('Missing local timing');
  n.body.localCost.cost.timing=roofline;
  if(n.nodeId==='B')n.body.localCost.cost.memoryAccess.find(a=>a.mode==='write')!.hbmEstimate={kind:'factor',value:100};
 }
 const report=await replayFusionCostSource(await request(project,'seconds',gpu0));
 expect(report).toMatchObject({operation:'sum_member_barriers',metric:{quantity:{value:22.1}}});
 const bottlenecks=report.items.filter(item=>!('resourceRemoved'in item)&&item.kind==='barrier_rank'&&item.bottleneck);
 expect(bottlenecks).toMatchObject([{nodeId:'A',deviceId:gpu0},{nodeId:'B',deviceId:gpu1},{nodeId:'$fusion:pair/extra',deviceId:gpu0},{nodeId:'$fusion:pair/extra',deviceId:gpu1}]);
 expect(report.items[0]).toMatchObject({kind:'barrier',step:{before:0,after:2}});
});

it('verifies fixed, custom formula and Roofline overrides as whole-group device spans',async()=>{
 const p=makeFusedProject(c01Project(),true),s=p.scenarios[0]!,group=s.fusionGroups[0]!;
 const initial=await replayFusionCostSource(await request(p,'seconds',gpu0));
 expect(initial).toMatchObject({operation:'fixed_override',metric:{quantity:{value:.5}}});
 expect(initial.items.every(item=>'resourceRemoved'in item||item.kind==='elided_allocation')).toBe(true);
 const formula=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'test:fusion:time',revision:1,name:'Fusion timing fixture',parameters:[],tags:[],sources:[],definition:{kind:'formula',formula:{inputs:{n:{unit:'count',integerRequired:true}},expression:'n * 0.25',output:{unit:'second',integerRequired:false,nonNegative:true},description:'Synthetic fixed rate'}}});
 p.assetSnapshots.push(formula);
 group.timeStrategy={kind:'override',description:'Explicit whole time formula',timing:{kind:'custom_formula',description:'Declared formula for the whole group',seconds:{kind:'formula',call:{formula:{assetId:formula.assetId,revision:1,kind:'formula'},bindings:{n:{kind:'symbol',name:'N'}}}}}};
 const modeled=await replayFusionCostSource(await request(p,'seconds',gpu0));
 expect(modeled).toMatchObject({operation:'formula_override',metric:{quantity:{value:.25}},overrideFormula:{proof:{bindings:[{quantity:{value:1},proof:{symbol:'N'}}]}}});
 group.timeStrategy={kind:'override',description:'Explicit whole Roofline',timing:roofline};
 const report=await replayFusionCostSource(await request(p,'seconds',gpu0));
 expect(report).toMatchObject({operation:'roofline_override',dag:{root:'timing.seconds',completeTiming:true}});
 expect(report.dag?.nodes).toContainEqual(expect.objectContaining({id:'hbm.work',value:4}));
 expect(report.dag?.nodes).toContainEqual(expect.objectContaining({id:'compute["0"].work',value:6}));
});

it('uses the scheduled fusion span on an actual Decode step and checks reply identity',async()=>{
 const p=fused(),s=p.scenarios[0]!;
 if(s.workload.kind!=='decode')throw Error('Missing Decode');
 s.workload.steps=3;
 s.deviceTopology.groups=[{groupId:'single',members:[gpu0]}];
 s.executionPlan={kind:'streams',resourcePolicy:{kind:'user_efficiency',efficiency:.5},extraDependencies:[],assignments:['A','B'].map(id=>({nodeId:NodeId.parse(id),groupId:'single',streamId:'fused'}))};
 const fixed=await request(p,'seconds',undefined,2),report=await replayFusionCostSource(fixed);
 expect(report).toMatchObject({operation:'stream_span',streamSpan:{startSeconds:0,endSeconds:6.2,streamId:'fused'},request:{stepContext:{index:2}}});
 expect(report.items[0]).toMatchObject({kind:'device',quantity:{value:3.1}});
 expect(report.items[0]).not.toHaveProperty('step');
 const task={taskId:'fusion-test',phase:'fusion_cost_source',request:fixed};
 const reply={taskId:task.taskId,phase:task.phase,status:'available',report};
 expect(readFusionSourceReply(reply,task)).toBe(reply);
 expect(()=>readFusionSourceReply({...reply,phase:'local_cost_source'},task)).toThrow('任务身份');
 await expect(replayFusionCostSource({...fixed,selector:{...fixed.selector,scope:{...fixed.selector.scope,deviceIds:[gpu1]}}})).rejects.toThrow('完整范围');
 await expect(replayFusionCostSource({...fixed,page:1})).rejects.toThrow('页不存在');
});
