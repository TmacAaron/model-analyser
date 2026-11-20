import {useMemo,useState} from 'react';
import type {LayoutSourceReport,LayoutSourceRequest,LayoutSourceSelector} from '@model-analyser/core';
import {canonical} from '../../../packages/contracts/src/validation.js';
import {FormulaProof} from './declaration-source-view.js';
import {readLayoutSourceReply} from './layout-source-task.js';
import {useCostSourceWorker} from './use-cost-source-worker.js';

export type LayoutSourceAnchor=Pick<LayoutSourceRequest,'scenario'|'assets'|'inputHash'|'engineVersion'|'stepContext'>;

function save(report:LayoutSourceReport){
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
 const link=document.createElement('a');
 link.href=url;link.download=`model-analyser-layout-source-page-${report.page+1}.json`;link.click();URL.revokeObjectURL(url);
}

export function LayoutSourceView({anchor,selector}:{anchor:LayoutSourceAnchor;selector:LayoutSourceSelector}){
 const selectorKey=canonical(selector),identity=useMemo(()=>({}),[selectorKey,anchor.scenario,anchor.assets,anchor.inputHash,anchor.engineVersion,anchor.stepContext]);
 const [open,setOpen]=useState(false),[cursor,setCursor]=useState({owner:identity,page:0});
 const page=cursor.owner===identity?cursor.page:0;
 const request=useMemo<LayoutSourceRequest>(()=>({...anchor,selector,page}),[identity,page]);
 const {state,cancel,retry}=useCostSourceWorker(open,request,'layout_source',readLayoutSourceReply);
 const storage=selector.kind==='storage',label=storage?'逐卡分配推导':'逐卡张量布局推导';
 return <section className="layout-source declaration-source" aria-label={label}>
  {!open?<button onClick={()=>{setCursor({owner:identity,page:0});setOpen(true);}}>{storage?'复核此卡的分配推导':'复核此卡的张量布局'}</button>:
   state.status==='running'?<><p role="status">正在后台复核{label}…</p><button onClick={cancel}>取消布局复核</button></>:
   state.status==='available'?<><LayoutProof report={state.report}/><div className="button-row">
    {page>0&&<button onClick={()=>setCursor({owner:identity,page:page-1})}>上一页布局来源</button>}
    {(page+1)*state.report.pageSize<state.report.componentCount&&<button onClick={()=>setCursor({owner:identity,page:page+1})}>下一页布局来源</button>}
    <button onClick={()=>save(state.report)}>导出此页布局来源</button><button onClick={()=>setOpen(false)}>关闭布局来源</button>
   </div></>:<><p role="status">{state.status==='error'?state.message:'布局复核已取消。'}</p><button onClick={retry}>重试布局复核</button></>}
 </section>;
}

const layouts={replicated:'复制',partial:'待归约',sharded:'分片',manual:'手工分配'};
const scopeNames={global:'全局元素',logical:'局部有效元素',allocated:'局部分配元素'};
const methodNames={whole:'完整维度',manual:'手工指定',explicit:'显式切片',even:'均匀分片',padded:'填充分片'};
const ruleStates={selected:'生效',equivalent:'同级等价',overridden:'被覆盖'};
const originLabels={explicit_storage:'显式存储分布',inferred_from_tensor:'由张量分布推导',verified_backing:'显式底层分配核对'};
const quantizationStage={effective:'参与当前分配',overridden:'随后被字节数覆盖',elided:'随后取消物化'};

function LayoutProof({report}:{report:LayoutSourceReport}){
 const {selector,storage,tensor,group,origin,distribution}=report;
 return <div className="storage-access-proof">
  <h5><code>{selector.kind==='tensor'?selector.tensorId:selector.storageId}</code> · {selector.deviceId}</h5>
  <p>{layouts[distribution.kind]} · 设备组 {group.groupId} · {group.memberCount} 台 · 第 {report.page+1} 页</p>
  {group.axes&&<p>{group.axes.map((axis,index)=>axis.axisId+' '+(group.coordinates?.[index]??'—')+'/'+axis.size).join(' · ')}</p>}
  {report.syntheticBaseline&&<p>单设备完整对象布局，由当前分析生成。</p>}
  {report.preset&&<p>来自并行预设 {report.preset.presetId}</p>}
  {origin?<p>原对象声明 <code>{origin.asset.assetId}@r{origin.asset.revision}</code> · {origin.nodeId}</p>:<p>使用展开图中对象的生效维度。</p>}
  {tensor&&<p>已复核 {tensor.logicalElements} 个有效元素 · {tensor.allocatedElements} 个分配元素 · {tensor.copies} 份</p>}
  {storage&&<>
   <p>{storage.totalBytes===undefined?'本卡分配不可用':`已复核分配 ${storage.totalBytes} byte`}{storage.perCopyBytes===undefined?'':` · 每副本 ${storage.perCopyBytes} byte × ${storage.copies}`}</p>
   {storage.elidedBy&&<p>由融合组 {storage.elidedBy} 取消物化。</p>}
   {storage.override&&<p>分配覆盖 #{storage.override.overrideIndex+1} · {storage.override.override.value.value} byte/副本</p>}
   {storage.quantization&&<p>{storage.quantization.payloadBits} bit · 按 {storage.quantization.packingUnitElements} 个元素打包 · 按 {storage.quantization.alignmentBytes} byte 对齐 · {quantizationStage[storage.quantization.stage]}{storage.quantization.ruleIndex===undefined?'':` · 量化规则 #${storage.quantization.ruleIndex+1} · ${storage.quantization.nodeId}`}</p>}
  </>}
  {(report.allocationTruncated||report.quantizationTruncated)&&<p>来源记录达到预算，实际分配已完整复算。</p>}
  {report.diagnostics.map(d=> <p key={d.diagnosticId}>{d.message}</p>)}
  {report.items.map((item,index)=><article className="storage-access-item" key={index}><Term item={item}/></article>)}
 </div>;
}

function allocationExpression(operation:string,inputs:number[]){
 const [a,b,c]=inputs;
 switch(operation){
  case 'multiply':return `${a} × ${b}`;
  case 'ceil_multiple':return `ceil(${a} ÷ ${b}) × ${b}`;
  case 'ceil_bits_div8':return `ceil(${a} × ${b} ÷ 8)`;
  case 'multiply_ceil_div':return `${a} × ceil(${b} ÷ ${c})`;
  case 'declared_group':return `ceil(${a} ÷ ${b})`;
  case 'declared_tensor':return a===0?'空张量 → 0':'非空张量 → 1';
  case 'declared_channel':return a===0?'空张量 → 0':`通道轴长度 ${b}`;
  case 'sum':return inputs.join(' + ');
  default:return inputs.join(' · ');
 }
}

function Term({item}:{item:LayoutSourceReport['items'][number]}){
 switch(item.kind){
 case 'rule':{
  const {rule}=item;
  return <><h5>{ruleStates[rule.status]}规则 #{rule.index+1} · {rule.nodeId}</h5><p>{rule.kind==='tensor'?'张量':'存储'} {rule.originalId} → <code>{rule.objectId}</code> · {layouts[rule.effective.kind]} · 优先级 {rule.priority} · 规则内第 {rule.entryIndex+1} 项</p>
   <p>匹配范围 {rule.selector.kind==='nodes'?rule.selector.nodeIds.join('、'):rule.selector.rootNodeId} · 对象定义范围 {rule.ownerNodeId}</p>
   {Object.entries(rule.axisMap).map(([from,to])=><small key={from}>轴 {from} → {to}</small>)}</>;
 }
 case 'origin':return <><h5>{originLabels[item.origin.kind]} · {item.origin.objectId}</h5><p>{item.origin.nodeId} · {layouts[item.origin.distribution.kind]} · {item.origin.indices.map(index=>'#'+(index+1)).join('、')}</p>
  {item.origin.capacity&&<p>局部需要 {item.origin.capacity.requiredBytes} byte ≤ 底层已分配 {item.origin.capacity.backingBytes} byte</p>}</>;
 case 'formula':return <><h5>{item.field}</h5><FormulaProof proof={item.formula.proof}/>{item.formula.truncated&&<p>公式记录达到预算，值已按完整表达式复算。</p>}</>;
 case 'partition':{
  const {operation}=item;
  if(operation.kind==='elements')return <><h5>{scopeNames[operation.scope]}</h5><p>{operation.dimensions.join(' × ')||'1'} = {operation.value}{operation.emptyAxis===undefined?'':' · 存在空维度'}</p></>;
  if(operation.kind==='explicit_coverage')return <p>{operation.rectangles} 个互斥分片坐标覆盖 {operation.covered}/{operation.globalElements} 个全局元素</p>;
  return <><h5>轴 {operation.axisId} · {methodNames[operation.method]}</h5>
   {operation.mesh&&<p>全局维度 {operation.extent} · mesh {operation.mesh.axisId} 坐标 {operation.mesh.rank} · 轴大小 {operation.mesh.width}</p>}
   {(operation.method==='even'||operation.method==='padded')&&operation.mesh&&<p>每卡分配 ceil({operation.extent} ÷ {operation.mesh.width}) = {operation.allocated}</p>}
   {(operation.method==='even'||operation.method==='padded')&&operation.mesh&&<p>起点 min({operation.extent}, {operation.mesh.rank} × {operation.allocated}) = {operation.start} · 终点 min({operation.extent}, {operation.start} + {operation.allocated}) = {operation.end}</p>}
   <p>{operation.start===undefined?'手工尺寸':`[${operation.start}, ${operation.end})`} · 有效 {operation.logical} · 分配 {operation.allocated}</p></>;
 }
 case 'allocation':return <><h5>{item.operation.field}</h5><p>{allocationExpression(item.operation.operation,item.operation.inputs)} = {item.operation.value} {item.operation.unit}</p><small>{item.operation.operation}</small></>;
 case 'copies':return <><h5>全部物理副本</h5><p>{item.perCopyBytes} × {item.copies} = {item.totalBytes} byte</p></>;
 case 'quantization':return <><h5>量化规则 · {item.nodeId}</h5><p>生效 {item.winners.map(rule=>'#'+(rule.ruleIndex+1)+' 优先级 '+rule.priority).join('、')||'沿用声明'}{item.losers.length?' · 被覆盖 '+item.losers.map(rule=>'#'+(rule.ruleIndex+1)).join('、'):''}</p></>;
 }
}
