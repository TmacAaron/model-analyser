import { useDisplayUnits } from './display-units.js';
import { displaySeconds } from './display-format.js';
import { useState } from 'react';
import { MemoryPeakOverride,type MemoryPeak,type Scenario,type AssetDocument,type ResolvedGraph } from '@model-analyser/contracts';
import { ModulePeakEditor } from './module-peak-editor.js';
import { preTotalPeak } from '../../../packages/contracts/src/memory-peak-validation.js';
import { validateScenario } from '../../../packages/contracts/src/scenario-validation.js';
import { collectRefs } from '../../../packages/contracts/src/validation.js';

export function peakLocation(p:MemoryPeak['peakPoint'],seconds:(value:number)=>string=displaySeconds):string{
  if(p.kind==='unlocated')return '覆盖值未定位'+(p.decodeStepIndex===undefined?'':' · decode step '+p.decodeStepIndex);
  return (p.kind==='time'?'时间 '+seconds(p.seconds):'执行序号 '+p.index)+' · '+(p.nodeId??'初始状态');
}
export function PeakOverrideNote({memory:m}:{memory:MemoryPeak}){
  const display=useDisplayUnits();
  const module=preTotalPeak(m).moduleOverrides;
  const moduleNote=module&&<div className="module-peak-note"><p>模块私有预算 · 按实际调用跨度预留；私有预算列入 reserve，不代表实测分类。</p>{module.applications.map(a=><p key={a.rule.overrideId}>{a.rule.nodeId} · {display.bytes(a.evaluatedBytes)} / 本设备 · {a.rule.description}</p>)}<p>原理论峰值 {module.theoretical.peakBytes.status==='available'?display.bytes(module.theoretical.peakBytes.quantity.value):'不可用'}{m.sequenceTheoretical?.peakBytes.status==='available'?' · 序列原理论最大 '+display.bytes(m.sequenceTheoretical.peakBytes.quantity.value):''}</p><details><summary>模块范围、保留／替换对象与预算证据</summary><pre>{JSON.stringify(module,null,2)}</pre></details></div>;
  const e=m.totalOverride;if(!e)return moduleNote??null;const t=e.theoretical,value=t.peakBytes.status==='available'?display.bytes(t.peakBytes.quantity.value):'不可用';
  return <div className="peak-override-note"><p>用户总峰值覆盖 · {e.rule.target.kind==='device'?'设备 '+e.rule.target.deviceId:'组 '+e.rule.target.groupId+'，每成员'} · {e.rule.description}</p><p>分类未知 · 覆盖值未定位 · {module?'覆盖前峰值':'原理论峰值'} {value}</p>{moduleNote}{e.shadowedOverrideIds.length>0&&<p>设备规则优先；被覆盖规则：{e.shadowedOverrideIds.join(', ')}</p>}<details><summary>保留的理论分类、位置与覆盖来源</summary><p>{peakLocation(t.peakPoint,display.seconds)}</p>{t.categoryBreakdown.map(c=><p key={c.category}>{c.category}: {c.bytes.status==='available'?display.bytes(c.bytes.quantity.value):'不可用'}</p>)}<pre>{JSON.stringify(e,null,2)}</pre></details></div>;
}
export function MemoryPeakEditor({scenario,assets,onChange,resolved,selection,resolveIfMissing=true}:{scenario:Scenario;assets:AssetDocument[];onChange:(next:Scenario)=>void;resolved?:ResolvedGraph|undefined;selection?:string|undefined;resolveIfMissing?:boolean}){
  const display=useDisplayUnits();

  const [kind,setKind]=useState<'device'|'group'>('device'),[target,setTarget]=useState(''),[phase,setPhase]=useState('both'),[bytes,setBytes]=useState(''),[description,setDescription]=useState(''),[advanced,setAdvanced]=useState(false),[expression,setExpression]=useState(''),[error,setError]=useState('');
  const choices=kind==='device'?scenario.deviceTopology.devices.map(d=>d.deviceId):scenario.deviceTopology.groups.map(g=>g.groupId),selected=choices.includes(target)?target:choices[0]??'';
  function add(){try{
    if(!selected)throw Error('请选择实际设备或设备组');if(!description.trim())throw Error('请填写峰值覆盖来源和假设');
    if(!advanced&&(bytes.trim()===''||!Number.isSafeInteger(Number(bytes))||Number(bytes)<0))throw Error('请输入非负安全整数 byte');
    const rule=MemoryPeakOverride.parse({overrideId:crypto.randomUUID(),phases:phase==='both'?['prefill','decode']:[phase],target:kind==='device'?{kind,deviceId:selected}:{kind,groupId:selected},peakBytes:advanced?JSON.parse(expression):{kind:'literal',quantity:{value:Number(bytes),unit:'byte'}},description:description.trim()});
    for(const ref of collectRefs(rule))if(ref.kind!=='formula'||!assets.some(a=>a.assetId===ref.assetId&&a.revision===ref.revision&&a.definition.kind==='formula'))throw Error('公式必须引用项目内固定的 formula 修订快照');
    const next={...scenario,memoryPeakOverrides:[...(scenario.memoryPeakOverrides??[]),rule]},issues=validateScenario(next,assets).filter(d=>d.severity==='error');if(issues.length)throw Error(issues.map(d=>d.message).join('；'));
    onChange(next);setBytes('');setDescription('');setExpression('');setError('');
  }catch(e){setError(e instanceof Error?e.message:String(e));}}
  return <section className="memory-peak-editor"><ModulePeakEditor scenario={scenario} assets={assets} onChange={onChange} resolved={resolved} selection={selection} resolveIfMissing={resolveIfMissing}/><h3>设备／组总峰值覆盖</h3><p className="scope-note">替换每台物理设备的完整峰值（含权重、KV、共享对象）。保留理论分配、成本和时间线；分类与位置未知。组值按每成员应用，设备规则优先。同级重叠规则需先移除。容量搜索逐点重新求值。</p>
    {(scenario.memoryPeakOverrides??[]).map((r,i)=><div key={r.overrideId} className="peak-override-rule"><strong>{r.target.kind==='device'?r.target.deviceId:r.target.groupId+' / 每成员'}</strong> · {r.phases.join('/')} · {r.peakBytes.kind==='literal'?display.quantity(r.peakBytes.quantity.value,r.peakBytes.quantity.unit):'公式／符号'} · {r.description}<button onClick={()=>{const rules=scenario.memoryPeakOverrides?.filter((_,n)=>n!==i),{memoryPeakOverrides,...base}=scenario;void memoryPeakOverrides;onChange(rules?.length?{...base,memoryPeakOverrides:rules}:base);}}>移除峰值覆盖</button></div>)}
    {scenario.numericOverrides.filter(o=>o.target.kind==='device'&&o.field==='memory_bytes').map((o,i)=><p key={'legacy'+i}>已有 memory_bytes 设备总量：{o.target.kind==='device'?o.target.deviceId:''} · {display.quantity(o.value.value,o.value.unit)}（同样保留理论值）</p>)}
    <div className="workload-fields"><label>峰值覆盖范围<select aria-label="峰值覆盖范围" value={kind} onChange={e=>{setKind(e.target.value==='group'?'group':'device');setTarget('');}}><option value="device">物理设备</option><option value="group">设备组（每成员）</option></select></label><label>峰值覆盖目标<select aria-label="峰值覆盖目标" value={selected} onChange={e=>setTarget(e.target.value)}>{choices.map(id=><option key={id} value={id}>{id}</option>)}</select></label><label>峰值覆盖阶段<select aria-label="峰值覆盖阶段" value={phase} onChange={e=>setPhase(e.target.value)}><option value="both">Prefill / Decode</option><option value="prefill">Prefill</option><option value="decode">Decode</option></select></label></div>
    <label>峰值覆盖来源<input aria-label="峰值覆盖来源" value={description} onChange={e=>setDescription(e.target.value)} placeholder="说明测量、估计或预算的来源与假设"/></label><label><input aria-label="使用峰值公式" type="checkbox" checked={advanced} onChange={e=>setAdvanced(e.target.checked)}/>使用固定公式／符号表达式</label>{advanced?<><label>峰值 ValueExpr JSON<textarea aria-label="峰值 ValueExpr JSON" value={expression} onChange={e=>setExpression(e.target.value)}/></label><p className="scope-note">使用项目内 formula 固定修订，输出须为非负整数 byte。绑定可引用工作负载字段和模型根参数；容量搜索及每次 decode 调用重新绑定。JSON 格式与存储分配 ValueExpr 相同。</p></>:<label>覆盖峰值 byte<input aria-label="覆盖峰值 byte" type="number" min="0" step="1" value={bytes} onChange={e=>setBytes(e.target.value)}/></label>}
    <button onClick={add}>添加总峰值覆盖</button>{error&&<p role="alert" className="field-error">{error}</p>}
  </section>;
}
