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
 if(value['status']!=='available'||!object(report)||report['schemaVersion']!==(request.proofVersion??1)||report['kind']!=='local_cost_source'||report['inputHash']!==request.inputHash||report['engineVersion']!==request.engineVersion||report['page']!==page||canonical(report['selector'])!==canonical(request.selector)||canonical(report['metric'])!==canonical(request.metric))throw Error('局部成本来源回复与当前固定输入或指标不同');
 const count=report['componentCount'];
 if(report['pageSize']!==20||typeof count!=='number'||!Number.isSafeInteger(count)||count<page*20||!Array.isArray(report['items'])||report['items'].length!==Math.min(20,count-page*20)||!Array.isArray(report['timingOverrides'])||report['timingOverrides'].length>2)throw Error('局部成本来源回复超过分页范围');
 const dag=report['dag'];
 if(dag!==undefined&&(!object(dag)||!Array.isArray(dag['nodes'])||dag['nodes'].length>256||!Array.isArray(dag['guards'])||dag['guards'].length>256))throw Error('局部 Roofline 来源回复超过记录范围');
 if(request.proofVersion!==undefined){
  const operands=report['expressionOperands'],bindings=report['parameterBindings'];
  if(typeof report['expressionOperandsComplete']!=='boolean'||!Array.isArray(operands)||operands.length>256||operands.some(row=>
   !object(row)||typeof row['name']!=='string'||typeof row['label']!=='string'||!object(row['source'])||
   !object(row['quantity'])||typeof row['quantity']['unit']!=='string'||!Number.isFinite(row['quantity']['value'])||
   (row['source']['kind']!=='parameter'&&(row['source']['kind']!=='physical'||!object(row['source']['layout'])||row['source']['layout']['deviceId']!==request.selector.deviceId))))throw Error('逐卡实参回复与当前设备或记录范围不同');
  if(!object(bindings)||bindings['schemaVersion']!==1||bindings['scope']!=='actual_local_parameter_context'||
   ['nodes','roots','candidates','boundaries'].some(key=>!Array.isArray(bindings[key])||bindings[key].length>(key==='boundaries'?32:256)))throw Error('逐卡参数链回复缺失或超过证据预算');
 }
 if(request.proofVersion===3){
  const operands=report['rooflineOperands'],timing=report['timing'];
  if(!object(timing)||timing['kind']!=='roofline_bound'){
   if(dag!==undefined||operands!==undefined)throw Error('逐卡 Roofline 实参与当前耗时策略不同');
   return value as LocalSourceReply;
  }
  if(!object(dag)||!Array.isArray(dag['nodes']))throw Error('逐卡 Roofline 缺少实际耗时记录');
  const boundaries=dag['nodes'].flatMap((node:unknown)=>{
   if(!object(node))return [];
   const source=node['source'];
   return object(source)&&source['kind']==='metric_boundary'?[{node,source}]:[];
  });
  const scope=canonical(request.selector.scope);
  if(!Array.isArray(operands)||operands.length!==boundaries.length||operands.some((row,i)=>{
   const boundary=boundaries[i];if(!boundary)return true;
   const {node,source}=boundary;
   if(!object(row)||row['timingNodeId']!==node['id']||!object(row['quantity'])||!object(row['selector']))return true;
   const selector=row['selector'],quantity=row['quantity'],hbm=source['field']==='hbmBytes';
   return selector['nodeId']!==request.selector.nodeId||selector['deviceId']!==request.selector.deviceId||selector['fusionNodeId']!==request.selector.fusionNodeId||
    canonical(selector['scope'])!==scope||quantity['unit']!==node['unit']||!Number.isFinite(quantity['value'])||
    quantity['value']!==(node['value']==='negative_zero'?0:node['value'])||selector['field']!==(hbm?'hbmBytes':'executedOperations')||
    (!hbm&&(selector['computeIndex']!==source['evaluationIndex']||typeof row['segmentId']!=='string'||
     source['field']!==`compute[${JSON.stringify(row['segmentId'])}].executedOperations`));
  }))throw Error('逐卡 Roofline 实参与当前设备的原运算不同');
 }
 return value as LocalSourceReply;
}
