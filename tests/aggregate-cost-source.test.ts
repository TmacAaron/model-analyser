import {expect,it} from 'vitest';
import {AssetDocument,DeviceId,NodeId,type ProjectDocument,type MetricScope} from '@model-analyser/contracts';
import {analyzeScenario,replayAggregateCostSource,verifyAggregateCostSourceReport,type AggregateCostSelector} from '@model-analyser/core';
import {readAggregateSourceReply,type AggregateSourceTask} from '../apps/web/src/aggregate-source-task.js';
import {makeDecodeProject} from '../scripts/decode-project.js';
import {makeFusedProject} from '../scripts/fused-project.js';
import {makeNativeCollectiveProject} from '../scripts/native-collective-project.js';
import {makeStreamProject} from '../scripts/stream-project.js';
import {makeLocalGemmProject} from '../scripts/local-gemm-project.js';
import {c01Project,echo} from './model-fixtures.js';

const model={kind:'model' as const};

async function request(project:Pick<ProjectDocument,'scenarios'|'assetSnapshots'>,target:MetricScope['target'],field:AggregateCostSelector['field']='seconds'){
 const scenario=project.scenarios[0]!,assets=project.assetSnapshots;
 const attempt=await analyzeScenario(scenario,assets);
 if(attempt.status!=='available')throw Error(JSON.stringify(attempt.diagnostics));
 const result=attempt.result;
 const cost=target.kind==='model'?result.total:target.kind==='module'?result.modules.find(row=>row.nodeId===target.nodeId)?.cost:result.nodes.find(row=>row.nodeId===target.nodeId)?.cost;
 if(!cost)throw Error('Expected requested fixture cost');
 const {engineVersion,inputHash}=result,scope=cost.scope;
 if(field==='usefulOperations'||field==='executedOperations'){
  const {computeClass}=cost.compute[0]!;
  return {scenario,assets,engineVersion,inputHash,selector:{scope,field,computeClass},metric:cost.compute[0]![field]};
 }
 return {scenario,assets,engineVersion,inputHash,selector:{scope,field},metric:cost[field]};
}

it('uses complete physical scope and the exact compute class for a serial module',async()=>{
 const fixed=await request(c01Project(),{kind:'module',nodeId:NodeId.parse('module')},'executedOperations');
 const result=await replayAggregateCostSource(fixed);
 expect(result).toMatchObject({operation:'ordered_sum',componentCount:1,items:[{kind:'node',target:{nodeId:'module/op'},quantity:{value:1024,unit:'operation'},before:0,after:1024}]});
 expect(await verifyAggregateCostSourceReport(JSON.parse(JSON.stringify(result)))).toEqual(result);
 const tampered=structuredClone(result);
 tampered.items[0]!.target={kind:'node',nodeId:NodeId.parse('another')};
 await expect(verifyAggregateCostSourceReport(tampered)).rejects.toThrow('固定输入复算不同');
 const wrongScope={...fixed.selector.scope,aggregation:'group_total'};
 await expect(replayAggregateCostSource({...fixed,selector:{...fixed.selector,scope:wrongScope}})).rejects.toThrow('范围');
});

it('traces a distributed node to ordered device segments, physical traffic and the slowest card',async()=>{
 const project=makeLocalGemmProject(c01Project()),scenario=project.scenarios[0]!;
 scenario.bindings=[{parameterKey:'N',value:{kind:'integer',value:9}}];
 for(const assignment of scenario.parallelPlan.assignments)for(const tensor of assignment.tensorDistributions)if(tensor.distribution.kind==='sharded')tensor.distribution.policy={kind:'padded'};
 const operator=project.assetSnapshots.find(asset=>asset.definition.kind==='operator');
 const segments=operator?.definition.kind==='operator'?operator.definition.operator.localCost?.cost.compute:undefined;
 if(!segments?.[0])throw Error('Missing local matrix segment');
 segments.push({...structuredClone(segments[0]),segmentId:'same-class-second'});
 const hardware=project.assetSnapshots.find(asset=>asset.definition.kind==='hardware');
 if(hardware?.definition.kind!=='hardware')throw Error('Missing test hardware');
 const slow=AssetDocument.parse({...hardware,assetId:'example:hardware:aggregate-slow',definition:{kind:'hardware',hardware:{...hardware.definition.hardware,
  memoryCapabilities:hardware.definition.hardware.memoryCapabilities.map(capability=>({...capability,bytesPerSecond:capability.bytesPerSecond/2}))}}});
 project.assetSnapshots.push(slow);
 scenario.deviceTopology.devices[1]!.hardware={assetId:slow.assetId,kind:'hardware',revision:slow.revision};
 const target={kind:'node' as const,nodeId:NodeId.parse('module/op')};
 const workRequest=await request(project,target,'usefulOperations'),work=await replayAggregateCostSource(workRequest);
 expect(work).toMatchObject({schemaVersion:2,operation:'device_sum',metric:{quantity:{value:2304}},items:[
  {kind:'device',deviceIds:['gpu0'],computeIndex:0,quantity:{value:640},before:0,after:640},
  {kind:'device',deviceIds:['gpu0'],computeIndex:1,quantity:{value:640},before:640,after:1280},
  {kind:'device',deviceIds:['gpu1'],computeIndex:0,quantity:{value:512},before:1280,after:1792},
  {kind:'device',deviceIds:['gpu1'],computeIndex:1,quantity:{value:512},before:1792,after:2304},
 ]});
 const traffic=await replayAggregateCostSource(await request(project,target,'hbmBytes'));
 expect(traffic).toMatchObject({operation:'device_sum',metric:{quantity:{value:656}},items:[{after:328},{after:656}]});
 const barrier=await replayAggregateCostSource(await request(project,target));
 expect(barrier).toMatchObject({operation:'device_max',metric:{quantity:{value:6.56}},items:[
  {deviceIds:['gpu0'],quantity:{value:3.28},before:0,after:3.28},
  {deviceIds:['gpu1'],quantity:{value:6.56},before:3.28,after:6.56},
 ]});
 expect(await verifyAggregateCostSourceReport(JSON.parse(JSON.stringify(work)))).toEqual(work);
 const tampered=structuredClone(work);
 Object.assign(tampered.items[0]!,{computeIndex:1});
 await expect(verifyAggregateCostSourceReport(tampered)).rejects.toThrow('固定输入复算不同');
 const task:AggregateSourceTask={taskId:'devices',phase:'aggregate_cost_source',request:workRequest};
 const reply={taskId:task.taskId,phase:task.phase,status:'available',report:work};
 expect(readAggregateSourceReply(reply,task)).toMatchObject({status:'available'});
 const wrongDevice=structuredClone(reply);
 wrongDevice.report.items[0]!.deviceIds=[DeviceId.parse('outside')];
 expect(()=>readAggregateSourceReply(wrongDevice,task)).toThrow('设备或计算段身份');

 scenario.executionPlan={kind:'streams',assignments:[],extraDependencies:[],resourcePolicy:{kind:'user_efficiency',efficiency:.5}};
 const span=await replayAggregateCostSource(await request(project,target));
 expect(span).toMatchObject({operation:'node_stream_span',metric:{quantity:{value:13.12}},startSeconds:0,endSeconds:13.12,items:[
  {kind:'device',deviceIds:['gpu0'],startSeconds:0,endSeconds:6.56},
  {kind:'device',deviceIds:['gpu1'],startSeconds:0,endSeconds:13.12},
 ]});
});

it('explains distributed metadata as an empty physical fold and rejects unplaced device costs',async()=>{
 const project=makeLocalGemmProject(c01Project());
 const operator=project.assetSnapshots.find(asset=>asset.definition.kind==='operator');
 if(operator?.definition.kind!=='operator')throw Error('Missing test operator');
 delete operator.definition.operator.localCost;
 const target={kind:'node' as const,nodeId:NodeId.parse('module/op')};
 await expect(replayAggregateCostSource(await request(project,target,'hbmBytes'))).rejects.toThrow('原指标');
 operator.definition.operator.cost={compute:[],memoryAccess:[],temporaryStorageIds:[],timing:{kind:'fixed',seconds:0,description:'Explicit metadata-only operation'}};
 const traffic=await replayAggregateCostSource(await request(project,target,'hbmBytes'));
 expect(traffic).toMatchObject({schemaVersion:2,operation:'device_sum',componentCount:0,metric:{quantity:{value:0,unit:'byte'}},metadataReason:expect.any(String)});
 const seconds=await replayAggregateCostSource(await request(project,target));
 expect(seconds).toMatchObject({schemaVersion:2,componentCount:0,metric:{quantity:{value:0,unit:'second'}},metadataReason:expect.any(String)});
});

it('replays the actual graph-native communication serial barrier and preserves unavailable HBM',async()=>{
 const project=makeNativeCollectiveProject(c01Project());
 const result=await replayAggregateCostSource(await request(project,model));
 expect(result.operation).toBe('serial_barriers');
 expect(result.metric.quantity.value).toBeCloseTo(2.913,12);
 expect(result.items).toMatchObject([{kind:'node',target:{nodeId:'module/op'}},{kind:'communication',target:{nodeId:'gather-Y'},quantity:{value:.033,unit:'second'}}]);
 const work=await replayAggregateCostSource(await request(project,model,'executedOperations'));
 expect(work.memberCount).toBe(2);
 expect(work.items).toMatchObject([{target:{nodeId:'module/op'}}]);
 await expect(replayAggregateCostSource(await request(project,model,'hbmBytes'))).rejects.toThrow('原指标');
});

it('counts an actual fusion once in the physical model aggregate',async()=>{
 const result=await replayAggregateCostSource(await request(makeFusedProject(c01Project()),model,'logicalWriteBytes'));
 expect(result.operation).toBe('ordered_sum');
 expect(result.items).toMatchObject([{kind:'fusion',target:{nodeId:'$fusion:pair'}}]);
});

it('uses terminal time and actual overlapping intervals for model and module streams',async()=>{
 const project=makeStreamProject(c01Project());
 const root=project.assetSnapshots.find(asset=>asset.definition.kind==='model');
 if(root?.definition.kind!=='model')throw Error('Missing test root');
 const block=AssetDocument.parse({...root,assetId:'example:module:aggregate-streams',definition:{kind:'module',graph:root.definition.graph}});
 project.assetSnapshots.push(block);
 root.definition.graph={inputs:[],outputs:[],tensors:[],storages:[],states:[],edges:[],dependencies:[],nodes:[{
  nodeId:NodeId.parse('block'),name:'Branches',phases:['decode'],portBindings:[],stateBindings:[],
  body:{kind:'module',asset:{assetId:block.assetId,revision:1,kind:'module'},bindings:[]},
 }]};
 const plan=project.scenarios[0]!.executionPlan;
 if(plan.kind!=='streams')throw Error('Missing streams');
 plan.assignments=plan.assignments.map(item=>({...item,nodeId:NodeId.parse('block/'+item.nodeId)}));
 const result=await replayAggregateCostSource(await request(project,model));
 expect(result.operation).toBe('stream_makespan');
 expect(result.metric.quantity.value).toBeCloseTo(.0065,12);
 expect(result.items).toEqual(expect.arrayContaining([
  expect.objectContaining({target:{kind:'node',nodeId:'block/A'},startSeconds:.001,endSeconds:.003}),
  expect.objectContaining({target:{kind:'node',nodeId:'block/B'},startSeconds:.001,endSeconds:.006}),
 ]));
 const module=await replayAggregateCostSource(await request(project,{kind:'module',nodeId:NodeId.parse('block')}));
 expect(module.operation).toBe('module_stream_span');
 expect(module.metric.quantity).toEqual(result.metric.quantity);
});

it('keeps each growing Decode value and step hash in sequence and validates an individual call',async()=>{
 const project=makeDecodeProject(c01Project()),fixed=await request(project,{kind:'node',nodeId:NodeId.parse('update')},'hbmBytes');
 const result=await replayAggregateCostSource(fixed);
 expect(result.metric.quantity.value).toBe(24);
 expect(result.items).toMatchObject([
  {step:{index:0,evaluatedContext:2},quantity:{value:6}},
  {step:{index:1,evaluatedContext:3},quantity:{value:8}},
  {step:{index:2,evaluatedContext:4},quantity:{value:10}},
 ]);
 expect(new Set(result.items.map(item=>item.step?.inputHash)).size).toBe(3);
 const attempt=await analyzeScenario(project.scenarios[0]!,project.assetSnapshots);
 if(attempt.status!=='available')throw Error('Expected sequence');
 const step=attempt.result.decode?.steps[2];
 if(!step?.result.stepContext)throw Error('Missing actual Decode context');
 const proof=await replayAggregateCostSource({...fixed,scenario:step.scenario,stepContext:step.result.stepContext,inputHash:step.result.inputHash,selector:{scope:step.result.total.scope,field:'hbmBytes'},metric:step.result.total.hbmBytes});
 expect(proof).toMatchObject({metric:{quantity:{value:10}},request:{stepContext:{index:2}},items:[{target:{nodeId:'update'}}]});
});

it('keeps cross-page prefixes and rejects a stale or oversized worker response',async()=>{
 const sample=echo('chain');
 if(sample.model.definition.kind!=='model')throw Error('Expected repeated model');
 const repeat=sample.model.definition.graph.nodes[0]?.repeat;
 if(!repeat)throw Error('Expected repeat');
 repeat.count={kind:'literal',quantity:{value:41,unit:'count'}};
 const fixed=await request({scenarios:[sample.scenario],assetSnapshots:sample.assets},model);
 const first=await replayAggregateCostSource(fixed);
 const requestPage={...fixed,page:1},second=await replayAggregateCostSource(requestPage);
 expect(first.componentCount).toBe(41);
 expect(first.items).toHaveLength(20);
 expect(second.items[0]).toMatchObject({target:{nodeId:'block[20]'},before:20,after:21});
 await expect(replayAggregateCostSource({...fixed,page:3})).rejects.toThrow('页不存在');
 const task:AggregateSourceTask={taskId:'second',phase:'aggregate_cost_source',request:requestPage};
 const reply={taskId:task.taskId,phase:task.phase,status:'available',report:second};
 expect(readAggregateSourceReply(reply,task)).toMatchObject({status:'available'});
 expect(()=>readAggregateSourceReply({...reply,taskId:'old'},task)).toThrow('任务身份');
 expect(()=>readAggregateSourceReply({...reply,report:first},task)).toThrow('当前固定输入');
 expect(()=>readAggregateSourceReply({...reply,report:{...second,items:[...second.items,...second.items]}},task)).toThrow('分页');
});
