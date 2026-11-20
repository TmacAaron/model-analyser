import type {LogicalWorkSourceReport,LogicalWorkSourceRequest} from '@model-analyser/core';
import {canonical} from '../../../packages/contracts/src/validation.js';

export type LogicalWorkSourceTask={taskId:string;phase:'logical_work_source';request:LogicalWorkSourceRequest};
export type LogicalWorkSourceReply={taskId:string;phase:LogicalWorkSourceTask['phase']}&(
 {status:'available';report:LogicalWorkSourceReport}|{status:'error';message:string}
);
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function readLogicalWorkSourceReply(value:unknown,task:Omit<LogicalWorkSourceTask,'phase'>&{phase:string}):LogicalWorkSourceReply{
 if(!object(value)||value['taskId']!==task.taskId||value['phase']!==task.phase)throw Error('逻辑来源回复的任务身份有误');
 if(value['status']==='error'&&typeof value['message']==='string')return value as LogicalWorkSourceReply;
 const report=value['report'],request=task.request,page=request.page??0;
 if(value['status']!=='available'||!object(report)||report['schemaVersion']!==(request.proofVersion??1)||report['kind']!=='logical_work_source'||report['inputHash']!==request.inputHash||report['engineVersion']!==request.engineVersion||report['page']!==page||canonical(report['selector'])!==canonical(request.selector)||canonical(report['metric'])!==canonical(request.metric))throw Error('逻辑来源回复与当前固定输入或指标不同');
 const count=report['componentCount'];
 if(report['pageSize']!==20||typeof count!=='number'||!Number.isSafeInteger(count)||count<page*20||!Array.isArray(report['items'])||report['items'].length!==Math.min(20,count-page*20))throw Error('逻辑来源回复超过分页范围');
 const bindings=report['parameterBindings'];
 if(request.proofVersion===2&&report['operation']==='segment_sum'&&(!object(bindings)||bindings['schemaVersion']!==1||bindings['scope']!=='actual_logical_parameter_context'||typeof bindings['complete']!=='boolean'))throw Error('逻辑来源回复缺少实际公式的参数证据');
 if(bindings!==undefined&&(!object(bindings)||!Array.isArray(bindings['nodes'])||bindings['nodes'].length>256||!Array.isArray(bindings['roots'])||bindings['roots'].length>256||!Array.isArray(bindings['candidates'])||bindings['candidates'].length>256))throw Error('逻辑来源回复超过参数证据预算');
 return value as LogicalWorkSourceReply;
}
