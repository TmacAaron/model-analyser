import type {CommunicationCostSourceReport,CommunicationCostSourceRequest} from '@model-analyser/core';
import {canonical} from '../../../packages/contracts/src/validation.js';

export type CommunicationSourceTask={taskId:string;phase:'communication_cost_source';request:CommunicationCostSourceRequest};
export type CommunicationSourceReply={taskId:string;phase:CommunicationSourceTask['phase']}&(
 {status:'available';report:CommunicationCostSourceReport}|{status:'error';message:string}
);
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function readCommunicationSourceReply(value:unknown,task:Omit<CommunicationSourceTask,'phase'>&{phase:string}):CommunicationSourceReply{
 if(!object(value)||value['taskId']!==task.taskId||value['phase']!==task.phase)throw Error('通信来源回复的任务身份有误');
 if(value['status']==='error'&&typeof value['message']==='string')return value as CommunicationSourceReply;
 const report=value['report'],request=task.request,page=request.page??0;
 if(value['status']!=='available'||!object(report)||report['schemaVersion']!==(request.proofVersion??1)||report['kind']!=='communication_cost_source'||report['inputHash']!==request.inputHash||report['engineVersion']!==request.engineVersion||report['page']!==page||canonical(report['selector'])!==canonical(request.selector)||canonical(report['metric'])!==canonical(request.metric))throw Error('通信来源回复与当前固定输入或指标不同');
 const count=report['componentCount'],items=report['items'];
 if(report['pageSize']!==20||typeof count!=='number'||!Number.isSafeInteger(count)||count<=page*20||!Array.isArray(items)||items.length!==Math.min(20,count-page*20)||!object(report['network'])||!Array.isArray(report['network']['overrides'])||report['network']['overrides'].length>2)throw Error('通信来源回复超过分页范围');
 const bindings=report['parameterBindings'];
 if(request.proofVersion!==undefined&&(!object(bindings)||bindings['schemaVersion']!==1||bindings['scope']!=='actual_communication_parameter_context'||!Array.isArray(bindings['nodes'])||bindings['nodes'].length>256||!Array.isArray(bindings['roots'])||bindings['roots'].length>256||!Array.isArray(bindings['candidates'])||bindings['candidates'].length>256||!Array.isArray(bindings['boundaries'])||bindings['boundaries'].length>32))throw Error('通信来源回复缺少参数链或超过证据预算');
 if(request.proofVersion===3||request.proofVersion===4){
  const layouts=report['endpointLayouts'],endpoints=report['endpoints'];
  if(!object(layouts)||!object(endpoints)||!Array.isArray(layouts['devices'])||layouts['devices'].length!==items.length||!object(layouts['payloadDtype']))throw Error('通信来源回复缺少本页端点布局');
  const devices=layouts['devices'];
  for(const side of ['source','destination'] as const){
   const endpoint=layouts[side];
   if(!object(endpoint)||endpoint['tensorId']!==endpoints[side]||!Array.isArray(endpoint['globalShape'])||endpoint['globalShape'].length>32||
    !Array.isArray(endpoint['operations'])||endpoint['operations'].length<1||endpoint['operations'].length>2)throw Error('通信来源回复的端点布局与张量或证据范围不同');
   for(const [index,item] of items.entries()){
    const row=devices[index];
    if(!object(item)||!object(row)||row['deviceId']!==item['deviceId']||!request.selector.scope.deviceIds.includes(row['deviceId'] as typeof request.selector.scope.deviceIds[number]))throw Error('通信端点布局的设备与本页消息不同');
    const placement=row[side],role=item['role'];
    const participates=report['operation']!=='send_recv'||role===(side==='source'?'sender':'receiver');
    if(participates?(!object(placement)||placement['deviceId']!==row['deviceId']||!Array.isArray(placement['operations'])||placement['operations'].length<2||placement['operations'].length>34):placement!==undefined)throw Error('通信端点布局的分片记录与设备角色不同');
   }
  }
 }
 if(request.proofVersion===4){
  const storage=report['storageEvidence'],storagePage=request.storagePage??0;
  if(!object(storage)||storage['page']!==storagePage||storage['pageSize']!==20||!object(storage['source'])||!object(storage['destination']))throw Error('通信来源回复缺少当前存储页');
  const storageIds=storage['storageIds'],devices=storage['devices'],storageCount=storage['componentCount'];
  if(typeof storageCount!=='number'||!Number.isSafeInteger(storageCount)||storageCount<=storagePage*20||!Array.isArray(storageIds)||
     storageIds.length!==Math.min(20,storageCount-storagePage*20)||new Set(storageIds).size!==storageIds.length||storageIds.some(id=>typeof id!=='string')||
     !Array.isArray(devices)||devices.length!==items.length)throw Error('通信存储来源回复超过分页范围');
  for(const [index,item] of items.entries()){
   const row=devices[index];
   if(!object(item)||!object(row)||row['deviceId']!==item['deviceId']||!Array.isArray(row['allocations'])||row['allocations'].length>storageIds.length)throw Error('通信存储分配的设备与本页消息不同');
   const seen=new Set<unknown>();
   for(const allocation of row['allocations']){
    if(!object(allocation)||!storageIds.includes(allocation['storageId'])||seen.has(allocation['storageId'])||
       !Array.isArray(allocation['roles'])||!allocation['roles'].length||allocation['roles'].some(role=>!['source','destination','temporary'].includes(role))||
       !['allocated','not_on_device','unassigned'].includes(String(allocation['kind'])))throw Error('通信存储分配的身份或角色有误');
    seen.add(allocation['storageId']);
   }
  }
 }
 return value as CommunicationSourceReply;
}
