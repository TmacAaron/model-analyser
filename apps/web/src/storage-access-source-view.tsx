import {useState,type ReactNode} from 'react';
import type {StorageAccessSource} from '@model-analyser/core';
import {FormulaProof} from './declaration-source-view.js';
function Records<T>({values,label,children}:{values:T[];label:string;children:(value:T)=>ReactNode}){
 const [page,setPage]=useState(0),start=page*20;return <section><h5>{label} · {values.length} 项</h5>{values.slice(start,start+20).map((v,i)=><div key={start+i}>{children(v)}</div>)}{page>0&&<button onClick={()=>setPage(page-1)}>上一页{label}</button>}{start+20<values.length&&<button onClick={()=>setPage(page+1)}>下一页{label}</button>}</section>;
}
export function StorageAccessProof({source}:{source:Omit<StorageAccessSource,'parameterRoots'>}){
 return <section className="storage-access-proof" aria-label="实际分配与访问来源"><h4>实际分配与访问字节</h4><p>已复核原叶指标：{source.metric.quantity.value} byte · {source.field}</p><p role="status">{source.complete?'本页分配、访问乘法与原顺序求和已完整复核。':'当前为分页或有界来源，未声明完整上游链。'} 共 {source.componentCount} 项访问，每页最多20项。</p>
 {source.items.map(item=><article key={item.index} className="storage-access-item"><h5>{item.accessId} · {item.mode==='read'?'读取':'写入'}</h5><p>本次访问贡献 {item.contribution.value} byte</p>{'proof'in item&&item.proof&&<><FormulaProof proof={item.proof.proof}/><small>{item.proof.field}</small></>}
 {item.kind==='explicit_hbm_bytes'&&<p>使用独立声明的HBM字节表达式；此项不依赖存储分配或量化字节。</p>}{item.skippedStorage&&<p>passes 为零，实际执行直接返回零，未读取存储分配。</p>}
 {'storage'in item&&item.storage&&<details className="storage-transformation" open><summary>规范存储 {item.storage.storageId} · 最终 {item.storage.bytes} byte</summary><p>身份链 {item.storage.aliases.join(' → ')}</p><p>实际访问：{item.storage.bytes} byte × {'proof'in item?item.proof?.quantity.value:'?'} passes{'factor'in item&&item.factor!==undefined?' × HBM因子 '+item.factor:''} = {item.contribution.value} byte</p>
 {item.storage.quantization.application&&<p className="quantization-allocation">量化分配：{item.storage.quantization.application.beforeBytes} → {item.storage.quantization.application.afterBytes} byte；规则 #{item.storage.quantization.application.assignmentIndices.join(', #')}（从0开始）。</p>}
 <Records values={item.storage.overrides} label="显式分配覆盖">{o=><p>覆盖 #{o.overrideIndex}：{o.override.value.value} byte。最终访问使用覆盖后的分配，量化打包值保留为前一步。</p>}</Records>
 <details><summary>规则选择与量化辅助项</summary><Records values={item.storage.quantization.decisions} label="实际规则选择">{d=><p><code>{d.nodeId}</code> · 生效 {d.winners.map(w=>'#'+w.ruleIndex+'（优先级'+w.priority+'）').join(', ')||'原存储格式'} · 被覆盖 {d.losers.map(w=>'#'+w.ruleIndex).join(', ')||'无'}</p>}</Records>
 <Records values={item.storage.quantization.bindings} label="辅助项绑定">{b=><section><p><code>{b.nodeId}</code> · 规则 #{b.ruleIndex}</p><Records values={b.proofs} label="辅助项公式">{p=><section><strong>{p.field}</strong><FormulaProof proof={p.proof}/><Records values={p.links} label="作用域读取">{link=><p>{link.name} = {link.quantity.value} {link.quantity.unit} · 实际域 <code>{link.frameId}</code>；候选顺序 {link.candidates.map(c=>(c.source.kind==='parameter'?c.source.parameter.nodeId:'工作负载')+'='+c.quantity.value).join(' → ')}，最后一项生效。</p>}</Records></section>}</Records></section>}</Records></details>
 <details><summary>原存储声明及参数表达式</summary><Records values={item.storage.initial.proofs} label="原分配公式">{p=><section><h5>{p.field}</h5><FormulaProof proof={p.proof}/></section>}</Records></details>
 <details><summary>实际打包、对齐与分配运算</summary><Records values={item.storage.quantization.operations} label="量化分配运算">{e=><p>{e.phase==='before'?'量化前':'量化后'} · {e.event.field} · {e.event.operation}({e.event.inputs.join(', ')}) → {e.event.value} {e.event.unit}</p>}</Records><Records values={item.storage.final.events} label="最终分配运算">{e=><p>{e.field} · {e.operation}({e.inputs.join(', ')}) → {e.value} {e.unit}</p>}</Records></details>
 {!item.storage.complete&&<p className="scope-note">{item.storage.boundaries.join('；')}</p>}</details>}
 <p>原顺序求和 #{item.index+1}：{item.sum.left} + {item.sum.right} = {item.sum.value} byte</p>{!item.complete&&<p>当前访问来源为部分记录。{item.boundaries.join('；')}</p>}</article>)}
 </section>;
}
