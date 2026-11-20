import type {LayoutSourceReport,LayoutSourceRequest} from '@model-analyser/core';
import {canonical} from '../../../packages/contracts/src/validation.js';

export type LayoutSourceTask={taskId:string;phase:'layout_source';request:LayoutSourceRequest};
export type LayoutSourceReply={taskId:string;phase:LayoutSourceTask['phase']}&(
 {status:'available';report:LayoutSourceReport}|{status:'error';message:string}
);
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function readLayoutSourceReply(value:unknown,task:Omit<LayoutSourceTask,'phase'>&{phase:string}):LayoutSourceReply{
 if(!object(value)||value['taskId']!==task.taskId||value['phase']!==task.phase)throw Error('布局来源回复的任务身份有误');
 if(value['status']==='error'&&typeof value['message']==='string')return value as LayoutSourceReply;
 const report=value['report'],request=task.request,page=request.page??0;
 if(value['status']!=='available'||!object(report)||report['schemaVersion']!==1||report['kind']!=='layout_source'||report['inputHash']!==request.inputHash||report['engineVersion']!==request.engineVersion||report['page']!==page||canonical(report['selector'])!==canonical(request.selector))throw Error('布局来源回复与当前固定输入或设备不同');
 const count=report['componentCount'];
 if(report['pageSize']!==20||typeof count!=='number'||!Number.isSafeInteger(count)||count<page*20||!Array.isArray(report['items'])||report['items'].length!==Math.min(20,count-page*20))throw Error('布局来源回复超过分页范围');
 return value as LayoutSourceReply;
}
