import { useDisplayUnits } from './display-units.js';
import { useEffect,useState } from 'react';
import { NodeId,type Scenario,type AssetRef,type ResolvedGraph } from '@model-analyser/contracts';
type Selector=Scenario['quantizationOverrides'][number]['selector'];
export type QuantizationPresetChoice={ref:AssetRef;name:string;weightPresetModel?:AssetRef;weightPresetExecution?:boolean};
export function QuantizationEditor({scenario,presets,onApply,onRemove,selection}:{scenario:Scenario;presets:QuantizationPresetChoice[];onApply:(ref:AssetRef,selector:Selector)=>Promise<void>;onRemove:(index:number)=>void;selection?:string[]}){
  const [selected,setSelected]=useState(''),[scope,setScope]=useState('$model'),[kind,setKind]=useState('subtree'),[busy,setBusy]=useState(false),[error,setError]=useState(''),key=(ref:AssetRef)=>ref.assetId+'@'+ref.revision;
  const formats=presets.filter(p=>p.weightPresetModel&&key(p.weightPresetModel)===key(scenario.model));
  const customPresets=presets.filter(p=>!p.weightPresetModel);
  const current=customPresets.find(p=>key(p.ref)===selected)??customPresets[0];
  const activeFormat=scenario.quantizationOverrides.findIndex(({preset})=>preset&&formats.some(choice=>key(preset)===key(choice.ref)));
  const chosenFormat=scenario.quantizationOverrides[activeFormat]?.preset;
  const native=chosenFormat&&formats.some(p=>key(p.ref)===key(chosenFormat)&&p.weightPresetExecution);
  const selectionKey=selection?.join(',');useEffect(()=>{if(selectionKey!==undefined){setScope(selectionKey||'$model');setKind(selection&&selection.length>1?'nodes':'subtree');}},[selectionKey]);
  async function apply(choice=current){if(!choice)return;setBusy(true);setError('');try{
    if(choice.weightPresetModel){await onApply(choice.ref,{kind:'subtree',rootNodeId:NodeId.parse('$model')});return;}
    const ids=scope.split(',').map(s=>s.trim()).filter(Boolean);
    if(!ids.length||(kind==='subtree'&&ids.length!==1))throw Error('子树填写一个稳定路径；节点列表可用逗号分隔。');
    const selector:Selector=kind==='subtree'?{kind:'subtree',rootNodeId:NodeId.parse(ids[0])}:{kind:'nodes',nodeIds:ids.map(id=>NodeId.parse(id))};
    await onApply(choice.ref,selector);
  }catch(e){setError(e instanceof Error?e.message:'量化预设载入失败');}finally{setBusy(false);}}
  const custom=<><p className="scope-note">预设固定到项目快照，只修改当前方案。存储位宽与内部计算精度分别配置。</p><div className="quantization-form"><label>量化预设<select aria-label="量化预设" value={current?key(current.ref):''} disabled={busy} onChange={e=>setSelected(e.target.value)}>{!customPresets.length&&<option value="">暂无量化资产</option>}{customPresets.map(p=><option key={key(p.ref)} value={key(p.ref)}>{p.name} · r{p.ref.revision}</option>)}</select></label><label>作用方式<select aria-label="量化作用方式" value={kind} disabled={busy} onChange={e=>setKind(e.target.value)}><option value="subtree">子树</option><option value="nodes">节点列表</option></select></label><label>量化作用范围<input aria-label="量化作用范围" value={scope} disabled={busy} onChange={e=>setScope(e.target.value)}/></label><button disabled={busy||!current} onClick={()=>void apply()}>{busy?'载入中…':'添加量化覆盖'}</button></div></>;
  return <section className="quantization-editor"><h3>{formats.length?'量化模式':'方案量化覆盖'}</h3>
    {formats.length>0&&<div className="quantization-form" aria-label="发布权重格式" role="group">
      <button type="button" aria-pressed={activeFormat<0} disabled={busy||activeFormat<0} onClick={()=>onRemove(activeFormat)}>原始权重</button>
      {formats.map(format=>{const active=chosenFormat!==undefined&&key(chosenFormat)===key(format.ref);
        return <button type="button" key={key(format.ref)} aria-pressed={active} disabled={busy||active} onClick={()=>void apply(format)}>{format.name}</button>;
      })}
      <small>{native?'FP8 矩阵 · 动态激活缩放':'理论计算沿用模型的计算精度'}</small>
    </div>}
    {formats.length>0?<details><summary>自定义量化</summary>{custom}</details>:custom}
    {error&&<p className="error" role="alert">{error}</p>}
    {scenario.quantizationOverrides.map((rule,index)=>index!==activeFormat&&<div className="quantization-rule" key={index}><span>#{index+1} · {rule.selector.kind==='subtree'?rule.selector.rootNodeId:rule.selector.nodeIds.join(', ')} · {(['weight','activation','state'] as const).flatMap(k=>rule[k]?[k+' '+rule[k].payloadBits+' bit']:[]).join(' / ')}{rule.preset?' · '+rule.preset.assetId+'@'+rule.preset.revision:rule.importOrigin?' · Ascend '+rule.importOrigin.sourceKey:' · 自定义'}{rule.storageIds?' · 精确存储 '+rule.storageIds.join(', '):''}</span><button aria-label={'移除量化覆盖 #'+(index+1)} onClick={()=>onRemove(index)}>移除</button></div>)}
  </section>;
}
export function QuantizationApplications({applications}:{applications:ResolvedGraph['quantizationApplications']}){
  const display=useDisplayUnits();
if(!applications.length)return null;return <div className="quantization-results"><h3>生效量化与来源</h3><p className="scope-note">下表显示全局存储格式。分片在每卡重新打包。计算精度与转换按算子的执行规则计算。</p><div className="analysis-table"><table><thead><tr><th>规范存储 / 类别</th><th>payload / 辅助项</th><th>全局格式分配</th><th>生效 / 被覆盖规则</th></tr></thead><tbody>{applications.map(a=><tr key={a.storageId}><td><code>{a.storageId}</code><small>{a.category}</small></td><td>{a.specification.payloadBits} bit<small>{a.specification.auxiliaries.map(v=>v.name+' '+v.dtype.bits+' bit / '+v.count.kind+(v.count.kind==='formula'&&v.count.value.kind==='literal'?' → '+v.count.value.quantity.value+' '+v.count.value.quantity.unit+'（原调用已绑定）':'')).join(', ')||'无辅助项'}</small></td><td>{display.bytes(a.beforeBytes)} → {display.bytes(a.afterBytes)}{a.allocationOverridden&&<small>最终显式覆盖 {a.allocationOverrideBytes===undefined?'未知':display.bytes(a.allocationOverrideBytes)} / 分配</small>}</td><td>{a.importOrigins?.map(o=><details key={o.importId+':'+o.sourceKey}><summary>Ascend来源 · {o.sourceName}</summary><p>{o.sourceKey} · {o.sourceLabel}</p><p>SHA256 {o.sourceHash}</p><p>{o.note}</p></details>)}{a.assignmentIndices.map(i=>'#'+(i+1)).join(', ')}<small>覆盖：{a.overriddenIndices.map(i=>'#'+(i+1)).join(', ')||'—'}</small></td></tr>)}</tbody></table></div></div>;}
