import { useMemo,useState } from 'react';
import type { ResolvedGraph } from '@model-analyser/contracts';
import { containsNode,indexInspectorObjects,type InspectorObjectIndex } from './resolved-inspector.js';
export function relevantStates(resolved:ResolvedGraph,nodeId:string,leafIds:string[],index?:InspectorObjectIndex){
  const {states,nodes}=resolved.graph;
  if(!states.length||nodeId==='$model')return states;
  const members=new Set(leafIds),boundStates=new Set(resolved.objectBindings.filter(f=>containsNode(nodeId,f.nodeId)).flatMap(f=>f.states.map(s=>s.stateId)));
  const direct=new Set(states.filter(state=>boundStates.has(state.stateId)||
    state.creator.kind==='node'&&members.has(state.creator.nodeId)||
    state.readers.some(port=>members.has(port.nodeId))||state.writers.some(port=>members.has(port.nodeId))));
  if(direct.size===states.length||!members.size)return states.filter(state=>direct.has(state));

  const objects=index??indexInspectorObjects(resolved),storageIds=new Set<string>();
  const canonicalId=(id:string)=>objects.storage(id)?.storageId??id;
  for(const node of nodes){
    if(!members.has(node.nodeId))continue;
    for(const port of node.portBindings){
      const tensor=objects.tensors.get(port.tensorId);
      if(tensor)storageIds.add(canonicalId(tensor.storageId));
    }
    if(node.body.kind==='opaque')for(const access of node.body.cost.memoryAccess)storageIds.add(canonicalId(access.storageId));
  }
  return states.filter(state=>direct.has(state)||state.storageIds.some(id=>storageIds.has(canonicalId(id))));
}
function Accessors({items}:{items:ResolvedGraph['graph']['states'][number]['readers']}){const [limit,setLimit]=useState(12);return <>{items.slice(0,limit).map((p,i)=><code key={i}>{p.nodeId} · {p.portId}</code>)}{!items.length&&<span>未声明</span>}{items.length>limit&&<button onClick={()=>setLimit(n=>n+24)}>再显示 24 项（{limit}/{items.length}）</button>}</>;}
export function StateRelations({resolved,nodeId,leafIds,objects}:{resolved:ResolvedGraph;nodeId:string;leafIds:string[];objects?:InspectorObjectIndex}){
  const [limit,setLimit]=useState(20),index=useMemo(()=>objects??indexInspectorObjects(resolved),[objects,resolved]);
  const states=useMemo(()=>relevantStates(resolved,nodeId,leafIds,index),[resolved,nodeId,leafIds.join('\0'),index]);
  return <details className="state-relations"><summary>持久状态与读写关系 · {states.length}</summary><p className="scope-note">状态更新描述跨调用关系，不添加到单步 DAG。按实际状态和规范存储 ID 关联；共享存储不免除各节点读取成本。</p>{!states.length&&<p>当前节点没有关联的持久状态。</p>}{states.slice(0,limit).map(s=><details key={s.stateId} className="state-relation"><summary>{s.name} · {s.stateKind}<small>{s.stateId}</small></summary><p>创建者：{s.creator.kind==='initialized'?'调用前已初始化':s.creator.nodeId+' · '+s.creator.portId}</p><p>更新策略：{s.updatePolicy.kind}{s.updatePolicy.kind==='windowed'?' · window '+(s.updatePolicy.window.kind==='literal'?s.updatePolicy.window.quantity.value:JSON.stringify(s.updatePolicy.window)):''}{s.allocationBasis?' · 分配边界 '+s.allocationBasis:''}</p><h4>实际存储与共享域</h4>{s.storageIds.map(id=>{const storage=index.storage(id);return <p key={id}><code>{id}</code><small>规范存储 {storage?.storageId??'缺失'} · {storage?.sharingDomain??'未知'} · {storage?.category??'未知'}</small></p>;})}<h4>读取端口 · {s.readers.length}</h4><Accessors items={s.readers}/><h4>写入端口 · {s.writers.length}</h4><Accessors items={s.writers}/></details>)}{states.length>limit&&<button onClick={()=>setLimit(n=>n+20)}>再显示 20 个状态（{limit}/{states.length}）</button>}</details>;
}
