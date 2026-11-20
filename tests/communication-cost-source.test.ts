import {expect,it} from 'vitest';
import {NodeId,type ProjectDocument} from '@model-analyser/contracts';
import {analyzeScenario,replayCommunicationCostSource,verifyCommunicationCostSourceReport,type CommunicationCostSelector} from '@model-analyser/core';
import {makeSerialGatherProject} from '../scripts/serial-gather-project.js';
import {makeNativeCollectiveProject} from '../scripts/native-collective-project.js';
import {makeNamedParallelProject} from '../scripts/named-parallel-project.js';
import {readCommunicationSourceReply} from '../apps/web/src/communication-source-task.js';
import {c01Project} from './model-fixtures.js';

async function request(project:ProjectDocument,field:CommunicationCostSelector['field']='seconds',step?:number){
 const scenario=project.scenarios[0]!,assets=project.assetSnapshots,attempt=await analyzeScenario(scenario,assets);
 if(attempt.status!=='available')throw Error(JSON.stringify(attempt.diagnostics));
 const actualStep=step===undefined?undefined:attempt.result.decode?.steps[step];
 if(step!==undefined&&!actualStep)throw Error('Missing actual step');
 const frame=actualStep?.result??attempt.result,row=frame.distributed?.layout.communications[0];
 if(!row)throw Error('Missing communication fixture');
 const cost=row.evaluation.cost,metric=field==='seconds'?cost.seconds:cost.communications[0]?.[field];
 if(!metric)throw Error('Missing communication metric');
 return {scenario:actualStep?.scenario??scenario,assets,engineVersion:frame.engineVersion,inputHash:frame.inputHash,
  selector:{index:row.index,scope:cost.scope,field,...(row.origin?{nativeNodeId:row.origin.nodeId}:{})},metric,...(frame.stepContext?{stepContext:frame.stepContext}:{})};
}

it('connects the configured gather formula to real M/N values and the transfer and startup arithmetic',async()=>{
 const fixed=await request(makeSerialGatherProject(c01Project())),report=await replayCommunicationCostSource(fixed);
 expect(report.declaration).toEqual({kind:'plan',index:0});
 expect(report.uniformMessages?.send).toMatchObject({quantity:{value:32,unit:'byte'},proof:{definition:{expression:'rows * cols'},bindings:[{name:'rows',quantity:{value:4}},{name:'cols',quantity:{value:8}}]}});
 expect(report.summary.groupSend).toMatchObject({quantity:{value:64,unit:'byte'}});
 expect(report.timing).toEqual({kind:'bandwidth_latency',maxTraffic:32,bytePerSecond:1000,rounds:1,latencySeconds:.001,transfer:.032,startup:.001,seconds:.033});
 expect(await verifyCommunicationCostSourceReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
 const tampered=structuredClone(report);
 tampered.network.effective={kind:'bandwidth_latency',bytePerSecond:2000,latencySeconds:.001};
 await expect(verifyCommunicationCostSourceReport(tampered)).rejects.toThrow('固定输入复算不同');
 await expect(replayCommunicationCostSource({...fixed,selector:{...fixed.selector,index:99}})).rejects.toThrow('通信序号');
});

it('shows graph-native role binding then actual bandwidth and latency overrides',async()=>{
 const project=makeNativeCollectiveProject(c01Project()),scenario=project.scenarios[0]!;
 const target={kind:'node' as const,nodeId:NodeId.parse('gather-Y')};
 scenario.parallelPlan.nativeBindings={
  groups:scenario.deviceTopology.groups.map(group=>({logicalGroupId:group.groupId,physicalGroupId:group.groupId,meshAxes:group.mesh?.axes.map(axis=>({logicalAxisId:axis.axisId,physicalAxisId:axis.axisId}))??[]})),
  devices:scenario.deviceTopology.devices.map(device=>({logicalDeviceId:device.deviceId,physicalDeviceId:device.deviceId})),
  network:{bytesPerSecond:4000,latencySeconds:.002},
 };
 scenario.numericOverrides=[
  {target,field:'communication_bandwidth',value:{value:2000,unit:'byte_per_second'}},
  {target,field:'communication_latency',value:{value:.003,unit:'second'}},
 ];
 const fixed=await request(project),report=await replayCommunicationCostSource(fixed);
 expect(report.declaration).toMatchObject({kind:'graph',nodeId:'gather-Y',authoredGroup:'tp'});
 expect(report.endpoints).toEqual({source:'Y',destination:'Yg'});
 expect(report.uniformMessages?.send.proof?.definition?.expression).toBe('rows * cols');
 expect(report.network).toMatchObject({authored:{bytePerSecond:1000},roleBound:{bytePerSecond:4000,latencySeconds:.002},effective:{bytePerSecond:2000,latencySeconds:.003},overrides:[{index:0,before:{bytePerSecond:4000},after:{bytePerSecond:2000}},{index:1,before:{latencySeconds:.002},after:{latencySeconds:.003}}]});
 expect(report.timing?.seconds).toBe(.019);
 await expect(replayCommunicationCostSource({...fixed,selector:{...fixed.selector,nativeNodeId:undefined}})).rejects.toThrow('通信序号');
});

it('preserves nonuniform diagnostics, per-rank factors, ordered totals, and max-sender time',async()=>{
 const project=makeSerialGatherProject(c01Project()),scenario=project.scenarios[0]!,communication=scenario.parallelPlan.communications[0]!;
 communication.perDevicePayloads=scenario.deviceTopology.devices.map((device,index)=>({deviceId:device.deviceId,
  sendBytes:{kind:'literal',quantity:{value:index?48:16,unit:'byte'}},receiveBytes:{kind:'literal',quantity:{value:index?16:48,unit:'byte'}},trafficFactor:index?1:4}));
 const fixed=await request(project,'sendBytesPerMember'),report=await replayCommunicationCostSource(fixed);
 expect(report.metric.status).toBe('unavailable');
 expect(report.diagnostics.map(d=>d.code)).toContain('nonuniform_member_quantity');
 expect(report.items).toMatchObject([
  {deviceId:'gpu0',factor:4,traffic:{quantity:{value:64}},sendSum:{before:0,after:16},receiveSum:{before:0,after:48}},
  {deviceId:'gpu1',factor:1,traffic:{quantity:{value:48}},sendSum:{before:16,after:64},receiveSum:{before:48,after:64}},
 ]);
 expect(report.timing).toMatchObject({maxTraffic:64,seconds:.065});
 expect(report.summary.groupSend).toMatchObject({quantity:{value:64}});
 expect(await verifyCommunicationCostSourceReport(report)).toEqual(report);
});

it('counts only the explicit send_recv endpoints and keeps fixed seconds separate from HBM',async()=>{
 const {project}=await makeNamedParallelProject('pp2'),fixed=await request(project,'groupSendBytes');
 const report=await replayCommunicationCostSource(fixed);
 expect(report.operation).toBe('send_recv');
 expect(report.uniformMessages?.count).toBe(1);
 expect(report.items.map(row=>row.role).sort()).toEqual(['receiver','sender']);
 const sender=report.items.find(row=>row.role==='sender'),receiver=report.items.find(row=>row.role==='receiver');
 expect(sender?.receive).toMatchObject({quantity:{value:0}});
 expect(receiver?.send).toMatchObject({quantity:{value:0}});
});

it('replays an actual Decode step, including a custom timing formula and fixed zero override',async()=>{
 const project=makeNativeCollectiveProject(c01Project()),scenario=project.scenarios[0]!,model=project.assetSnapshots.find(asset=>asset.definition.kind==='model');
 if(scenario.workload.kind!=='decode'||model?.definition.kind!=='model')throw Error('Missing Decode fixture');
 scenario.workload.steps=2;
 const node=model.definition.graph.nodes.find(node=>node.body.kind==='collective');
 if(node?.body.kind!=='collective')throw Error('Missing native node');
 node.body.communication.timing={kind:'custom_formula',seconds:{kind:'literal',quantity:{value:.012,unit:'second'}},description:'Authored transfer formula'};
 const fixed=await request(project,'seconds',1),report=await replayCommunicationCostSource(fixed);
 expect(report.request.stepContext?.index).toBe(1);
 expect(report.timingFormula?.quantity).toEqual({value:.012,unit:'second'});
 await expect(replayCommunicationCostSource({...fixed,scenario,stepContext:undefined})).rejects.toThrow('实际 Decode 步骤');
 scenario.numericOverrides=[{target:{kind:'node',nodeId:node.nodeId},field:'fixed_seconds',value:{value:0,unit:'second'}}];
 const overridden=await replayCommunicationCostSource(await request(project,'seconds',1));
 expect(overridden.timing).toEqual({kind:'fixed',seconds:0});
 expect(overridden.network.overrides[0]?.before.kind).toBe('custom_formula');
 expect(overridden.timingFormula).toBeUndefined();
});

it('rejects invalid pages and stale worker replies',async()=>{
 const fixed=await request(makeSerialGatherProject(c01Project()));
 const report=await replayCommunicationCostSource(fixed),task={taskId:'comm',phase:'communication_cost_source',request:fixed};
 const reply={taskId:'comm',phase:task.phase,status:'available',report};
 expect(readCommunicationSourceReply(reply,task).status).toBe('available');
 expect(()=>readCommunicationSourceReply({...reply,taskId:'other'},task)).toThrow('任务身份');
 expect(()=>readCommunicationSourceReply({...reply,report:{...report,items:Array(21).fill(report.items[0])}},task)).toThrow('分页');
 await expect(replayCommunicationCostSource({...fixed,page:1})).rejects.toThrow('页不存在');
});
