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
 if(value['status']!=='available'||!object(report)||report['schemaVersion']!==1||report['kind']!=='aggregate_cost_source'||report['inputHash']!==request.inputHash||report['engineVersion']!==request.engineVersion||report['page']!==(request.page??0)||canonical(report['selector'])!==canonical(request.selector)||canonical(report['metric'])!==canonical(request.metric))throw Error('聚合来源回复与当前固定输入或指标不同');
 if(report['pageSize']!==20||typeof report['componentCount']!=='number'||!Number.isSafeInteger(report['componentCount'])||report['componentCount']<0||!Array.isArray(report['items'])||report['items'].length>20)throw Error('聚合来源回复超过分页范围');
 if(!['ordered_sum','serial_barriers','stream_makespan','module_stream_span'].includes(String(report['operation'])))throw Error('聚合来源回复的运算类型有误');
 return value as AggregateSourceReply;
}
