import type {FusionCostSourceReport,FusionCostSourceRequest} from '@model-analyser/core';
import {canonical} from '../../../packages/contracts/src/validation.js';

export type FusionSourceTask={taskId:string;phase:'fusion_cost_source';request:FusionCostSourceRequest};
export type FusionSourceReply={taskId:string;phase:FusionSourceTask['phase']}&(
 {status:'available';report:FusionCostSourceReport}|{status:'error';message:string}
);
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function readFusionSourceReply(value:unknown,task:Omit<FusionSourceTask,'phase'>&{phase:string}):FusionSourceReply{
 if(!object(value)||value['taskId']!==task.taskId||value['phase']!==task.phase)throw Error('融合来源回复的任务身份有误');
 if(value['status']==='error'&&typeof value['message']==='string')return value as FusionSourceReply;
 const report=value['report'],request=task.request,page=request.page??0;
 if(value['status']!=='available'||!object(report)||report['schemaVersion']!==(request.proofVersion??1)||report['kind']!=='fusion_cost_source'||report['inputHash']!==request.inputHash||report['engineVersion']!==request.engineVersion||report['page']!==page||canonical(report['selector'])!==canonical(request.selector)||canonical(report['metric'])!==canonical(request.metric))throw Error('融合来源回复与当前固定输入或指标不同');
 const count=report['componentCount'],dag=report['dag'];
 if(report['pageSize']!==20||typeof count!=='number'||!Number.isSafeInteger(count)||count<page*20||!Array.isArray(report['items'])||report['items'].length!==Math.min(20,count-page*20))throw Error('融合来源回复超过分页范围');
 if(dag!==undefined&&(!object(dag)||!Array.isArray(dag['nodes'])||dag['nodes'].length>256||!Array.isArray(dag['guards'])||dag['guards'].length>256))throw Error('融合 Roofline 来源回复超过记录范围');
 if(request.proofVersion===2){
  if(report['overrideFormula']!==undefined){
   const graph=report['parameterBindings'];
   if(!object(graph)||graph['schemaVersion']!==1||graph['scope']!=='actual_fusion_parameter_context'||
    ['nodes','roots','candidates','boundaries'].some(key=>!Array.isArray(graph[key])||graph[key].length>(key==='boundaries'?32:256)))throw Error('实际融合参数链缺失或超过证据预算');
  }
  if(dag!==undefined){
   const operands=report['rooflineOperands'];
   if(!Array.isArray(operands)||operands.length>256||operands.some(row=>!object(row)||typeof row['timingNodeId']!=='string'||!object(row['quantity'])||
    !object(row['selector'])||canonical(row['selector']['scope'])!==canonical(request.selector.scope)||
    (row['selector']['field']!=='hbmBytes'&&row['selector']['field']!=='executedOperations')))throw Error('融合 Roofline 的上游指标与当前设备或证据范围不同');
  }
 }
 return value as FusionSourceReply;
}
