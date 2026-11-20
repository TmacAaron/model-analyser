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
 const fixed=await request(project,'usefulOperations'),useful=await replayLocalCostSource(fixed);
 expect(useful).toMatchObject({selector:{nodeId:'module/op',deviceId:'gpu1'},metric:{quantity:{value:512}},complete:true});
 expect(useful.items.find(item=>item.kind==='binding'&&item.binding.symbol==='nl')).toMatchObject({binding:{quantity:{value:4,unit:'count'}},tensor:{slices:expect.arrayContaining([expect.objectContaining({axisId:'col',start:5,end:9})])}});
 expect(useful.items.at(-1)).toMatchObject({kind:'compute',formula:{proof:{bindings:[{name:'M'},{name:'N'},{name:'K',quantity:{value:16,unit:'count'},proof:{symbol:'K'}}]}}});
 expect((await replayLocalCostSource(await request(project,'executedOperations'))).metric).toMatchObject({quantity:{value:640}});
 expect(await verifyLocalCostSourceReport(JSON.parse(JSON.stringify(useful)))).toEqual(useful);
});

it('uses each device allocation and explicit passes before prorating traffic, then uses factor or independent HBM bytes',async()=>{
 const project=gemm(),scenario=project.scenarios[0]!,accesses=rule(project).cost.memoryAccess;
 accesses[0]!.logicalBytes={kind:'storage_allocation',passes:lit(2,'count')};
 accesses[0]!.hbmEstimate={kind:'factor',value:0.5};
 accesses[1]!.hbmEstimate={kind:'bytes',value:lit(10,'byte')};
 scenario.numericOverrides=[{target,field:'traffic_bytes',value:{value:208,unit:'byte'}}];
 const fixed=await request(project,'hbmBytes'),report=await replayLocalCostSource(fixed);
 expect(report.trafficOverride).toMatchObject({index:0,originalTotal:416});
 expect(report.items.filter(item=>item.kind==='access')).toMatchObject([
  {logicalFormula:{quantity:{value:2,unit:'count'}},allocation:{copies:1,totalBytes:{quantity:{value:128}}},replacement:{originalBytes:256,replacementBytes:128},hbmFactor:.5,hbm:{quantity:{value:64}}},
  {hbmFormula:{quantity:{value:10}},hbm:{quantity:{value:10}}},
  {mode:'write',hbm:{quantity:{value:16}},step:{before:74,after:90}},
 ]);
 expect(report.metric).toMatchObject({quantity:{value:90},basis:'estimated'});
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
 expect(single.participation).toEqual({kind:'complete_single_device'});
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
 const fixed=await request(project,'executedOperations'),report=await replayLocalCostSource({...fixed,page:1});
 expect(report).toMatchObject({page:1,componentCount:35,complete:false});
 expect(report.items).toHaveLength(15);
 expect(report.items.at(-1)).toMatchObject({kind:'compute',index:0});
 await expect(replayLocalCostSource({...fixed,selector:{...fixed.selector,computeIndex:1}})).rejects.toThrow('计算段');
 await expect(replayLocalCostSource({...fixed,page:2})).rejects.toThrow('页不存在');
 const task={taskId:'test',phase:'local_cost_source',request:{...fixed,page:1}};
 const reply={taskId:task.taskId,phase:task.phase,status:'available',report};
 expect(readLocalSourceReply(reply,task)).toBe(reply);
 expect(()=>readLocalSourceReply({...reply,report:{...report,items:[]}},task)).toThrow('分页');
});
