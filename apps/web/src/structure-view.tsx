import { useDisplayUnits } from './display-units.js';
import { useMemo,useState } from 'react';
import {useModelInstantiation} from './use-model-instantiation.js';
import {structurePictureIndex} from './structure-picture-layout.js';
import { type Scenario,type AssetDocument,type ResolvedGraph } from '@model-analyser/contracts';
import { canonical } from '../../../packages/contracts/src/validation.js';
import { QuantizationApplications } from './quantization-view.js';
import { FusionApplications } from './fusion-view.js';
import { StructureTree } from './structure-tree.js';
import { traceNodeFormulas } from './formula-trace.js';

function GraphPicture({resolved,limit,onSelect}:{resolved:ResolvedGraph;limit:number;onSelect:(id:string)=>void}){
  const {ordered,ranks,byId,links}=useMemo(()=>structurePictureIndex(resolved),[resolved]);
  const positions=new Map<string,{x:number;y:number}>(),rows=new Map<number,number>();
  for(const id of ordered.slice(0,limit)){const rank=ranks.get(id)??0,row=rows.get(rank)??0;rows.set(rank,row+1);positions.set(id,{x:25+rank*220,y:25+row*95});}
  const width=Math.max(560,...[...positions.values()].map(p=>p.x+210)),height=Math.max(150,...[...positions.values()].map(p=>p.y+100));
  return <div className="dependency-picture"><svg role="img" aria-label="展开后的数据与控制依赖图" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
    <defs><marker id="dependency-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="#83a08c"/></marker></defs>
    {links.map((edge,i)=>{const from=positions.get(edge.from),to=positions.get(edge.to);return from&&to?<path key={i} d={`M ${from.x+170} ${from.y+28} C ${from.x+205} ${from.y+28}, ${to.x-30} ${to.y+28}, ${to.x} ${to.y+28}`} fill="none" stroke="#83a08c" strokeWidth="1.5" strokeDasharray={edge.control?'5 4':undefined} markerEnd="url(#dependency-arrow)"/>:null;})}
    {[...positions].map(([id,p])=><g key={id} role="button" aria-label={'查看节点 '+id} tabIndex={0} onClick={()=>onSelect(id)} onKeyDown={e=>{if(e.key==='Enter')onSelect(id);}} style={{cursor:'pointer'}}><title>{byId.get(id)?.name} · {id}</title><rect x={p.x} y={p.y} width="170" height="57" rx="8" fill="#f3f8f4" stroke="#b4cbb9"/><text x={p.x+12} y={p.y+22} fill="#365d45" fontSize="11">{(byId.get(id)?.name??id).slice(0,23)}</text><text x={p.x+12} y={p.y+40} fill="#7c9383" fontSize="9">{id.length>25?id.slice(0,24)+'…':id}</text></g>)}
  </svg></div>;
}
export function StructureView({scenario,assets}:{scenario:Scenario;assets:AssetDocument[]}){
  const display=useDisplayUnits();
  const fingerprint=useMemo(()=>canonical({scenario,assets}),[scenario,assets]);
  const [requested,setRequested]=useState<{key:string;run:number}>(),[selected,setSelected]=useState(''),[limit,setLimit]=useState(60);
  const expansion=useModelInstantiation(requested?.key===fingerprint?scenario:undefined,assets,fingerprint+':'+(requested?.run??0)),result=expansion.attempt??null,resolved=result?.status==='available'?result.resolved:null;
  const node=resolved?.graph.nodes.find(n=>n.nodeId===selected)??resolved?.graph.nodes[0];
  function expand(){setRequested(current=>({key:fingerprint,run:(current?.run??0)+1}));setSelected('');setLimit(60);}
  const body=node?.body.kind==='opaque'?node.body:undefined;
  const trace=node?traceNodeFormulas(scenario.model,node.nodeId,assets):undefined;
  return <section className="structure-panel"><div className="panel-title"><div><h2>模型结构与依赖</h2><small>按当前阶段、参数与固定修订展开</small></div><button disabled={expansion.pending} onClick={expand}>展开模型结构</button></div>
    {expansion.pending&&<p role="status">正在后台展开模型结构…<button onClick={expansion.cancel}>取消结构展开</button></p>}{expansion.cancelled&&<p>结构展开已取消，可重新展开。</p>}{expansion.error&&<p role="alert">{expansion.error}</p>}{!result&&!expansion.pending&&!expansion.cancelled&&!expansion.error&&<p className="scope-note">{requested?'配置已变化，请重新展开当前结构。':'展开后查看稳定节点、张量、状态与公式结果。'}</p>}
    {result?.status==='unavailable'&&<div role="alert" className="error">{result.diagnostics.map(d=><p key={d.diagnosticId}>{d.code} · {d.message}</p>)}</div>}
    {result?.status==='available'&&!!result.diagnostics.length&&<details><summary>结构诊断 · {result.diagnostics.length} 项</summary>{result.diagnostics.map(d=><p key={d.diagnosticId}>{d.severity} · {d.code} · {d.message}</p>)}</details>}
    {resolved&&<><p className="scope-note">{resolved.graph.nodes.length} 个叶节点 · {resolved.containers.length} 个容器 · {resolved.graph.storages.length} 个逻辑存储对象 · {resolved.graph.states.length} 个状态</p>
      <GraphPicture resolved={resolved} limit={limit} onSelect={setSelected}/><p className="scope-note">实线为数据依赖，虚线为控制/同步依赖。显示 {Math.min(limit,resolved.graph.nodes.length)} / {resolved.graph.nodes.length} 个叶节点。{limit<resolved.graph.nodes.length&&<button onClick={()=>setLimit(limit+60)}>再显示 60 个</button>}</p>
      <details className="structure-containers"><summary>模块容器与有效叶节点</summary><StructureTree resolved={resolved} onSelect={setSelected}/></details>
      <div className="node-picker"><label>当前节点<select aria-label="结构节点" value={node?.nodeId??''} onChange={e=>setSelected(e.target.value)}>{resolved.graph.nodes.map(n=><option key={n.nodeId} value={n.nodeId}>{n.nodeId} · {n.name}</option>)}</select></label></div>
      {node&&<div className="node-inspector"><h3>{node.name} <code>{node.nodeId}</code></h3><table><thead><tr><th>端口</th><th>张量</th><th>Shape</th><th>存储精度</th></tr></thead><tbody>{node.portBindings.map((p,i)=>{const tensor=resolved.graph.tensors.find(t=>t.tensorId===p.tensorId);return <tr key={p.portId+':'+i}><td>{p.portId}</td><td><code>{p.tensorId}</code></td><td>{tensor?.shape.map(a=>a.size.kind==='literal'?a.size.quantity.value:'?').join(' × ')||'scalar'}</td><td>{tensor?.dtype.format}</td></tr>;})}</tbody></table>
        {body&&<><h3>已绑定成本表达式</h3><table><thead><tr><th>计算段</th><th>有效 operations</th><th>执行 operations</th><th>乘法 / 累加精度</th></tr></thead><tbody>{body.cost.compute.map(c=><tr key={c.segmentId}><td>{c.segmentId}</td><td>{c.usefulOperations.kind==='literal'?c.usefulOperations.quantity.value:'未解析'}</td><td>{c.executedOperations.kind==='literal'?c.executedOperations.quantity.value:'未解析'}</td><td>{c.computeClass.multiplyDtype.format} / {c.computeClass.accumulateDtype.format}</td></tr>)}</tbody></table><table><thead><tr><th>访问</th><th>底层存储</th><th>逻辑 bytes</th></tr></thead><tbody>{body.cost.memoryAccess.map(a=><tr key={a.accessId}><td>{a.mode}</td><td><code>{a.storageId}</code></td><td>{a.logicalBytes.kind==='literal'?a.logicalBytes.quantity.value:a.logicalBytes.kind==='storage_allocation'?'物理分配 × '+(a.logicalBytes.passes.kind==='literal'?a.logicalBytes.passes.quantity.value:'passes'):'未解析'}</td></tr>)}</tbody></table></>}
        {node.body.kind==='collective'&&<div className="collective-inspector"><h3>图内通信定义</h3><p>{node.body.communication.operation} · 设备组 {node.body.communication.groupId}</p><p><code>{node.body.communication.source.tensorId}</code>（{node.body.communication.source.distribution.kind}） → <code>{node.body.communication.destination.tensorId}</code>（{node.body.communication.destination.distribution.kind}）</p><p>每成员发送 / 接收 payload：{node.body.communication.sendBytesPerMember.kind==='literal'?display.quantity(node.body.communication.sendBytesPerMember.quantity.value,node.body.communication.sendBytesPerMember.quantity.unit):'未解析'} / {node.body.communication.receiveBytesPerMember.kind==='literal'?display.quantity(node.body.communication.receiveBytesPerMember.quantity.value,node.body.communication.receiveBytesPerMember.quantity.unit):'未解析'} · 算法系数 {node.body.communication.algorithm.trafficFactor}</p><p>临时存储：{node.body.communication.temporaryStorageIds?.join(', ')||'未声明'}。网络成本在执行时计一次，不推断未声明的本地 HBM 或归约算术。</p></div>}
        <details className="formula-trace"><summary>原始公式与固定来源</summary>{trace?.chain.map((c,i)=><p key={i}>{c.name} <code>{c.asset.assetId} @r{c.asset.revision}{c.localNodeId?' / '+c.localNodeId:''}</code></p>)}{trace?.formulas.map(a=><div key={a.assetId+'@'+a.revision}><strong>{a.name}</strong><code>{a.assetId} @r{a.revision}</code>{a.definition.kind==='formula'&&<><pre>{a.definition.formula.expression}</pre><small>输出 {a.definition.formula.output.unit} · 输入 {Object.entries(a.definition.formula.inputs).map(([key,s])=>key+':'+s.unit).join(', ')}</small></>}</div>)}{!trace?.formulas.length&&<p>此节点未引用独立公式资产；固定值和直接声明的成本见绑定结果与资产定义。</p>}</details>
        <details><summary>参数值与来源</summary>{resolved.parameters.filter(p=>p.nodeId==='$model'||p.nodeId===node.nodeId||node.nodeId.startsWith(p.nodeId+'/')).map(p=><p key={p.nodeId+':'+p.parameterKey}>{p.nodeId}:{p.parameterKey} = {String(p.value.value)} {p.unit} · {p.source.kind}{p.source.kind==='config_import'?' · '+p.source.sourceName+' '+p.source.field+' ('+p.source.origin+')':''}</p>)}</details>
      </div>}
      <FusionApplications applications={resolved.fusionApplications}/><QuantizationApplications applications={resolved.quantizationApplications}/>{!!resolved.graph.states.length&&<details><summary>持久状态与共享关系</summary>{resolved.graph.states.map(s=><p key={s.stateId}><code>{s.stateId}</code> · {s.stateKind} · {s.storageIds.join(', ')} · {s.readers.length} 次读取引用 / {s.writers.length} 个更新引用</p>)}</details>}
      <p className="scope-note">此处展示逻辑结构、绑定成本及方案量化/融合规则；实际设备布局、融合组执行与显存峰值请查看对应计算结果。</p>
    </>}
  </section>;
}


