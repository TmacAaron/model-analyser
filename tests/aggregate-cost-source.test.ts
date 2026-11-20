import {expect,it} from 'vitest';
import {AssetDocument,NodeId,type ProjectDocument,type MetricScope} from '@model-analyser/contracts';
import {analyzeScenario,replayAggregateCostSource,verifyAggregateCostSourceReport,type AggregateCostSelector} from '@model-analyser/core';
import {readAggregateSourceReply,type AggregateSourceTask} from '../apps/web/src/aggregate-source-task.js';
import {makeDecodeProject} from '../scripts/decode-project.js';
import {makeFusedProject} from '../scripts/fused-project.js';
import {makeNativeCollectiveProject} from '../scripts/native-collective-project.js';
import {makeStreamProject} from '../scripts/stream-project.js';
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
