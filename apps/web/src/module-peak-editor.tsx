import { useDisplayUnits } from './display-units.js';
import { useEffect,useMemo,useState } from 'react';
import { ModulePeakOverride,type Scenario,type AssetDocument,type ResolvedGraph } from '@model-analyser/contracts';
import {useModelInstantiation} from './use-model-instantiation.js';
import { validateScenario } from '../../../packages/contracts/src/scenario-validation.js';
import { canonical,collectRefs } from '../../../packages/contracts/src/validation.js';

export function ModulePeakEditor({scenario,assets,onChange,resolved:provided,selection,resolveIfMissing=true}:{scenario:Scenario;assets:AssetDocument[];onChange:(next:Scenario)=>void;resolved?:ResolvedGraph|undefined;selection?:string|undefined;resolveIfMissing?:boolean}){
  const display=useDisplayUnits();

  const fallbackKey=useMemo(()=>provided||!resolveIfMissing?'external':canonical({scenario,assets}),[scenario,assets,provided,resolveIfMissing]),expansion=useModelInstantiation(!provided&&resolveIfMissing?scenario:undefined,assets,fallbackKey),resolved=provided??(expansion.attempt?.status==='available'?expansion.attempt.resolved:undefined);
  const choices=resolved?.containers.filter(c=>c.nodeId!=='$model'&&resolved.objectBindings.some(b=>b.nodeId===c.nodeId)&&!resolved.graph.nodes.some(n=>n.nodeId===c.nodeId)&&assets.some(a=>a.assetId===c.asset.assetId&&a.revision===c.asset.revision&&(a.definition.kind==='module'||a.definition.kind==='model')))??[];
  const [target,setTarget]=useState(selection??''),[phase,setPhase]=useState(scenario.workload.kind),[bytes,setBytes]=useState(''),[description,setDescription]=useState(''),[advanced,setAdvanced]=useState(false),[expression,setExpression]=useState(''),[error,setError]=useState('');
  useEffect(()=>{if(selection)setTarget(selection);},[selection]);
  useEffect(()=>{setPhase(scenario.workload.kind);setError('');},[scenario.scenarioId,scenario.workload.kind]);
  const selected=choices.some(c=>c.nodeId===target)?target:choices[0]?.nodeId??'';
  function add(){try{
    const container=choices.find(c=>c.nodeId===selected);if(!container)throw Error('请选择当前阶段的实际模块调用；重复层请进入具体层实例');if(!description.trim())throw Error('请填写模块私有预算的来源和假设');if(!advanced&&(bytes.trim()===''||!Number.isSafeInteger(Number(bytes))||Number(bytes)<0))throw Error('请输入非负安全整数 byte');
    const rule=ModulePeakOverride.parse({overrideId:crypto.randomUUID(),nodeId:selected,phases:[phase],peakBytes:advanced?JSON.parse(expression):{kind:'literal',quantity:{value:Number(bytes),unit:'byte'}},description:description.trim()});
    for(const ref of collectRefs(rule))if(ref.kind!=='formula'||!assets.some(a=>a.assetId===ref.assetId&&a.revision===ref.revision&&a.definition.kind==='formula'))throw Error('公式必须引用工作区内固定修订');
    for(const old of scenario.modulePeakOverrides??[])if(old.phases.includes(phase)){const members=resolved?.containers.find(c=>c.nodeId===old.nodeId)?.leafNodeIds??[];if(members.some(id=>container.leafNodeIds.includes(id)))throw Error('该调用已有相同或嵌套覆盖，请先移除重叠规则');}
    for(const f of resolved?.fusionApplications??[])if(f.memberNodeIds.some(id=>container.leafNodeIds.includes(id))&&!f.memberNodeIds.every(id=>container.leafNodeIds.includes(id)))throw Error('现有融合横跨模块边界，请调整融合或覆盖范围');
    const next={...scenario,modulePeakOverrides:[...(scenario.modulePeakOverrides??[]),rule]},issues=validateScenario(next,assets).filter(d=>d.severity==='error');if(issues.length)throw Error(issues.map(d=>d.message).join('；'));onChange(next);setBytes('');setDescription('');setExpression('');setError('');
  }catch(e){setError(e instanceof Error?e.message:String(e));}}
  return <section className="module-peak-editor"><h3>模块私有峰值预算</h3>{!provided&&resolveIfMissing&&<>{expansion.pending&&<p role="status">正在后台展开模块范围…<button onClick={expansion.cancel}>取消模块范围展开</button></p>}{(expansion.cancelled||expansion.error)&&<p role="status">{expansion.error??'模块范围展开已取消'}<button onClick={expansion.retry}>重新展开模块范围</button></p>}{expansion.attempt?.status==='unavailable'&&<p role="alert">{expansion.attempt.diagnostics.map(d=>d.message).join('；')}</p>}</>}{!resolved&&!resolveIfMissing&&<p role="status" className="scope-note">模型结构就绪后可选择模块范围；未完成输入会保留。</p>}<p className="scope-note">选择画布中的实际模块调用。仅替换归属明确的私有激活／临时对象；权重、KV、输入输出、跨模块共享对象保留。预算在整个调用跨度内预留，重叠调用叠加；这是保守估计，原理论与替换清单可在分析结果核对。</p>
    {(scenario.modulePeakOverrides??[]).map((r,i)=><div className="peak-override-rule" key={r.overrideId}><strong>{r.nodeId}</strong> · {r.phases.join('/')} · {r.peakBytes.kind==='literal'?display.quantity(r.peakBytes.quantity.value,r.peakBytes.quantity.unit):'公式／符号'} · {r.description}<button onClick={()=>{const {modulePeakOverrides,...base}=scenario,rules=modulePeakOverrides?.filter((_,n)=>i!==n);onChange(rules?.length?{...base,modulePeakOverrides:rules}:base);}}>移除模块峰值覆盖</button></div>)}
    <label>模块峰值目标<select aria-label="模块峰值目标" value={selected} onChange={e=>setTarget(e.target.value)}>{!choices.length&&<option value="">{!resolved?'模型结构尚未就绪':'当前图无可配置的实际模块调用'}</option>}{choices.map(c=><option key={c.nodeId} value={c.nodeId}>{c.name} · {c.nodeId}</option>)}</select></label>
    <label>模块峰值阶段<select aria-label="模块峰值阶段" value={phase} onChange={e=>setPhase(e.target.value==='decode'?'decode':'prefill')}><option value="prefill">Prefill</option><option value="decode">Decode</option></select></label>
    <label>模块峰值来源<input aria-label="模块峰值来源" value={description} onChange={e=>setDescription(e.target.value)} placeholder="说明私有分配预算的来源与假设"/></label>
    <label><input aria-label="使用模块峰值公式" type="checkbox" checked={advanced} onChange={e=>setAdvanced(e.target.checked)}/>使用固定公式／符号表达式</label>{advanced?<><label>模块峰值 ValueExpr JSON<textarea aria-label="模块峰值 ValueExpr JSON" value={expression} onChange={e=>setExpression(e.target.value)}/></label><p className="scope-note">输出为非负安全整数 byte；按本模块有效参数和当前工作负载绑定。每次 decode 调用、容量候选点重新求值。</p></>:<label>模块私有峰值 byte<input aria-label="模块私有峰值 byte" type="number" min="0" step="1" value={bytes} onChange={e=>setBytes(e.target.value)}/></label>}
    <button disabled={!selected} onClick={add}>添加模块峰值覆盖</button>{error&&<p role="alert" className="field-error">{error}</p>}
  </section>;
}
