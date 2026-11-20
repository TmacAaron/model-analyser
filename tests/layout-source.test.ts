import {expect,it} from 'vitest';
import {DeviceId,NodeId,QuantizedStorageSpec,StorageId,TensorId,type ProjectDocument} from '@model-analyser/contracts';
import {analyzeScenario,replayLayoutSource,resolveParallelPlan,verifyLayoutSourceReport,partitionTensor,type LayoutSourceRequest,type LayoutSourceSelector} from '@model-analyser/core';
import {readLayoutSourceReply} from '../apps/web/src/layout-source-task.js';
import {makeLocalGemmProject} from '../scripts/local-gemm-project.js';
import {makeFusedProject} from '../scripts/fused-project.js';
import {c01Project} from './model-fixtures.js';

const gpu0=DeviceId.parse('gpu0'),gpu1=DeviceId.parse('gpu1'),nodeId=NodeId.parse('module/op'),root=NodeId.parse('$model');
const gemm=()=>makeLocalGemmProject(c01Project());
const tensor=(tensorId:string,deviceId=gpu1)=>({kind:'tensor' as const,nodeId,tensorId:TensorId.parse(tensorId),deviceId});
const storage=(storageId:string,deviceId=gpu1)=>({kind:'storage' as const,storageId:StorageId.parse(storageId),deviceId});
const literal=(value:number)=>({kind:'literal' as const,quantity:{value,unit:'count' as const}});
const weight4=QuantizedStorageSpec.parse({payloadBits:4,packingUnitElements:1,alignmentBytes:1,auxiliaries:[]});

async function request(project:ProjectDocument,selector:LayoutSourceSelector):Promise<LayoutSourceRequest>{
 const scenario=project.scenarios[0]!,assets=project.assetSnapshots,attempt=await resolveParallelPlan(scenario,assets);
 if(attempt.status!=='available')throw Error(JSON.stringify(attempt.diagnostics));
 return {scenario,assets,inputHash:attempt.result.inputHash,engineVersion:attempt.result.engineVersion,selector};
}

async function allItems(fixed:LayoutSourceRequest){
 const first=await replayLayoutSource(fixed),items=[...first.items];
 for(let page=1;page*first.pageSize<first.componentCount;page++)items.push(...(await replayLayoutSource({...fixed,page})).items);
 return {first,items};
}

it('connects the winning and overridden rules to the actual tail shard and its authored dimension',async()=>{
 const project=gemm(),scenario=project.scenarios[0]!,base=scenario.parallelPlan.assignments[0]!;
 scenario.bindings=[{parameterKey:'N',value:{kind:'integer',value:9}}];
 for(const tensor of base.tensorDistributions)if(tensor.distribution.kind==='sharded')tensor.distribution.policy={kind:'padded'};
 const output=base.tensorDistributions.find(t=>t.tensorId==='Y')!;
 const specific={selector:{kind:'nodes' as const,nodeIds:[nodeId]},phases:base.phases,tensorDistributions:[structuredClone(output)],storageDistributions:[]};
 output.distribution={kind:'replicated',groupId:'tp'};
 scenario.parallelPlan.assignments.push(specific,structuredClone(specific));
 const fixed=await request(project,tensor('Y')),report=await replayLayoutSource(fixed);
 expect(report).toMatchObject({group:{groupId:'tp',coordinates:[1]},tensor:{logicalElements:16,allocatedElements:20,assignmentIndices:[1,2],overriddenIndices:[0],coverage:'padded'}});
 expect(report.items).toContainEqual({kind:'partition',operation:{kind:'axis',axisId:'col',method:'padded',extent:9,logical:4,allocated:5,start:5,end:9,mesh:{axisId:'tp',width:2,rank:1}}});
 expect(report.items.filter(item=>item.kind==='rule').map(item=>[item.rule.index,item.rule.status])).toEqual([[0,'overridden'],[1,'selected'],[2,'equivalent']]);
 expect(report.items.find(item=>item.kind==='formula'&&item.field.endsWith('col'))).toMatchObject({formula:{quantity:{value:9},proof:{symbol:'N'}}});
 expect(await verifyLayoutSourceReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
 const tampered=structuredClone(report);tampered.items.reverse();
 await expect(verifyLayoutSourceReport(tampered)).rejects.toThrow('固定输入复算不同');
 await expect(replayLayoutSource({...fixed,selector:{...tensor('Y'),nodeId:NodeId.parse('another')}})).rejects.toThrow('不唯一');
});

it('shows the coverage guard for custom slices and the actual empty-shard multiplication shortcut',async()=>{
 const project=gemm(),scenario=project.scenarios[0]!,base=scenario.parallelPlan.assignments[0]!;
 for(const entry of base.tensorDistributions)if(entry.distribution.kind==='sharded')entry.distribution.policy={kind:'explicit',slices:[{deviceId:gpu0,axisId:'col',start:0,end:3},{deviceId:gpu1,axisId:'col',start:3,end:8}]};
 const explicit=await replayLayoutSource(await request(project,tensor('Y')));
 expect(explicit.items).toContainEqual({kind:'partition',operation:{kind:'explicit_coverage',rectangles:2,covered:32,globalElements:32}});
 expect(explicit.tensor).toMatchObject({logicalElements:20,allocatedElements:20});
 scenario.bindings=[{parameterKey:'N',value:{kind:'integer',value:1}}];
 for(const entry of base.tensorDistributions)if(entry.distribution.kind==='sharded')entry.distribution.policy={kind:'padded'};
 const empty=await replayLayoutSource(await request(project,tensor('Y')));
 expect(empty.items).toContainEqual({kind:'partition',operation:{kind:'elements',scope:'logical',dimensions:[4,0],emptyAxis:1,value:0}});
 expect(empty.tensor).toMatchObject({logicalElements:0,allocatedElements:4});
});

it('replays manual copies, per-copy padding, bit packing, auxiliary formulas and winning quantization scope',async()=>{
 const p=gemm(),s=p.scenarios[0]!,y=s.parallelPlan.assignments[0]!.tensorDistributions.find(t=>t.tensorId==='Y')!;
 y.distribution={kind:'manual',groupId:'tp',description:'Two local copies',members:[gpu0,gpu1].map(deviceId=>({deviceId,copies:2,localShape:[
  {axisId:'row',semantic:'custom',size:literal(4)},{axisId:'col',semantic:'custom',size:literal(4)},
 ]}))};
 s.quantizationOverrides=[
  {selector:{kind:'subtree',rootNodeId:root},activation:weight4},
  {selector:{kind:'subtree',rootNodeId:root},storageIds:[StorageId.parse('sY')],activation:QuantizedStorageSpec.parse({payloadBits:5,packingUnitElements:6,alignmentBytes:16,
   auxiliaries:[
    {name:'scale',dtype:{category:'float',bits:16,format:'fp16'},count:{kind:'group',groupSize:5}},
    {name:'channel',dtype:{category:'float',bits:16,format:'fp16'},count:{kind:'channel',axisId:'col'}},
    {name:'formula',dtype:{category:'float',bits:16,format:'fp16'},count:{kind:'formula',value:{kind:'symbol',name:'N'}}},
   ]})},
 ];
 const fixed=await request(p,storage('sY')),{first,items}=await allItems(fixed);
 expect(first.storage).toMatchObject({perCopyBytes:48,totalBytes:96,copies:2,materialization:'materialized',quantization:{stage:'effective',payloadBits:5,packingUnitElements:6,alignmentBytes:16,ruleIndex:1,nodeId}});
 expect(items).toContainEqual({kind:'allocation',operation:{field:'paddedElements',operation:'ceil_multiple',inputs:[16,6],value:18,unit:'count'}});
 expect(items).toContainEqual({kind:'allocation',operation:{field:'packedPayload',operation:'ceil_bits_div8',inputs:[18,5],value:12,unit:'byte'}});
 expect(items).toContainEqual({kind:'allocation',operation:{field:'alignedPayload',operation:'ceil_multiple',inputs:[12,16],value:16,unit:'byte'}});
 expect(items).toContainEqual({kind:'copies',copies:2,perCopyBytes:48,totalBytes:96});
 expect(items.find(item=>item.kind==='formula'&&item.field.includes('量化辅助项'))).toMatchObject({formula:{quantity:{value:8},proof:{symbol:'N'}}});
 expect(items.find(item=>item.kind==='quantization')).toMatchObject({winners:[{ruleIndex:1,priority:3}],losers:[{ruleIndex:0,priority:1}]});
 expect(items.length).toBeGreaterThan(20);
 const second=await replayLayoutSource({...fixed,page:1});
 expect(await verifyLayoutSourceReport(JSON.parse(JSON.stringify(second)))).toEqual(second);
});

it('shows the actual backing capacity check and a zero-byte override after quantization',async()=>{
 const p=gemm(),s=p.scenarios[0]!,base=s.parallelPlan.assignments[0]!;
 base.storageDistributions=[{storageId:StorageId.parse('sW'),distribution:{kind:'replicated',groupId:'tp'}}];
 const backing=await allItems(await request(p,storage('sW')));
 expect(backing.items.find(item=>item.kind==='origin'&&item.origin.kind==='verified_backing')).toMatchObject({origin:{objectId:'W',capacity:{requiredBytes:128,backingBytes:256}}});
 s.quantizationOverrides=[{selector:{kind:'subtree',rootNodeId:root},storageIds:[StorageId.parse('sX')],activation:weight4}];
 s.numericOverrides=[{target:{kind:'storage',storageId:StorageId.parse('sX')},field:'memory_bytes',value:{unit:'byte',value:0}}];
 const {first,items}=await allItems(await request(p,storage('sX')));
 expect(first.storage).toMatchObject({totalBytes:0,override:{overrideIndex:0,before:{kind:'tensor'},after:{kind:'bytes'}},quantization:{stage:'overridden'}});
 expect(items).toContainEqual({kind:'allocation',operation:{field:'payload',operation:'declared_bytes',inputs:[0],value:0,unit:'byte'}});
 expect(items.some(item=>item.kind==='allocation'&&item.operation.field==='packedPayload')).toBe(false);
});

it('shows fusion elision at the allocation stage and keeps protocol and page identity',async()=>{
 const p=makeFusedProject(c01Project()),fixed=await request(p,storage('sT',gpu0)),report=await replayLayoutSource(fixed);
 expect(report).toMatchObject({syntheticBaseline:true,storage:{materialization:'elided',elidedBy:'$fusion:pair',totalBytes:0,perCopyBytes:0}});
 expect(report.items.some(item=>item.kind==='allocation'||item.kind==='copies')).toBe(false);
 const task={taskId:'layout-test',phase:'layout_source',request:fixed},reply={taskId:task.taskId,phase:task.phase,status:'available',report};
 expect(readLayoutSourceReply(reply,task)).toBe(reply);
 expect(()=>readLayoutSourceReply({...reply,report:{...report,items:[]}},task)).toThrow('分页');
 expect(()=>readLayoutSourceReply({...reply,phase:'local_cost_source'},task)).toThrow('任务身份');
 await expect(replayLayoutSource({...fixed,page:10})).rejects.toThrow('页不存在');
 await expect(replayLayoutSource({...fixed,selector:storage('sT',gpu1)})).rejects.toThrow('所选设备');
});

it('does not allow a partition observer to mutate engine inputs or the resulting shapes',()=>{
 const p=gemm(),s=p.scenarios[0]!,t={tensorId:TensorId.parse('probe'),storageId:StorageId.parse('probe'),name:'probe',shape:[{axisId:'col',semantic:'custom' as const,size:literal(8)}],dtype:{category:'float' as const,bits:16,format:'bf16'}};
 const distribution={kind:'sharded' as const,groupId:'tp',axes:[{meshAxisId:'tp',tensorAxisId:'col'}],policy:{kind:'padded' as const}};
 const context={assets:p.assetSnapshots,symbols:{}};
 const baseline=partitionTensor(t,distribution,s.deviceTopology,context);
 expect(partitionTensor(t,distribution,s.deviceTopology,context,{deviceId:gpu1,record:event=>{
  if(event.kind==='elements')event.dimensions[0]=99;
  if(event.kind==='axis')event.allocated=99;
 }})).toEqual(baseline);
});

it('binds the layout report to the actual Decode step identity',async()=>{
 const p=gemm(),scenario=p.scenarios[0]!,assets=p.assetSnapshots;
 if(scenario.workload.kind!=='decode')throw Error('Missing Decode workload');
 scenario.workload.steps=2;
 const result=await analyzeScenario(scenario,assets),step=result.status==='available'?result.result.decode?.steps[1]:undefined;
 if(!step||!step.result.stepContext)throw Error('Missing actual Decode step');
 const fixed={scenario:step.scenario,assets,stepContext:step.result.stepContext,inputHash:step.result.inputHash,engineVersion:step.result.engineVersion,selector:tensor('Y')};
 const report=await replayLayoutSource(fixed);
 expect(report).toMatchObject({request:{stepContext:{index:1}},tensor:{logicalElements:16}});
 await expect(replayLayoutSource({...fixed,stepContext:{...step.result.stepContext,index:0}})).rejects.toThrow('版本不同');
 await expect(replayLayoutSource({...fixed,scenario})).rejects.toThrow('单个实际 Decode');
});
