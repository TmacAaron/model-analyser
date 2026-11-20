import type {LocalCostSourceReport,LocalCostSourceRequest} from '@model-analyser/core';
import {canonical} from '../../../packages/contracts/src/validation.js';

export type LocalSourceTask={taskId:string;phase:'local_cost_source';request:LocalCostSourceRequest};
export type LocalSourceReply={taskId:string;phase:LocalSourceTask['phase']}&(
 {status:'available';report:LocalCostSourceReport}|{status:'error';message:string}
);
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function readLocalSourceReply(value:unknown,task:Omit<LocalSourceTask,'phase'>&{phase:string}):LocalSourceReply{
 if(!object(value)||value['taskId']!==task.taskId||value['phase']!==task.phase)throw Error('局部成本来源回复的任务身份有误');
 if(value['status']==='error'&&typeof value['message']==='string')return value as LocalSourceReply;
 const report=value['report'],request=task.request,page=request.page??0;
 if(value['status']!=='available'||!object(report)||report['schemaVersion']!==1||report['kind']!=='local_cost_source'||report['inputHash']!==request.inputHash||report['engineVersion']!==request.engineVersion||report['page']!==page||canonical(report['selector'])!==canonical(request.selector)||canonical(report['metric'])!==canonical(request.metric))throw Error('局部成本来源回复与当前固定输入或指标不同');
 const count=report['componentCount'];
 if(report['pageSize']!==20||typeof count!=='number'||!Number.isSafeInteger(count)||count<page*20||!Array.isArray(report['items'])||report['items'].length!==Math.min(20,count-page*20)||!Array.isArray(report['timingOverrides'])||report['timingOverrides'].length>2)throw Error('局部成本来源回复超过分页范围');
 const dag=report['dag'];
 if(dag!==undefined&&(!object(dag)||!Array.isArray(dag['nodes'])||dag['nodes'].length>256||!Array.isArray(dag['guards'])||dag['guards'].length>256))throw Error('局部 Roofline 来源回复超过记录范围');
 return value as LocalSourceReply;
}
