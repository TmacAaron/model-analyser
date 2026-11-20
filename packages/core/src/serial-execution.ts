import { SerialExecutionAttempt,metricFor,type ResolvedGraph,type Scenario,type ParallelResolution,type Diagnostic,type NodeId,type DeviceId,type MetricValue,type TensorPartitionResult,type SerialExecution } from '@model-analyser/contracts';
import { orderDependencies } from './graph.js';
import { canReadTensorPieces,canReadTensorLocally } from './layout-compatibility.js';
import { FormulaError } from './formula.js';
import { MetricFactory } from './metrics.js';

type Inputs=Pick<ParallelResolution,'tensorLayouts'|'communications'|'localCosts'>;
const inside=(id:string,root:string)=>root==='$model'||id===root||id.startsWith(root+'/')||id.startsWith(root+'[');
export const SERIAL_EXECUTION_VERSION='0.1.0-serial-barrier.1';
export function buildSerialExecution(resolved:ResolvedGraph,scenario:Scenario,input:Inputs,diagnostics:Diagnostic[]):SerialExecutionAttempt{
  const provenance={assetRefs:resolved.assetRefs,formulaRefs:resolved.assetRefs.filter(r=>r.kind==='formula'),parameterSources:[],assumptions:[
    'Global serial-barrier policy: devices within one logical node start together; the next logical node waits for the slowest participating device. No inter-node overlap.',
    'Compute ready-node ties follow expanded graph order. Communication ties use stable node IDs; explicit and inferred data dependencies take priority.',
    'External graph inputs, weights and initialized states are available in their explicitly declared initial layouts. Load/conversion time is outside this phase.',
    'Legacy communications without placement are not silently appended to the timeline. Unknown durations or data readiness stop absolute timestamps, while known per-step durations remain visible.',
    ...scenario.parallelPlan.assumptions,
  ]},metrics=new MetricFactory(diagnostics,provenance,scenario.scenarioId,'serial-execution');
  const unavailable=(code:string,message:string)=>metrics.unavailable(code,message);
  try{
    if(scenario.executionPlan.kind!=='serial')return {status:'unavailable',diagnosticIds:unavailable('unsupported_execution_plan','当前时间线只实现 serial_barrier；多流不会被默认为串行').diagnosticIds};
    const graph=resolved.graph,logical=new Map(graph.nodes.map(n=>[n.nodeId,n])),costs=new Map(input.localCosts.nodes.map(n=>[n.nodeId,n])),layouts=new Map(input.tensorLayouts.map(t=>[JSON.stringify([t.nodeId,t.tensorId]),t.partition]));
    const tensorLayout=(nodeId:NodeId,tensorId:string)=>layouts.get(JSON.stringify([nodeId,tensorId]));
    const active=new Map<NodeId,DeviceId[]>(),durations=new Map<NodeId,MetricValue>(),localDurations=new Map<NodeId,Map<DeviceId,MetricValue>>(),kinds=new Map<NodeId,'compute'|'communication'|'metadata'>();
    for(const n of graph.nodes){if(n.body.kind==='collective')continue;const c=costs.get(n.nodeId);if(c?.placement.kind==='placed'){active.set(n.nodeId,c.placement.perDevice.map(d=>d.deviceId));const seconds=new Map(c.placement.perDevice.map(d=>[d.deviceId,d.outcome.status==='available'?d.outcome.cost.seconds:d.outcome]));localDurations.set(n.nodeId,seconds);const missing=[...seconds.values()].filter(v=>v.status==='unavailable');durations.set(n.nodeId,missing.length?{status:'unavailable',diagnosticIds:[...new Set(missing.flatMap(m=>m.diagnosticIds))]}:metrics.available(Math.max(...[...seconds.values()].flatMap(m=>m.status==='available'?[m.quantity.value]:[])),'second'));kinds.set(n.nodeId,'compute');}
      else if(c?.placement.kind==='no_work'){const devices=[...new Set(input.tensorLayouts.filter(t=>t.nodeId===n.nodeId).flatMap(t=>t.partition.placements.map(p=>p.deviceId)))];active.set(n.nodeId,devices);durations.set(n.nodeId,metrics.available(0,'second'));localDurations.set(n.nodeId,new Map(devices.map(id=>[id,metrics.available(0,'second')])));kinds.set(n.nodeId,'metadata');}
      else {active.set(n.nodeId,[]);durations.set(n.nodeId,c?.placement.kind==='unplaced'?{status:'unavailable',diagnosticIds:c.placement.diagnosticIds}:unavailable('missing_local_cost','节点缺少局部成本 '+n.nodeId));kinds.set(n.nodeId,'compute');}
    }
    const scheduled=input.communications.filter(c=>c.evaluation.definition.placement),unplacedCommunicationIndices=input.communications.filter(c=>!c.evaluation.definition.placement).map(c=>c.index),commById=new Map<NodeId,typeof scheduled[number]>();
    for(const c of scheduled){const p=c.evaluation.definition.placement;if(!p)continue;if(logical.has(p.nodeId)&&logical.get(p.nodeId)?.body.kind!=='collective'||commById.has(p.nodeId)||resolved.containers.some(n=>n.nodeId===p.nodeId))throw new FormulaError('duplicate_id','通信节点 ID 冲突 '+p.nodeId);commById.set(p.nodeId,c);active.set(p.nodeId,c.evaluation.cost.scope.deviceIds);durations.set(p.nodeId,c.evaluation.cost.seconds);localDurations.set(p.nodeId,new Map(c.evaluation.cost.scope.deviceIds.map(id=>[id,c.evaluation.cost.seconds])));kinds.set(p.nodeId,'communication');}
    const ids=[...graph.nodes.map(n=>n.nodeId),...[...commById.keys()].filter(id=>!logical.has(id)).sort()],dependencies:SerialExecution['dependencies']=[],seenEdges=new Set<string>();
    const add=(fromNodeId:NodeId,toNodeId:NodeId,kind:SerialExecution['dependencies'][number]['kind'])=>{const key=JSON.stringify([fromNodeId,toNodeId]);if(!seenEdges.has(key)){seenEdges.add(key);dependencies.push({fromNodeId,toNodeId,kind});}};
    for(const edge of graph.edges)if(edge.from.kind==='node'&&edge.to.kind==='node')add(edge.from.nodeId,edge.to.nodeId,'data');for(const d of graph.dependencies)add(d.fromNodeId,d.toNodeId,d.kind);
    const expand=(id:NodeId):NodeId[]=>{if(logical.has(id)||commById.has(id))return [id];const container=resolved.containers.find(c=>c.nodeId===id);if(!container)throw new FormulaError('missing_reference','通信依赖未匹配展开范围 '+id);return container.leafNodeIds;};
    for(const [id,c] of commById){const placement=c.evaluation.definition.placement;if(!placement)continue;for(const ref of placement.afterNodeIds)for(const from of expand(ref))add(from,id,'communication');for(const ref of placement.beforeNodeIds)for(const to of expand(ref))add(id,to,'communication');}
    const producers=new Map<string,NodeId[]>(),consumers=new Map<string,NodeId[]>();
    for(const n of graph.nodes)if(n.body.kind==='opaque'){for(const p of n.body.outputs)producers.set(p.tensorId,[...new Set([...(producers.get(p.tensorId)??[]),n.nodeId])]);for(const p of n.body.inputs)consumers.set(p.tensorId,[...new Set([...(consumers.get(p.tensorId)??[]),n.nodeId])]);}
    const blocked=new Set<NodeId>();
    function block(id:NodeId,code:string,message:string){if(!blocked.has(id))unavailable(code,message);blocked.add(id);}
    const sourceFor=(c:typeof scheduled[number])=>{const d=c.evaluation.definition;return d.operation==='send_recv'?{...c.evaluation.source,placements:c.evaluation.source.placements.filter(p=>p.deviceId===d.sourceDeviceId)}:c.evaluation.source;};
    const destinationFor=(c:typeof scheduled[number])=>{const d=c.evaluation.definition;return d.operation==='send_recv'?{...c.evaluation.destination,placements:c.evaluation.destination.placements.filter(p=>p.deviceId===d.destinationDeviceId)}:c.evaluation.destination;};
    for(const [id,c] of commById){const d=c.evaluation.definition,writers=producers.get(d.source.tensorId)??[];if(writers.length>1)block(id,'ambiguous_communication_producer','通信 '+id+' 的源有多个阶段内写入者，需要独立张量版本明确数据来源');else if(writers[0])add(writers[0],id,'communication');
      const source=sourceFor(c),destination=destinationFor(c);for(const consumer of consumers.get(d.destination.tensorId)??[]){if(consumer===writers[0]&&d.source.tensorId===d.destination.tensorId)continue;const required=tensorLayout(consumer,d.destination.tensorId);if(!required)continue;const sourceProvides=d.source.tensorId===d.destination.tensorId&&canReadTensorLocally(source,required),destinationProvides=canReadTensorLocally(destination,required);if(destinationProvides&&!sourceProvides)add(id,consumer,'communication');else if(sourceProvides&&!destinationProvides&&d.source.tensorId===d.destination.tensorId)add(consumer,id,'communication');}
    }
    const orderedNodeIds=orderDependencies(ids,dependencies),predecessors=new Map<NodeId,NodeId[]>();for(const d of dependencies)predecessors.set(d.toNodeId,[...(predecessors.get(d.toNodeId)??[]),d.fromNodeId]);
    const ancestorCache=new Map<NodeId,Set<NodeId>>();function ancestors(id:NodeId):Set<NodeId>{const prior=ancestorCache.get(id);if(prior)return prior;const all=new Set<NodeId>(),todo=[...(predecessors.get(id)??[])];while(todo.length){const p=todo.pop();if(!p||all.has(p))continue;all.add(p);todo.push(...predecessors.get(p)??[]);}ancestorCache.set(id,all);return all;}
    const tensors=new Map(graph.tensors.map(t=>[String(t.tensorId),t])),storages=new Map(graph.storages.map(s=>[String(s.storageId),s]));
    function canonicalStorage(id:string){const visited=new Set<string>();while(true){const s=storages.get(id);if(!s)throw new FormulaError('missing_reference','执行布局缺少存储 '+id);if(s.allocation.kind!=='alias')return id;if(visited.has(id))throw new FormulaError('dependency_cycle','执行布局 alias 环');visited.add(id);id=s.allocation.targetStorageId;}}
    const initialized=new Set(graph.states.filter(s=>s.creator.kind==='initialized').flatMap(s=>s.storageIds.map(canonicalStorage))),external=new Set(graph.inputs.map(p=>String(p.tensorId))),ledger=new Map<string,TensorPartitionResult[]>();
    function initiallyReady(tensorId:string){const t=tensors.get(tensorId);return external.has(tensorId)||(t!==undefined&&(storages.get(canonicalStorage(t.storageId))?.category==='weight'||initialized.has(canonicalStorage(t.storageId))));}
    const onDevices=(p:TensorPartitionResult,devices:DeviceId[])=>({...p,placements:p.placements.filter(p=>devices.includes(p.deviceId))});
    function seed(tensorId:string,nodeId:NodeId,layout:TensorPartitionResult){if(!initiallyReady(tensorId))return;const priorWriter=(producers.get(tensorId)??[]).some(id=>ancestors(nodeId).has(id)),priorCommunication=[...commById].some(([id,c])=>c.evaluation.destination.tensorId===tensorId&&ancestors(nodeId).has(id));if(!priorWriter&&!priorCommunication)ledger.set(tensorId,[...(ledger.get(tensorId)??[]),layout]);}
    for(const n of graph.nodes)if(n.body.kind==='opaque')for(const p of n.body.inputs){const layout=tensorLayout(n.nodeId,p.tensorId);if(layout)seed(p.tensorId,n.nodeId,onDevices(layout,active.get(n.nodeId)??[]));}
    for(const t of input.tensorLayouts)if(!logical.has(t.nodeId)&&initiallyReady(t.tensorId))ledger.set(t.tensorId,[...(ledger.get(t.tensorId)??[]),t.partition]);
    for(const [id,c] of commById)seed(c.evaluation.source.tensorId,id,c.evaluation.source);
    function write(tensorId:string,p:TensorPartitionResult,metadataView=false){const t=tensors.get(tensorId);if(!t)throw new FormulaError('missing_reference','写入缺少张量');const deviceIds=new Set(p.placements.map(p=>p.deviceId)),canonical=canonicalStorage(t.storageId);
      for(const [other,parts] of ledger){const spec=tensors.get(other);if(!spec||canonicalStorage(spec.storageId)!==canonical)continue;if(metadataView&&other!==tensorId)continue;ledger.set(other,parts.map(part=>({...part,placements:part.placements.filter(q=>!deviceIds.has(q.deviceId))})).filter(part=>part.placements.length));}
      ledger.set(tensorId,[...(ledger.get(tensorId)??[]),p]);
    }
    for(const id of orderedNodeIds){const c=commById.get(id);if(c){const source=sourceFor(c);if(blocked.has(id)||!canReadTensorPieces(ledger.get(source.tensorId)??[],source)){block(id,'unavailable_communication_source','通信 '+id+' 的源数据在当前依赖顺序/设备布局中不可用');continue;}write(c.evaluation.destination.tensorId,destinationFor(c));continue;}
      const n=logical.get(id);if(n?.body.kind!=='opaque')continue;const devices=active.get(id)??[];if(!devices.length&&costs.get(id)?.placement.kind!=='no_work'){block(id,'unknown_execution_devices','节点 '+id+' 的参与设备尚未确定');continue;}
      for(const port of [...n.body.inputs,...n.body.outputs]){const layout=tensorLayout(id,port.tensorId),fused=resolved.fusionApplications.some(g=>g.nodeId===id);if(!layout||(!fused&&devices.some(d=>!layout.placements.some(p=>p.deviceId===d))))block(id,'incomplete_execution_layout','节点 '+id+' 的端口 '+port.portId+' 缺少完整设备布局');}
      for(const port of n.body.inputs){const p=tensorLayout(id,port.tensorId);if(p&&!canReadTensorPieces(ledger.get(port.tensorId)??[],onDevices(p,devices)))block(id,'unavailable_input_layout','节点 '+id+' 在当前顺序无法读取 '+port.tensorId+'；需通信、本地 view 或明确共享视图映射');}
      if(!blocked.has(id))for(const port of n.body.outputs){const p=tensorLayout(id,port.tensorId);if(p)write(port.tensorId,onDevices(p,devices),id.includes('/$outputs:'));}
    }
    for(const output of graph.outputs){const writers=orderedNodeIds.filter(id=>commById.get(id)?.evaluation.destination.tensorId===output.tensorId||(producers.get(output.tensorId)??[]).includes(id)),last=writers.at(-1),comm=last?commById.get(last):undefined,goal=comm?destinationFor(comm):(last?tensorLayout(last,output.tensorId):input.tensorLayouts.find(t=>t.tensorId===output.tensorId)?.partition);
      if(goal?.distribution.kind==='partial'){if(last)block(last,'unreduced_graph_output','图输出 '+output.tensorId+' 在阶段结束仍为 partial');}
      else if(goal&&!canReadTensorPieces(ledger.get(output.tensorId)??[],goal)){if(last)block(last,'incomplete_graph_output','图输出 '+output.tensorId+' 未覆盖声明的全部输出设备/有效切片');}
    }
    const steps:SerialExecution['steps']=[],intervals:SerialExecution['intervals']=[];let time:number|undefined=unplacedCommunicationIndices.length?undefined:0;
    if(unplacedCommunicationIndices.length)unavailable('unplaced_communication','通信缺少 placement，无法可靠生成完整时间线：'+unplacedCommunicationIndices.join(', '));
    for(const id of orderedNodeIds){const duration=durations.get(id)??unavailable('missing_node_duration','节点耗时缺失 '+id),step:SerialExecution['steps'][number]={nodeId:id,kind:kinds.get(id)??'compute',deviceIds:active.get(id)??[],duration:metricFor('second').parse(duration)};if(blocked.has(id))time=undefined;
      if(time!==undefined){step.startSeconds=time;const next=duration.status==='available'?time+duration.quantity.value:undefined;let precise=next!==undefined&&Number.isFinite(next)&&!(duration.status==='available'&&duration.quantity.value>0&&next===time);
        const nodeIntervals:SerialExecution['intervals']=[];for(const [deviceId,seconds] of localDurations.get(id)??[]){if(seconds.status!=='available')continue;const end:number=time+seconds.quantity.value;if(!Number.isFinite(end)||(seconds.quantity.value>0&&end===time)){precise=false;continue;}nodeIntervals.push({nodeId:id,kind:step.kind,deviceId,startSeconds:time,endSeconds:end});}
        if(precise&&next!==undefined){step.endSeconds=next;time=next;intervals.push(...nodeIntervals);}else {if(duration.status==='available')unavailable('timeline_numeric_overflow','累计时刻溢出或无法表示非零区间 '+id);else intervals.push(...nodeIntervals);time=undefined;}
      }steps.push(step);
    }
    const complete=time!==undefined&&!blocked.size&&!unplacedCommunicationIndices.length,makespan=complete?metrics.available(time??0,'second','estimated'):unavailable('incomplete_serial_execution','存在未定位通信、布局/耗时/数值缺项，不能报告完整串行跨度');
    return SerialExecutionAttempt.parse({status:'available',result:{version:SERIAL_EXECUTION_VERSION,policy:'serial_barrier',completeness:complete?'complete':'partial',orderedNodeIds,dependencies,steps,intervals,makespan,unplacedCommunicationIndices,blockedNodeIds:[...blocked]}});
  }catch(e){return {status:'unavailable',diagnosticIds:unavailable(e instanceof FormulaError?e.code:'invalid_serial_execution',e instanceof Error?e.message:'无法建立执行顺序').diagnosticIds};}
}
