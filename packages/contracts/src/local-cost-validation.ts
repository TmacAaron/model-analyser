import type { ParallelResolution,Diagnostic,MetricValue,CostResult } from './index.js';
import { canonical } from './validation.js';
export function validateLocalCosts(result:ParallelResolution):Diagnostic[]{
  const issues:Diagnostic[]=[],diagnostics=new Map(result.diagnostics.map(d=>[d.diagnosticId,d]));
  function report(message:string,path:string){issues.push({diagnosticId:'local-cost-validation-'+issues.length,severity:'error',code:'invalid_local_cost_result',message,location:{kind:'scenario',scenarioId:result.scenarioId,fieldPath:path}});}
  const unique=(ids:string[],path:string)=>{if(new Set(ids).size!==ids.length)report('局部结果标识重复',path);};
  const linked=(ids:string[],path:string)=>{if(!ids.some(id=>diagnostics.get(id)?.severity==='error'))report('局部缺项必须关联错误诊断',path);};
  const close=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1,Math.abs(a),Math.abs(b))*1e-12;
  function sum(target:MetricValue,values:MetricValue[],path:string){if(values.some(v=>v.status==='unavailable')){if(target.status==='available')report('缺项不得混入完整已知成本合计',path);return;}const total=values.reduce((n,v)=>n+(v.status==='available'?v.quantity.value:0),0);if(!Number.isFinite(total)){if(target.status==='available')report('溢出合计不能报告为可用',path);return;}if(target.status!=='available'||!close(target.quantity.value,total))report('局部成本合计与叶节点不符',path);}
  function scope(cost:CostResult,nodeId:string|undefined,deviceId:string,path:string){const target=cost.scope.target;if(cost.scope.phase!==result.phase||cost.scope.aggregation!=='per_device'||cost.scope.deviceIds.length!==1||cost.scope.deviceIds[0]!==deviceId||(nodeId===undefined?target.kind!=='model':target.kind!=='node'||target.nodeId!==nodeId))report('局部成本范围与节点/设备/阶段不符',path);
    if(cost.communications.length)report('局部叶节点合计不能暗中混入网络通信',path);for(const c of cost.compute)if(c.usefulOperations.status==='available'&&c.executedOperations.status==='available'&&c.executedOperations.quantity.value<c.usefulOperations.quantity.value)report('执行工作量不能少于有效工作量',path+'.compute');
  }
  const available=new Map<string,{nodeId:string;cost:CostResult}[]>(),missing=new Map<string,string[]>();
  unique(result.localCosts.nodes.map(n=>n.nodeId),'localCosts.nodes');unique(result.localCosts.deviceSubtotals.map(d=>d.deviceId),'localCosts.deviceSubtotals');
  for(const [index,node] of result.localCosts.nodes.entries()){const path='localCosts.nodes.'+index,p=node.placement;if(p.kind==='no_work')continue;if(p.kind==='unplaced'){linked(p.diagnosticIds,path);continue;}unique(p.perDevice.map(d=>d.deviceId),path+'.perDevice');
    for(const d of p.perDevice){if(d.outcome.status==='unavailable'){linked(d.outcome.diagnosticIds,path);missing.set(d.deviceId,[...(missing.get(d.deviceId)??[]),node.nodeId]);continue;}
      const o=d.outcome;scope(o.cost,node.nodeId,d.deviceId,path);unique(o.bindings.map(b=>b.symbol),path+'.bindings');available.set(d.deviceId,[...(available.get(d.deviceId)??[]),{nodeId:node.nodeId,cost:o.cost}]);
      for(const b of o.bindings){const source=b.source;let expected:number|undefined;
        if(source.kind==='storage_bytes'){const s=result.storageAllocations.find(s=>s.storageId===source.storageId||s.aliasIds.includes(source.storageId)),local=s?.allocation.perDevice.find(p=>p.deviceId===d.deviceId),value=source.basis==='per_copy'?local?.allocation.totalBytes:local?.totalBytes;if(value?.status==='available')expected=value.quantity.value;}
        else {const local=result.tensorLayouts.find(t=>t.nodeId===node.nodeId&&t.tensorId===source.tensorId)?.partition.placements.find(p=>p.deviceId===d.deviceId);if(local){if(source.kind==='tensor_slice')expected=local.slices.find(s=>s.axisId===source.axisId)?.[source.edge];else if(source.kind==='tensor_copies')expected=local.copies;else if(source.kind==='tensor_elements')expected=source.basis==='logical'?local.logicalElements:local.allocatedElements;else {const axis=(source.basis==='logical'?local.logicalShape:local.allocatedShape).find(a=>a.axisId===source.axisId);if(axis?.size.kind==='literal'&&axis.size.quantity.unit==='count')expected=axis.size.quantity.value;}}}
        if(expected===undefined||b.quantity.unit!==(source.kind==='storage_bytes'?'byte':'count')||b.quantity.value!==expected||!Number.isSafeInteger(b.quantity.value))report('局部维度/存储绑定与实际布局不符',path+'.bindings.'+b.symbol);
      }
    }
  }
  for(const [index,d] of result.localCosts.deviceSubtotals.entries()){const path='localCosts.deviceSubtotals.'+index,known=available.get(d.deviceId)??[],unknown=missing.get(d.deviceId)??[];scope(d.knownLeafCost,undefined,d.deviceId,path);unique(d.knownNodeIds,path+'.knownNodeIds');unique(d.missingNodeIds,path+'.missingNodeIds');
    if(canonical([...d.knownNodeIds].sort())!==canonical(known.map(n=>n.nodeId).sort())||canonical([...d.missingNodeIds].sort())!==canonical([...unknown].sort()))report('已评估/缺项节点清单与局部结果不符',path);
    for(const key of ['logicalReadBytes','logicalWriteBytes','hbmBytes','seconds'] as const)sum(d.knownLeafCost[key],known.map(n=>n.cost[key]),path+'.'+key);
    const classes=new Map<string,CostResult['compute']>();for(const n of known)for(const c of n.cost.compute){const key=canonical(c.computeClass);classes.set(key,[...(classes.get(key)??[]),c]);}unique(d.knownLeafCost.compute.map(c=>canonical(c.computeClass)),path+'.compute');
    if(classes.size!==d.knownLeafCost.compute.length)report('合计的计算类别与叶节点不符',path+'.compute');for(const c of d.knownLeafCost.compute){const members=classes.get(canonical(c.computeClass));if(!members){report('合计包含未知计算类别',path+'.compute');continue;}sum(c.usefulOperations,members.map(c=>c.usefulOperations),path+'.compute.usefulOperations');sum(c.executedOperations,members.map(c=>c.executedOperations),path+'.compute.executedOperations');}available.delete(d.deviceId);
  }
  if(available.size)report('已评估设备缺少成本合计','localCosts.deviceSubtotals');return issues;
}
