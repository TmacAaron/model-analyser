import {expect,it} from 'vitest';
import {AssetDocument,DeviceId,NodeId,type ProjectDocument} from '@model-analyser/contracts';
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
  selector:{index:row.index,scope:cost.scope,field,...(row.origin?{nativeNodeId:row.origin.nodeId}:{})},metric,
  ...(frame.stepContext?{stepContext:frame.stepContext,...(actualStep?{decodeFrame:true as const}:{})}:{})};
}

it('connects the configured gather formula to real M/N values and the transfer and startup arithmetic',async()=>{
 const fixed=await request(makeSerialGatherProject(c01Project())),report=await replayCommunicationCostSource(fixed);
 expect(report.declaration).toEqual({kind:'plan',index:0});
 expect(report.uniformMessages?.send).toMatchObject({quantity:{value:32,unit:'byte'},proof:{definition:{expression:'rows * cols'},bindings:[{name:'rows',quantity:{value:4}},{name:'cols',quantity:{value:8}}]}});
 expect(report.summary.groupSend).toMatchObject({quantity:{value:64,unit:'byte'}});
 expect(report.timing).toEqual({kind:'bandwidth_latency',maxTraffic:32,bytePerSecond:1000,rounds:1,latencySeconds:.001,transfer:.032,startup:.001,seconds:.033});
 expect(report.schemaVersion).toBe(1);
 expect(report).not.toHaveProperty('parameterBindings');
 expect(await verifyCommunicationCostSourceReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
 const tampered=structuredClone(report);
 tampered.network.effective={kind:'bandwidth_latency',bytePerSecond:2000,latencySeconds:.001};
 await expect(verifyCommunicationCostSourceReport(tampered)).rejects.toThrow('固定输入复算不同');
 await expect(replayCommunicationCostSource({...fixed,selector:{...fixed.selector,index:99}})).rejects.toThrow('通信序号');
});

it('binds a plan message to the winning root parameter when the workload has the same name and value',async()=>{
 const project=makeSerialGatherProject(c01Project()),scenario=project.scenarios[0]!,model=project.assetSnapshots.find(asset=>asset.assetId===scenario.model.assetId);
 if(!model||scenario.workload.kind!=='decode')throw Error('Missing plan communication fixture');
 scenario.workload.contextTokensPerRequest=4;
 model.parameters.push({key:'contextTokensPerRequest',name:'Shadowed context',type:'integer',unit:'count',default:{kind:'integer',value:4}});
 scenario.numericOverrides=[{target:{kind:'scenario',scenarioId:scenario.scenarioId},field:'parameter',parameterKey:'contextTokensPerRequest',value:{value:4,unit:'count'}}];
 const payload=scenario.parallelPlan.communications[0]!.sendBytesPerMember;
 if(payload.kind!=='formula')throw Error('Missing declared message formula');
 payload.call.bindings['rows']={kind:'symbol',name:'contextTokensPerRequest'};
 const fixed={...await request(project,'sendBytesPerMember'),proofVersion:2 as const},report=await replayCommunicationCostSource(fixed);
 const graph=report.parameterBindings!;
 expect(report).toMatchObject({schemaVersion:2,uniformMessages:{send:{quantity:{value:32,unit:'byte'}}}});
 expect(graph).toMatchObject({scope:'actual_communication_parameter_context',complete:true});
 const root=graph.roots.find(row=>row.name==='contextTokensPerRequest'&&row.target==='每成员发送量');
 const parameter=graph.nodes.find(row=>row.id===root?.nodeId);
 expect(root?.frameId).toEqual(JSON.stringify(['asset','$model']));
 expect(parameter).toMatchObject({kind:'parameter',unit:'count',value:{value:4},source:{kind:'scenario_override'}});
 const winner=graph.candidates.find(row=>row.parameterKey===root?.name&&row.status==='winning');
 expect(winner).toMatchObject({kind:'override',overrideIndex:0,nodeId:parameter?.inputs[0]});
 expect(graph.candidates).toContainEqual(expect.objectContaining({parameterKey:root?.name,kind:'default',status:'superseded'}));
 expect(await verifyCommunicationCostSourceReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
 const tampered=structuredClone(report);tampered.parameterBindings!.roots.find(row=>row.name==='contextTokensPerRequest')!.frameId='["workload"]';
 await expect(verifyCommunicationCostSourceReport(tampered)).rejects.toThrow('固定输入复算不同');
 const task={taskId:'proof-v2',phase:'communication_cost_source',request:fixed},reply={taskId:task.taskId,phase:task.phase,status:'available',report};
 expect(readCommunicationSourceReply(reply,task)).toEqual(reply);
 expect(()=>readCommunicationSourceReply({...reply,report:{...report,parameterBindings:undefined}},task)).toThrow('参数链');
});

it('opens a nonuniform Decode message using the selected step diagnostics and workload operand',async()=>{
 const project=makeSerialGatherProject(c01Project()),scenario=project.scenarios[0]!,communication=scenario.parallelPlan.communications[0]!;
 if(scenario.workload.kind!=='decode'||communication.sendBytesPerMember.kind!=='formula')throw Error('Missing Decode fixture');
 scenario.workload={...scenario.workload,contextTokensPerRequest:2,queryTokensPerRequest:1,steps:3};
 const dynamic=structuredClone(communication.sendBytesPerMember);
 dynamic.call.bindings['rows']={kind:'symbol',name:'contextTokensPerRequest'};
 communication.perDevicePayloads=scenario.deviceTopology.devices.map((device,index)=>({deviceId:device.deviceId,
  sendBytes:index?{kind:'literal',quantity:{value:48,unit:'byte'}}:dynamic,
  receiveBytes:{kind:'literal',quantity:{value:16,unit:'byte'}},trafficFactor:1,
 }));
 const fixed={...await request(project,'sendBytesPerMember',2),proofVersion:2 as const};
 const report=await replayCommunicationCostSource(fixed),graph=report.parameterBindings!;
 expect(report.metric).toEqual(fixed.metric);
 expect(report.metric.status).toBe('unavailable');
 expect(report.diagnostics).toContainEqual(expect.objectContaining({code:'nonuniform_member_quantity',diagnosticId:expect.stringMatching(/^decode-step-2::/)}));
 expect(report.summary.groupSend).toMatchObject({quantity:{value:80,unit:'byte'}});
 const root=graph.roots.find(row=>row.name==='contextTokensPerRequest');
 expect(root).toMatchObject({frameId:'["workload"]',target:'gpu0 发送量'});
 expect(graph.nodes.find(node=>node.id===root?.nodeId)).toMatchObject({kind:'workload',value:{value:4},unit:'count'});
 expect(await verifyCommunicationCostSourceReport(report)).toEqual(report);
 await expect(replayCommunicationCostSource({...fixed,decodeFrame:undefined})).rejects.toThrow('诊断不同');
});

it('binds only the displayed devices on later pages while preserving the whole group',async()=>{
 const project=makeSerialGatherProject(c01Project()),scenario=project.scenarios[0]!,communication=scenario.parallelPlan.communications[0]!;
 const hardware=scenario.deviceTopology.devices[0]!.hardware;
 const members=Array.from({length:21},(_,i)=>DeviceId.parse('gpu'+i));
 scenario.deviceTopology={
  devices:members.map(deviceId=>({deviceId,hardware})),
  groups:[{groupId:'tp',members,mesh:{axes:[{axisId:'tp',size:21}],coordinates:members.map((deviceId,index)=>({deviceId,coordinates:[index]}))}}],
 };
 scenario.bindings=[...scenario.bindings.filter(item=>item.parameterKey!=='N'),{parameterKey:'N',value:{kind:'integer',value:42}}];
 communication.perDevicePayloads=members.map((deviceId,index)=>({deviceId,trafficFactor:1,
  sendBytes:index===20?communication.sendBytesPerMember:{kind:'literal',quantity:{value:1,unit:'byte'}},
  receiveBytes:{kind:'literal',quantity:{value:16,unit:'byte'}},
 }));
 const fixed={...await request(project,'groupSendBytes'),proofVersion:2 as const};
 const first=await replayCommunicationCostSource(fixed);
 const last=await replayCommunicationCostSource({...fixed,page:1});
 expect(first.items).toHaveLength(20);
 expect(first.parameterBindings?.roots).toEqual([]);
 expect(last.items).toMatchObject([{deviceId:'gpu20',sendSum:{before:20,after:188},send:{quantity:{value:168}}}]);
 expect(last.summary.groupSend).toMatchObject({quantity:{value:188,unit:'byte'}});
 expect(last.parameterBindings?.roots).toEqual([
  expect.objectContaining({name:'M',target:'gpu20 发送量'}),
  expect.objectContaining({name:'N',target:'gpu20 发送量'}),
 ]);
 expect(await verifyCommunicationCostSourceReport(last)).toEqual(last);
 await expect(replayCommunicationCostSource({...fixed,page:2})).rejects.toThrow('页不存在');
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
 const formula=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'example:formula:network-seconds',revision:1,name:'Network seconds',parameters:[],tags:[],sources:[],definition:{kind:'formula',formula:{
  inputs:{m:{unit:'count',integerRequired:true}},expression:'m * 0.003',output:{unit:'second',integerRequired:false,nonNegative:true},description:'Independent synthetic time from row count',
 }}});
 project.assetSnapshots.push(formula);
 node.body.communication.timing={kind:'custom_formula',seconds:{kind:'formula',call:{
  formula:{assetId:formula.assetId,revision:1,kind:'formula'},bindings:{m:{kind:'symbol',name:'M'}},
 }},description:'Authored transfer formula'};
 const fixed={...await request(project,'seconds',1),proofVersion:2 as const},report=await replayCommunicationCostSource(fixed);
 expect(report.request.stepContext?.index).toBe(1);
 expect(report.timingFormula?.quantity).toEqual({value:.012,unit:'second'});
 expect(report.parameterBindings?.roots).toContainEqual(expect.objectContaining({name:'M',target:'自定义网络耗时',frameId:'["asset","$model"]'}));
 await expect(replayCommunicationCostSource({...fixed,scenario,stepContext:undefined})).rejects.toThrow('实际 Decode 步骤');
 scenario.numericOverrides=[{target:{kind:'node',nodeId:node.nodeId},field:'fixed_seconds',value:{value:0,unit:'second'}}];
 const overridden=await replayCommunicationCostSource({...await request(project,'seconds',1),proofVersion:2});
 expect(overridden.timing).toEqual({kind:'fixed',seconds:0});
 expect(overridden.network.overrides[0]?.before.kind).toBe('custom_formula');
 expect(overridden.timingFormula).toBeUndefined();
 expect(overridden.parameterBindings?.roots.some(root=>root.target==='自定义网络耗时')).toBe(false);
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
