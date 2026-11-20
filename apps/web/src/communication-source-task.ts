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
 const report=value['report'],request=task.request;
 if(value['status']!=='available'||!object(report)||report['schemaVersion']!==1||report['kind']!=='communication_cost_source'||report['inputHash']!==request.inputHash||report['engineVersion']!==request.engineVersion||report['page']!==(request.page??0)||canonical(report['selector'])!==canonical(request.selector)||canonical(report['metric'])!==canonical(request.metric))throw Error('通信来源回复与当前固定输入或指标不同');
 if(report['pageSize']!==20||typeof report['componentCount']!=='number'||!Number.isSafeInteger(report['componentCount'])||report['componentCount']<1||!Array.isArray(report['items'])||report['items'].length>20||!object(report['network'])||!Array.isArray(report['network']['overrides'])||report['network']['overrides'].length>2)throw Error('通信来源回复超过分页范围');
 return value as CommunicationSourceReply;
}
