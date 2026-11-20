import type {ExactLeafSourceReport,LeafCostSourceRequest} from '@model-analyser/core';
import {canonical} from '../../../packages/contracts/src/validation.js';
export type LeafSourceReply={taskId:string;phase:'exact_leaf_source'}&({status:'available';report:ExactLeafSourceReport}|{status:'error';message:string});
export type LeafSourceTask={taskId:string;phase:'exact_leaf_source';request:LeafCostSourceRequest};
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function leafSourceProofVersion(request:LeafCostSourceRequest){
 const overrides=request.scenario.numericOverrides;
 if(overrides.some(o=>o.target.kind==='node'&&o.target.nodeId===request.selector.nodeId&&o.field!=='parameter'))return 4;
 return request.scenario.quantizationOverrides.length||overrides.some(o=>o.target.kind==='storage'&&o.field==='memory_bytes')?3:2;
}
/** Trusted worker did the full replay; do not traverse the fixed assets again. */
export function readLeafSourceReply(value:unknown,task:LeafSourceTask):LeafSourceReply{
 if(!object(value)||value['taskId']!==task.taskId||value['phase']!==task.phase)throw Error('精确来源返回了错误的任务身份或阶段，请重试。');
 if(value['status']==='error'&&typeof value['message']==='string')return value as LeafSourceReply;
 const report=value['report'],request=task.request;
 if(value['status']!=='available'||!object(report)||report['schemaVersion']!==leafSourceProofVersion(request)||report['inputHash']!==request.inputHash||report['engineVersion']!==request.engineVersion||report['page']!==(request.page??0)||report['pageSize']!==20||!object(report['asset'])||typeof report['asset']['assetId']!=='string'||typeof report['asset']['revision']!=='number'||!Number.isSafeInteger(report['componentCount'])||(report['componentCount'] as number)<0||canonical(report['selector'])!==canonical(request.selector)||canonical(report['metric'])!==canonical(request.metric))throw Error('精确来源返回的指标或实际范围不匹配，请重试。');
 const bindings=report['parameterBindings'];if(!object(bindings)||bindings['schemaVersion']!==1||!Array.isArray(bindings['nodes'])||bindings['nodes'].length>256||!Array.isArray(bindings['roots'])||bindings['roots'].length>256||!Array.isArray(bindings['candidates'])||bindings['candidates'].length>256||typeof bindings['complete']!=='boolean')throw Error('参数绑定来源返回无效的有界证据。');
 if(report['kind']==='leaf_cost_source'){if(!Array.isArray(report['items'])||report['items'].length>20||!Array.isArray(report['symbols'])||typeof report['complete']!=='boolean')throw Error('精确表达式返回无效的分页。');}
 else if(report['kind']==='leaf_timing_source'){const dag=report['dag'];if(!object(dag)||!Array.isArray(dag['nodes'])||dag['nodes'].length>256||!Array.isArray(dag['guards'])||dag['guards'].length>256||!Array.isArray(report['workExpressions'])||report['workExpressions'].length>20||!object(report['coverage'])||typeof report['coverage']['completeTimingTransform']!=='boolean')throw Error('耗时来源返回无效的有界证据。');}
 else if(report['kind']!=='leaf_storage_source')throw Error('不支持的精确来源报告阶段，请重试。');
 if(report['schemaVersion']===4){
  const rows=report['timingOverrides'];
  if(!Array.isArray(rows)||rows.length>2||rows.some(o=>!object(o)||!object(o['override'])||!object(o['before'])||!object(o['after'])))throw Error('耗时覆盖来源记录无效');
 }
 if(report['kind']==='leaf_storage_source'||report['kind']==='leaf_timing_source'&&report['schemaVersion']!==2){const source=report['storageAccessSource'];if(!object(source)||!Array.isArray(source['items'])||source['items'].length>20||source['page']!==report['page']||source['pageSize']!==20||typeof source['complete']!=='boolean'||!Number.isSafeInteger(source['componentCount']))throw Error('分配访问来源返回无效的分页证据');for(const item of source['items']){if(!object(item)||!object(item['sum'])||typeof item['complete']!=='boolean')throw Error('分配访问记录无效');const storage=item['storage'];if(storage!==undefined){if(!object(storage)||!Array.isArray(storage['aliases'])||storage['aliases'].length>64||!object(storage['quantization'])||!object(storage['final'])||!Array.isArray(storage['final']['events'])||storage['final']['events'].length>256)throw Error('规范存储来源超过记录预算');for(const key of ['decisions','bindings','operations'])if(!Array.isArray(storage['quantization'][key])||storage['quantization'][key].length>1024)throw Error('量化来源超过记录预算');}}}
 return value as LeafSourceReply;
}
