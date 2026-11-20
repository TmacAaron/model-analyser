import type {AggregateCostSourceReport,AggregateCostSourceRequest} from '@model-analyser/core';
import {canonical} from '../../../packages/contracts/src/validation.js';

export type AggregateSourceTask={taskId:string;phase:'aggregate_cost_source';request:AggregateCostSourceRequest};
export type AggregateSourceReply={taskId:string;phase:AggregateSourceTask['phase']}&(
 {status:'available';report:AggregateCostSourceReport}|{status:'error';message:string}
);

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function readAggregateSourceReply(value:unknown,task:Omit<AggregateSourceTask,'phase'>&{phase:string}):AggregateSourceReply{
 if(!object(value)||value['taskId']!==task.taskId||value['phase']!==task.phase)throw Error('聚合来源回复的任务身份有误');
 if(value['status']==='error'&&typeof value['message']==='string')return value as AggregateSourceReply;
 const report=value['report'],request=task.request;
 if(value['status']!=='available'||!object(report)||report['kind']!=='aggregate_cost_source'||report['inputHash']!==request.inputHash||report['engineVersion']!==request.engineVersion||report['page']!==(request.page??0)||canonical(report['selector'])!==canonical(request.selector)||canonical(report['metric'])!==canonical(request.metric))throw Error('聚合来源回复与当前固定输入或指标不同');
 if(report['pageSize']!==20||typeof report['componentCount']!=='number'||!Number.isSafeInteger(report['componentCount'])||report['componentCount']<0||!Array.isArray(report['items'])||report['items'].length>20)throw Error('聚合来源回复超过分页范围');
 const operation=String(report['operation']);
 const version=['device_sum','device_max','node_stream_span'].includes(operation)?2:
  ['ordered_sum','serial_barriers','stream_makespan','module_stream_span'].includes(operation)?1:undefined;
 if(version===undefined||report['schemaVersion']!==version)throw Error('聚合来源回复的版本或运算类型有误');
 if(version===2){
  const {target,deviceIds}=request.selector.scope,compute=!!request.selector.computeClass;
  if(target.kind!=='node'||report['items'].some(item=>!object(item)||item['kind']!=='device'||canonical(item['target'])!==canonical(target)||
     !Array.isArray(item['deviceIds'])||item['deviceIds'].length!==1||!deviceIds.includes(item['deviceIds'][0])||
     (compute&&(typeof item['computeIndex']!=='number'||!Number.isSafeInteger(item['computeIndex'])||item['computeIndex']<0))))
   throw Error('聚合来源回复的设备或计算段身份有误');
 }
 return value as AggregateSourceReply;
}
