import {expect,it} from 'vitest';
import {DeviceId,NodeId,TensorId,type ProjectDocument} from '@model-analyser/contracts';
import {analyzeScenario,replayLocalCostSource,verifyLocalCostSourceReport,type LocalCostSelector} from '@model-analyser/core';
import {makeLocalGemmProject} from '../scripts/local-gemm-project.js';
import {makeStreamProject} from '../scripts/stream-project.js';
import {readLocalSourceReply} from '../apps/web/src/local-source-task.js';
import {c01Project} from './model-fixtures.js';

const gemm=()=>makeLocalGemmProject(c01Project());
const target={kind:'node' as const,nodeId:NodeId.parse('module/op')};
const lit=(value:number,unit:'count'|'byte')=>({kind:'literal' as const,quantity:{value,unit}});
function rule(project:ProjectDocument){
 const op=project.assetSnapshots.find(a=>a.definition.kind==='operator');
 if(op?.definition.kind!=='operator'||!op.definition.operator.localCost)throw Error('Missing test local rule');
 return op.definition.operator.localCost;
}
async function request(project:ProjectDocument,field:LocalCostSelector['field'],rank=1,step?:number){
 const scenario=project.scenarios[0]!,assets=project.assetSnapshots,attempt=await analyzeScenario(scenario,assets);
 if(attempt.status!=='available')throw Error(JSON.stringify(attempt.diagnostics));
 const actualStep=step===undefined?undefined:attempt.result.decode?.steps[step];
 if(step!==undefined&&!actualStep)throw Error('Missing test Decode step');
 const result=actualStep?.result??attempt.result;
 const node=result.distributed?.layout.localCosts.nodes.find(n=>n.placement.kind==='placed');
 const row=node?.placement.kind==='placed'?node.placement.perDevice[rank]:undefined;
 if(!node||row?.outcome.status!=='available')throw Error('Missing test device result');
 const {cost}=row.outcome;
 const compute=field==='usefulOperations'||field==='executedOperations';
 const metric=compute?cost.compute[0]?.[field]:cost[field];
 if(!metric)throw Error('Missing test metric');
 return {scenario:actualStep?.scenario??scenario,assets,inputHash:result.inputHash,engineVersion:result.engineVersion,metric,
  selector:{nodeId:node.nodeId,deviceId:row.deviceId,scope:cost.scope,field,...(compute?{computeIndex:0,computeClass:cost.compute[0]?.computeClass}:{})},
  ...(result.stepContext?{stepContext:result.stepContext,...(actualStep?{decodeFrame:true as const}:{})}:{})};
}

it('uses the padded tail device dimensions and the unmodified lexical operand of the original formula',async()=>{
 const project=gemm(),scenario=project.scenarios[0]!;
 scenario.bindings=[{parameterKey:'N',value:{kind:'integer',value:9}}];
 for(const a of scenario.parallelPlan.assignments)for(const t of a.tensorDistributions)if(t.distribution.kind==='sharded')t.distribution.policy={kind:'padded'};
 const work=rule(project).cost.compute[0]!;
 if(work.usefulOperations.kind!=='formula')throw Error('Missing test formula');
 work.usefulOperations.call.bindings['K']={kind:'symbol',name:'K'};
 const fixed={...await request(project,'usefulOperations'),proofVersion:2 as const},useful=await replayLocalCostSource(fixed);
 expect(useful).toMatchObject({selector:{nodeId:'module/op',deviceId:'gpu1'},metric:{quantity:{value:512}},complete:true});
 expect(useful.items.find(item=>item.kind==='binding'&&item.binding.symbol==='nl')).toMatchObject({binding:{quantity:{value:4,unit:'count'}},tensor:{slices:expect.arrayContaining([expect.objectContaining({axisId:'col',start:5,end:9})])}});
 expect(useful.items.at(-1)).toMatchObject({kind:'compute',formula:{proof:{bindings:[{name:'M'},{name:'N'},{name:'K',quantity:{value:16,unit:'count'},proof:{symbol:'K'}}]}}});
 expect(useful).toMatchObject({schemaVersion:2,expressionOperandsComplete:true});
 expect(useful.expressionOperands).toMatchObject([
  {name:'ml',quantity:{value:4,unit:'count'},source:{kind:'physical',layout:{kind:'tensor',nodeId:'module/op',tensorId:'X',deviceId:'gpu1'}}},
  {name:'nl',quantity:{value:4,unit:'count'},source:{kind:'physical',layout:{kind:'tensor',nodeId:'module/op',tensorId:'Y',deviceId:'gpu1'},source:{kind:'tensor_axis',basis:'logical'}}},
  {name:'K',quantity:{value:16,unit:'count'},source:{kind:'parameter',frameId:'["asset","module/op"]'}},
 ]);
 expect(useful.parameterBindings?.roots).toMatchObject([{name:'K',target:expect.stringContaining('有效工作')}]);
 expect(useful.parameterBindings?.nodes.filter(node=>node.kind==='parameter').map(node=>node.frameId)).toEqual(['["asset","$model"]','["asset","module"]','["asset","module/op"]']);
 expect((await replayLocalCostSource(await request(project,'executedOperations'))).metric).toMatchObject({quantity:{value:640}});
 expect(await verifyLocalCostSourceReport(JSON.parse(JSON.stringify(useful)))).toEqual(useful);
 const altered=structuredClone(useful);
 const read=altered.expressionOperands?.find(item=>item.name==='nl');
 if(read?.source.kind!=='physical')throw Error('Missing test device operand');
 read.source.layout.deviceId=DeviceId.parse('gpu0');
 await expect(verifyLocalCostSourceReport(altered)).rejects.toThrow('固定输入复算不同');
});

it('uses the device binding when it shadows a same-valued lexical symbol',async()=>{
 const project=gemm(),local=rule(project),work=local.cost.compute[0]!;
 if(work.usefulOperations.kind!=='formula')throw Error('Missing test formula');
 work.usefulOperations.call.bindings['K']={kind:'symbol',name:'K'};
 local.bindings.push({symbol:'K',source:{kind:'tensor_axis',tensorId:TensorId.parse('X'),axisId:'col',basis:'logical'}});
 const report=await replayLocalCostSource({...await request(project,'usefulOperations'),proofVersion:2});
 expect(report.expressionOperands?.find(row=>row.name==='K')).toMatchObject({
  quantity:{value:16,unit:'count'},source:{kind:'physical',layout:{kind:'tensor',tensorId:'X',deviceId:'gpu1'}},
 });
 expect(report.parameterBindings?.roots).toEqual([]);
});

it('uses each device allocation and explicit passes before prorating traffic, then uses factor or independent HBM bytes',async()=>{
 const project=gemm(),scenario=project.scenarios[0]!,accesses=rule(project).cost.memoryAccess;
 accesses[0]!.logicalBytes={kind:'storage_allocation',passes:lit(2,'count')};
 accesses[0]!.hbmEstimate={kind:'factor',value:0.5};
 accesses[1]!.hbmEstimate={kind:'bytes',value:lit(10,'byte')};
 scenario.numericOverrides=[{target,field:'traffic_bytes',value:{value:208,unit:'byte'}}];
 const fixed={...await request(project,'hbmBytes'),proofVersion:2 as const},report=await replayLocalCostSource(fixed);
 expect(report.trafficOverride).toMatchObject({index:0,originalTotal:416});
 expect(report.items.filter(item=>item.kind==='access')).toMatchObject([
  {logicalFormula:{quantity:{value:2,unit:'count'}},allocation:{copies:1,totalBytes:{quantity:{value:128}}},replacement:{originalBytes:256,replacementBytes:128},hbmFactor:.5,hbm:{quantity:{value:64}}},
  {hbmFormula:{quantity:{value:10}},hbm:{quantity:{value:10}}},
  {mode:'write',hbm:{quantity:{value:16}},step:{before:74,after:90}},
 ]);
 expect(report.metric).toMatchObject({quantity:{value:90},basis:'estimated'});
 expect(report.expressionOperands).toContainEqual(expect.objectContaining({name:'wBytes',expression:expect.objectContaining({kind:'access',field:'logicalBytes'}),
  source:expect.objectContaining({kind:'physical',layout:{kind:'storage',storageId:'sW',deviceId:'gpu1'}})}));
 const read=await replayLocalCostSource(await request(project,'logicalReadBytes'));
 expect(read.items.filter(item=>item.kind==='access')).toHaveLength(3);
 const altered=structuredClone(report);
 const first=altered.items.find(item=>item.kind==='access');
 if(!first?.replacement)throw Error('Missing test override');
 first.replacement.originalBytes+=1;
 await expect(verifyLocalCostSourceReport(altered)).rejects.toThrow('固定输入复算不同');
});

it('replays local Roofline efficiency and fixed timing in the actual order, including the single-device baseline',async()=>{
 const project=gemm(),scenario=project.scenarios[0]!;
 scenario.numericOverrides=[{target,field:'traffic_bytes',value:{value:64,unit:'byte'}},{target,field:'memory_efficiency',value:{value:.5,unit:'ratio'}}];
 const roofline=await replayLocalCostSource(await request(project,'seconds'));
 expect(roofline).toMatchObject({metric:{quantity:{value:1.28}},dag:{root:'timing.seconds',completeTiming:true},timingOverrides:[{index:1,change:{before:{memoryEfficiency:1},after:{memoryEfficiency:.5}}}]});
 expect(roofline.dag?.nodes).toContainEqual(expect.objectContaining({id:'hbm.efficiency',value:.5}));
 scenario.numericOverrides[1]={target,field:'fixed_seconds',value:{value:0,unit:'second'}};
 expect(await replayLocalCostSource(await request(project,'seconds'))).toMatchObject({metric:{quantity:{value:0}},items:expect.arrayContaining([expect.objectContaining({kind:'fixed',definition:{kind:'fixed',seconds:0,description:'Explicit per-local-node time override'}})])});
 const single=await replayLocalCostSource(await request(makeStreamProject(c01Project()),'seconds',0));
 expect(single.schemaVersion).toBe(1);
 expect(single).not.toHaveProperty('expressionOperands');
 expect(single.participation).toEqual({kind:'complete_single_device'});
});

it('links equal-valued Roofline input segments and HBM to exact same-device sources in the actual Decode step',async()=>{
 const project=gemm(),scenario=project.scenarios[0]!;
 if(scenario.workload.kind!=='decode')throw Error('Missing test Decode');
 scenario.workload.steps=3;
 const compute=rule(project).cost.compute;
 compute.push({...structuredClone(compute[0]!),segmentId:'second-matmul'});
 const fixed={...await request(project,'seconds',1,2),proofVersion:3 as const},report=await replayLocalCostSource(fixed);
 expect(report.schemaVersion).toBe(3);
 const operands=report.rooflineOperands;
 if(!operands)throw Error('Missing actual Roofline inputs');
 expect(operands).toMatchObject([
  {timingNodeId:'compute["matmul"].work',segmentId:'matmul',selector:{deviceId:'gpu1',computeIndex:0,field:'executedOperations'},quantity:{unit:'operation',value:512}},
  {timingNodeId:'compute["second-matmul"].work',segmentId:'second-matmul',selector:{deviceId:'gpu1',computeIndex:1,field:'executedOperations'},quantity:{unit:'operation',value:512}},
  {timingNodeId:'hbm.work',selector:{deviceId:'gpu1',field:'hbmBytes'},quantity:{unit:'byte'}},
 ]);
 const second=operands[1];
 if(!second)throw Error('Missing second compute operand');
 const derived=await replayLocalCostSource({...fixed,selector:second.selector,metric:(await request(project,'executedOperations',1,2)).metric});
 expect(derived.items[0]).toMatchObject({index:1,segmentId:'second-matmul'});
 expect(await verifyLocalCostSourceReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
 const forged=structuredClone(report),altered=forged.rooflineOperands?.[1];
 if(!altered)throw Error('Missing operand to tamper');
 altered.selector.computeIndex=0;
 await expect(verifyLocalCostSourceReport(forged)).rejects.toThrow('固定输入复算不同');
 const task={taskId:'roofline',phase:'local_cost_source',request:fixed};
 const reply={taskId:task.taskId,phase:task.phase,status:'available',report};
 expect(readLocalSourceReply(reply,task)).toBe(reply);
 expect(()=>readLocalSourceReply({...reply,report:forged},task)).toThrow('原运算不同');
 const legacy=await replayLocalCostSource({...fixed,proofVersion:2});
 expect(legacy).not.toHaveProperty('rooflineOperands');
 expect(legacy.dag).toEqual(report.dag);
 expect(await verifyLocalCostSourceReport(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
});

it('binds an actual Decode frame, retains unavailable HBM, and rejects stale or substituted identities',async()=>{
 const project=gemm(),scenario=project.scenarios[0]!;
 if(scenario.workload.kind!=='decode')throw Error('Missing test Decode');
 scenario.workload.steps=3;
 rule(project).cost.memoryAccess[0]!.logicalBytes=lit(128,'byte');
 delete rule(project).cost.memoryAccess[0]!.hbmEstimate;
 const fixed=await request(project,'hbmBytes',1,2),report=await replayLocalCostSource(fixed);
 expect(report).toMatchObject({request:{stepContext:{index:2}},metric:{status:'unavailable'},complete:false});
 expect(report.diagnostics[0]?.diagnosticId).toMatch(/^decode-step-2::/);
 expect(report.items.find(item=>item.kind==='access')).toMatchObject({hbm:{status:'unavailable'},logical:{quantity:{value:128}}});
 await expect(replayLocalCostSource({...fixed,selector:{...fixed.selector,deviceId:DeviceId.parse('gpu0')}})).rejects.toThrow('设备');
 await expect(replayLocalCostSource({...fixed,scenario})).rejects.toThrow('实际 Decode');
 const stepContext={...fixed.stepContext,index:0};
 await expect(replayLocalCostSource({...fixed,stepContext})).rejects.toThrow('版本不匹配');
});

it('paginates actual bindings and rejects oversized worker evidence and incorrect compute segment identity',async()=>{
 const project=gemm();
 for(let i=0;i<25;i++)rule(project).bindings.push({symbol:'copy'+i,source:{kind:'tensor_copies',tensorId:TensorId.parse('Y')}});
 const fixed={...await request(project,'executedOperations'),proofVersion:2 as const},report=await replayLocalCostSource({...fixed,page:1});
 expect(report).toMatchObject({page:1,componentCount:35,complete:false});
 expect(report.items).toHaveLength(15);
 expect(report.items.at(-1)).toMatchObject({kind:'compute',index:0});
 expect(report.expressionOperands?.map(row=>row.name)).toEqual(['ma','na','ka']);
 expect((await replayLocalCostSource(fixed)).expressionOperands).toEqual([]);
 const current=await replayLocalCostSource({...fixed,proofVersion:3});
 expect(current.items[0]).toMatchObject({kind:'compute',index:0});
 expect(current.expressionOperands?.map(row=>row.name)).toEqual(['ma','na','ka']);
 await expect(replayLocalCostSource({...fixed,selector:{...fixed.selector,computeIndex:1}})).rejects.toThrow('计算段');
 await expect(replayLocalCostSource({...fixed,page:2})).rejects.toThrow('页不存在');
 const task={taskId:'test',phase:'local_cost_source',request:{...fixed,page:1}};
 const reply={taskId:task.taskId,phase:task.phase,status:'available',report};
 expect(readLocalSourceReply(reply,task)).toBe(reply);
 expect(()=>readLocalSourceReply({...reply,report:{...report,items:[]}},task)).toThrow('分页');
 expect(()=>readLocalSourceReply({...reply,report:{...report,expressionOperands:Array(257).fill(report.expressionOperands?.[0])}},task)).toThrow('记录范围');
});
