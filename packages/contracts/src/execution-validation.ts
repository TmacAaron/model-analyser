import { theoreticalPeak } from './memory-peak-validation.js';
import type { ParallelResolution,Diagnostic,MetricValue,DeviceId,LocalNodeEvaluation } from './index.js';
import { validateStreamsExecution } from './streams-validation.js';
export function validateExecution(result:ParallelResolution):Diagnostic[]{
  if(result.execution.status==='available'&&result.execution.result.policy==='streams')return validateStreamsExecution(result);
  const issues:Diagnostic[]=[];const report=(message:string,path:string)=>issues.push({diagnosticId:'execution-validation-'+issues.length,severity:'error',code:'invalid_execution_result',message,location:{kind:'scenario',scenarioId:result.scenarioId,fieldPath:path}}),unique=(ids:string[],path:string)=>{if(new Set(ids).size!==ids.length)report('执行结果标识重复',path);};
  const close=(a:number,b:number)=>a===b||(a!==0&&b!==0&&Math.abs(a-b)<=Math.max(Math.abs(a),Math.abs(b))*1e-12),sameIds=(a:string[],b:string[])=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
  const fused=new Set(result.fusions.flatMap(f=>f.application.memberNodeIds)),executionNodes:LocalNodeEvaluation[]=[...result.localCosts.nodes.filter(n=>!fused.has(n.nodeId)),...result.fusions.map(f=>({nodeId:f.application.nodeId,placement:f.participation==='unknown'?{kind:'unplaced' as const,diagnosticIds:f.perDevice.flatMap(d=>d.outcome.status==='unavailable'?d.outcome.diagnosticIds:[])}:f.perDevice.length?{kind:'placed' as const,perDevice:f.perDevice}:{kind:'no_work' as const,description:'Fused metadata/control-only group'}}))];
  if(result.execution.status==='available'){
    if(result.execution.result.streams)report('串行基线不能携带多流资源进度','execution.streams');
    const e=result.execution.result,positions=new Map(e.orderedNodeIds.map((id,i)=>[id,i]));unique(e.orderedNodeIds,'execution.orderedNodeIds');unique(e.blockedNodeIds,'execution.blockedNodeIds');unique(e.dependencies.map(d=>JSON.stringify([d.fromNodeId,d.toNodeId])),'execution.dependencies');
    if(!sameIds(e.orderedNodeIds,[...executionNodes.map(n=>n.nodeId),...result.communications.flatMap(c=>c.evaluation.definition.placement?[c.evaluation.definition.placement.nodeId]:[])]))report('执行节点必须包含全部生效逻辑节点/融合组与已命名通信','execution.orderedNodeIds');
    if(JSON.stringify(e.steps.map(s=>s.nodeId))!==JSON.stringify(e.orderedNodeIds))report('步骤顺序与拓扑顺序不同','execution.steps');
    for(const d of e.dependencies)if(!positions.has(d.fromNodeId)||!positions.has(d.toNodeId)||(positions.get(d.fromNodeId)??0)>=(positions.get(d.toNodeId)??0))report('依赖引用缺失节点或违背拓扑顺序','execution.dependencies');
    if(e.blockedNodeIds.some(id=>!positions.has(id)))report('被阻塞节点不在执行顺序中','execution.blockedNodeIds');
    if(!sameIds(e.unplacedCommunicationIndices.map(String),result.communications.filter(c=>!c.evaluation.definition.placement).map(c=>String(c.index))))report('未定位通信清单不符','execution.unplacedCommunicationIndices');
    const expectedIntervals:typeof e.intervals=[];let clock:number|undefined=e.unplacedCommunicationIndices.length?undefined:0;
    for(const [index,s] of e.steps.entries()){
      const path='execution.steps.'+index,node=executionNodes.find(n=>n.nodeId===s.nodeId),comm=result.communications.find(c=>c.evaluation.definition.placement?.nodeId===s.nodeId),seconds=new Map<DeviceId,MetricValue>();let expectedDevices:DeviceId[]=[],duration:number|undefined,kind:typeof s.kind='compute';
      if(comm){kind='communication';expectedDevices=comm.evaluation.cost.scope.deviceIds;for(const id of expectedDevices)seconds.set(id,comm.evaluation.cost.seconds);}
      else if(node?.placement.kind==='placed'){expectedDevices=node.placement.perDevice.map(d=>d.deviceId);for(const d of node.placement.perDevice)seconds.set(d.deviceId,d.outcome.status==='available'?d.outcome.cost.seconds:d.outcome);}
      else if(node?.placement.kind==='no_work'){kind='metadata';expectedDevices=[...new Set(result.tensorLayouts.filter(t=>t.nodeId===s.nodeId).flatMap(t=>t.partition.placements.map(p=>p.deviceId)))];duration=0;}
      if(kind!=='metadata'&&seconds.size&&[...seconds.values()].every(m=>m.status==='available'))duration=Math.max(...[...seconds.values()].flatMap(m=>m.status==='available'?[m.quantity.value]:[]));
      if(s.kind!==kind||!sameIds(s.deviceIds,expectedDevices))report('步骤类型/参与设备与局部成本或通信定义不符',path);
      if(duration===undefined){if(s.duration.status==='available')report('缺项节点不能有可用屏障耗时',path+'.duration');}else if(s.duration.status!=='available'||!close(s.duration.quantity.value,duration))report('屏障耗时必须是参与设备最大值',path+'.duration');
      if(e.blockedNodeIds.includes(s.nodeId))clock=undefined;
      if(clock===undefined){if(s.startSeconds!==undefined||s.endSeconds!==undefined)report('缺项之后不能伪造绝对时刻',path);continue;}
      if(s.startSeconds===undefined||!close(s.startSeconds,clock))report('步骤开始时刻与串行前缀不同',path+'.startSeconds');
      const next=duration===undefined?undefined:clock+duration;let precise=next!==undefined&&Number.isFinite(next)&&!(duration!==undefined&&duration>0&&next===clock);const local:typeof e.intervals=[];
      if(kind==='metadata')for(const deviceId of expectedDevices)local.push({nodeId:s.nodeId,kind,deviceId,startSeconds:clock,endSeconds:clock});
      else for(const [deviceId,value] of seconds){if(value.status!=='available')continue;const end:number=clock+value.quantity.value;if(!Number.isFinite(end)||(value.quantity.value>0&&end===clock)){precise=false;continue;}local.push({nodeId:s.nodeId,kind,deviceId,startSeconds:clock,endSeconds:end});}
      if(precise&&next!==undefined){if(s.endSeconds===undefined||!close(s.endSeconds,next))report('步骤结束时刻与设备屏障不同',path+'.endSeconds');expectedIntervals.push(...local);clock=next;}else {if(s.endSeconds!==undefined)report('未知/无法表示的结束时刻不得持久化',path+'.endSeconds');if(duration===undefined)expectedIntervals.push(...local);clock=undefined;}
    }
    const complete=clock!==undefined&&!e.blockedNodeIds.length&&!e.unplacedCommunicationIndices.length;if(e.completeness!==(complete?'complete':'partial'))report('执行完整性与时序证据不符','execution.completeness');if(complete){if(e.makespan.status!=='available'||!close(e.makespan.quantity.value,clock??0))report('完整跨度与串行前缀不同','execution.makespan');}else if(e.makespan.status==='available')report('不完整执行不能报告完整跨度','execution.makespan');
    unique(e.intervals.map(i=>JSON.stringify([i.nodeId,i.deviceId])),'execution.intervals');if(e.intervals.length!==expectedIntervals.length)report('每卡区间数与已知时序不同','execution.intervals');
    for(const interval of e.intervals){const expected=expectedIntervals.find(i=>i.nodeId===interval.nodeId&&i.deviceId===interval.deviceId);if(!expected||expected.kind!==interval.kind||!close(expected.startSeconds,interval.startSeconds)||!close(expected.endSeconds,interval.endSeconds))report('每卡区间与局部耗时/同步开始时刻不同','execution.intervals');}
    const expectedMemory=e.steps.flatMap(step=>{const f=result.fusions.find(f=>f.application.nodeId===step.nodeId);return f?[...f.application.memberNodeIds,f.application.extraNodeId].map(nodeId=>({nodeId,executionNodeId:step.nodeId})):[{nodeId:step.nodeId,executionNodeId:step.nodeId,...(step.startSeconds!==undefined?{startSeconds:step.startSeconds}:{})}];});if(e.memoryOrder&&JSON.stringify(e.memoryOrder)!==JSON.stringify(expectedMemory))report('生命周期事件顺序必须按融合成员/附加事件展开；不能伪造内部时刻','execution.memoryOrder');if(result.fusions.length&&!e.memoryOrder)report('融合执行需要独立的内部生命周期顺序','execution.memoryOrder');
  }
  const memoryIds=result.memory.map(m=>m.deviceScope.kind==='per_device'?m.deviceScope.deviceId:'equivalence:'+m.deviceScope.classId);unique(memoryIds,'memory');
  for(const [index,row] of result.memory.entries()){const m=theoreticalPeak(row);if(m.peakBytes.status!=='available')continue;const path='memory.'+index;if(m.deviceScope.kind!=='per_device'){report('当前串行报告显存必须逐物理设备','memory');continue;}const deviceId=m.deviceScope.deviceId,e=result.execution.status==='available'?result.execution.result:undefined;
    if(!e||e.blockedNodeIds.length||e.unplacedCommunicationIndices.length||result.unassignedStorageIds.length||result.localCosts.nodes.some(n=>n.placement.kind==='unplaced'))report('执行/分配存在缺项不能声明完整显存峰值',path);
    unique(m.categoryBreakdown.map(c=>c.category),path+'.categoryBreakdown');const categories=new Map<string,number>();for(const c of m.categoryBreakdown){if(c.bytes.status!=='available'){report('可用峰值必须保留完整分解',path);continue;}categories.set(c.category,c.bytes.quantity.value);}const total=[...categories.values()].reduce((n,v)=>n+v,0);if(!Number.isSafeInteger(total)||total!==m.peakBytes.quantity.value)report('峰值分解与总数不同',path);
    const allocated=new Map<string,number>();for(const a of result.storageAllocations){const local=a.allocation.perDevice.find(d=>d.deviceId===deviceId);if(local?.totalBytes.status==='unavailable')report('存在未知分配时峰值不能可用',path);if(local?.totalBytes.status==='available')allocated.set(a.category,(allocated.get(a.category)??0)+local.totalBytes.quantity.value);}
    for(const [category,value] of categories){const maximum=allocated.get(category)??0;if(value>maximum||(['weight','state','graph','runtime','reserve'].includes(category)&&value!==maximum))report('峰值类别与声明分配/常驻边界不符',path+'.categoryBreakdown');}
    for(const category of ['weight','state','graph','runtime','reserve'])if((categories.get(category)??0)!==(allocated.get(category)??0))report('峰值不能省略常驻分配',path+'.categoryBreakdown');
    if(m.capacityStatus.kind!=='point_only')report('串行单点结果不能冒充容量搜索结论',path+'.capacityStatus');
    const memoryOrder=e?.memoryOrder??e?.steps;
    if(m.peakPoint.kind==='time'){const node=memoryOrder?.find(s=>s.nodeId===m.peakPoint.nodeId);if(!node||node.startSeconds===undefined||!close(node.startSeconds,m.peakPoint.seconds))report('峰值时间缺少对应的已知生命周期事件起点',path+'.peakPoint');}
    else if(memoryOrder&&((memoryOrder.length&&m.peakPoint.index>=memoryOrder.length)||(m.peakPoint.nodeId!==undefined&&memoryOrder[m.peakPoint.index]?.nodeId!==m.peakPoint.nodeId)))report('峰值序号未匹配内部生命周期事件',path+'.peakPoint');
  }
  return issues;
}
