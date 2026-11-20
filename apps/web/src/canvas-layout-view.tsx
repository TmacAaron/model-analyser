import { useDeferredValue,useEffect,useMemo,useRef,useState,type ReactNode } from 'react';
import type { AnalysisResult,ParallelResolution,Shape } from '@model-analyser/contracts';
import { focusIdentity,type AnalysisFocus } from './analysis-focus.js';
import type { AnalysisExportSelection } from './analysis-export.js';
import { useDisplayUnits } from './display-units.js';
import { StudyEvidenceDetails,StudyEvidencePager } from './study-evidence.js';
import type { useTheoreticalAnalysis } from './use-theoretical-analysis.js';

type Layout=ParallelResolution;
type Placement=Layout['tensorLayouts'][number]['partition']['placements'][number];
type AnalysisExporter=Pick<ReturnType<typeof useTheoreticalAnalysis>,'exportFile'|'exportState'|'cancelExport'>;
type EvidenceGroup='tensor'|'storage'|'compute'|'communication'|'missing';
const groups:Record<EvidenceGroup,string>={tensor:'局部张量',storage:'规范存储',compute:'逐卡算子成本',communication:'实际通信',missing:'未配置与诊断'};
const dimensions=(shape:Shape)=>shape.map(axis=>axis.axisId+'='+(axis.size.kind==='literal'?axis.size.quantity.value:'未求值')).join(' × ')||'标量';
const ruleText=(indices:readonly number[])=>indices.map(index=>'#'+(index+1)).join(', ')||'—';

function EvidenceList<T>({items,size=20,label,render}:{items:readonly T[];size?:number;label:string;render:(item:T,index:number)=>ReactNode}){
  const [page,setPage]=useState(0);
  const current=Math.min(page,Math.max(0,Math.ceil(items.length/size)-1));
  if(!items.length)return <p className="scope-note">当前范围没有{label}记录。</p>;
  return <>
    <StudyEvidencePager page={current} size={size} total={items.length} label={label} onChange={setPage}/>
    {items.slice(current*size,(current+1)*size).map((item,index)=>render(item,current*size+index))}
  </>;
}

function DevicePlacements({items}:{items:readonly Placement[]}){
  return <EvidenceList label="分片设备" items={items} size={12} render={device=><p key={device.deviceId}>
    <strong>{device.deviceId}</strong> · 逻辑 {dimensions(device.logicalShape)} · 分配 {dimensions(device.allocatedShape)}
    <small>{device.logicalElements} / {device.allocatedElements} 元素 · {device.copies} 份</small>
    <small>{device.slices.map(slice=>slice.axisId+' ['+slice.start+', '+slice.end+')').join(' · ')||'无轴切片记录'}</small>
  </p>}/>;
}

function TensorRow({row}:{row:Layout['tensorLayouts'][number]}){
  const {partition}=row;
  return <StudyEvidenceDetails summary={row.nodeId+' → '+row.tensorId+' · '+partition.distribution.kind+' / '+partition.groupId}
    render={()=><><p>全局维度 {dimensions(partition.globalShape)} · 生效规则 {ruleText(row.assignmentIndices)} · 覆盖 {ruleText(row.overriddenIndices)}</p>
      <DevicePlacements items={partition.placements}/></>}/>;
}

function StorageRow({row}:{row:Layout['storageAllocations'][number]}){
  const display=useDisplayUnits();
  return <StudyEvidenceDetails summary={row.storageId+' · '+row.category+' · '+row.allocation.distribution.kind}
    render={()=><>
      <p>引用 {row.aliasIds.join(', ')||'—'} · 生效规则 {ruleText(row.assignmentIndices)}</p>
      {row.allocation.materialization==='elided'&&<p>融合已取消物化。</p>}
      <EvidenceList items={row.allocation.perDevice} size={12} label="分配设备" render={device=><div key={device.deviceId}>
        <p><strong>{device.deviceId}</strong> · {display.metric(device.totalBytes)} · {device.copies} 份</p>
        <StudyEvidenceDetails summary="每份分配与辅助数据" render={()=><>
          <p>每份 payload {display.metric(device.allocation.payloadBytes)}</p>
          <EvidenceList items={device.allocation.auxiliaryBytes} size={12} label="辅助分配" render={(aux,index)=><p key={aux.name+':'+index}>{aux.name} · {display.metric(aux.bytes)}</p>}/>
        </>}/>
      </div>}/>
    </>}/>;
}

function ComputeRow({row,diagnostics}:{row:Layout['localCosts']['nodes'][number];diagnostics:ReadonlyMap<string,string>}){
  const display=useDisplayUnits(),{placement}=row;
  return <StudyEvidenceDetails summary={row.nodeId+' · 局部成本'} render={()=>{
    if(placement.kind==='unplaced')return <p>{placement.diagnosticIds.map(id=>diagnostics.get(id)??id).join('；')}</p>;
    if(placement.kind==='no_work')return <p>已声明零资源的元数据或控制节点。</p>;
    return <EvidenceList items={placement.perDevice} size={12} label="计算设备" render={device=>{
      const {outcome}=device;
      return <div key={device.deviceId}>
        <p><strong>{device.deviceId}</strong>{outcome.status==='unavailable'?' · '+outcome.diagnosticIds.map(id=>diagnostics.get(id)??id).join('；'):
          ' · HBM '+display.metric(outcome.cost.hbmBytes)+' · 声明耗时 '+display.metric(outcome.cost.seconds)}</p>
        {outcome.status==='available'&&<>
          <EvidenceList items={outcome.cost.compute} size={12} label="计算分类" render={(cost,index)=><p key={index}>
            {cost.computeClass.resource} {cost.computeClass.resourceKey} · {cost.computeClass.multiplyDtype.format}/{cost.computeClass.accumulateDtype.format} · 有效 {display.metric(cost.usefulOperations)} · 执行 {display.metric(cost.executedOperations)}
          </p>}/>
          <StudyEvidenceDetails summary="本设备实际参数" render={()=><EvidenceList items={outcome.bindings} size={12} label="参数" render={binding=><p key={binding.symbol}>
            {binding.symbol} = {display.quantity(binding.quantity.value,binding.quantity.unit)} · {binding.source.kind} · {'tensorId' in binding.source?binding.source.tensorId:binding.source.storageId}
            {'axisId'in binding.source?' · '+binding.source.axisId:''}{'basis'in binding.source?' · '+binding.source.basis:''}{'edge'in binding.source?' · '+binding.source.edge:''}
          </p>}/>}/>
        </>}
      </div>;
    }}/>;
  }}/>;
}

function CommunicationRow({row}:{row:Layout['communications'][number]}){
  const display=useDisplayUnits(),{evaluation}=row;
  const {definition}=evaluation, totals=evaluation.cost.communications[0];
  const node=communicationNode(row);
  return <StudyEvidenceDetails summary={'#'+(row.index+1)+' '+definition.operation+' · '+(node??'方案层通信')} render={()=><>
    <p>{evaluation.source.tensorId} → {evaluation.destination.tensorId} · {definition.groupId} · 网络跨度 {display.metric(evaluation.cost.seconds)}</p>
    <p>组发送 {display.metric(totals?.groupSendBytes)} · 组接收 {display.metric(totals?.groupReceiveBytes)} · {definition.algorithm.name}</p>
    {definition.temporaryStorageIds?.length?<small>临时存储 {definition.temporaryStorageIds.join(', ')}</small>:null}
    <EvidenceList items={evaluation.perDevice} size={12} label="通信设备" render={device=><p key={device.deviceId}>
      <strong>{device.deviceId}</strong> · 发送 {display.metric(device.sendBytes)} · 接收 {display.metric(device.receiveBytes)} · 算法流量 {display.metric(device.algorithmTrafficBytes)}
    </p>}/>
    <StudyEvidenceDetails summary="通信前分片" render={()=> <DevicePlacements items={evaluation.source.placements}/>}/>
    <StudyEvidenceDetails summary="通信后分片" render={()=> <DevicePlacements items={evaluation.destination.placements}/>}/>
  </>}/>;
}

function communicationNode(row:Layout['communications'][number]){
  return row.origin?.nodeId??row.evaluation.definition.placement?.nodeId;
}

function layoutSelection(layout:Layout,analysis:AnalysisResult,focus:AnalysisFocus|undefined){
  if(focus?.reason)return {message:focus.reason};
  const target=focus?.target;
  if(!focus||target?.kind==='model')return {};
  if(target?.kind==='module'){
    const module=analysis.modules.find(item=>item.nodeId===target.nodeId);
    if(module)return {nodes:new Set<string>(module.leafNodeIds)};
  }else if(target?.kind==='node'){
    const fusion=layout.fusions.find(item=>item.application.nodeId===target.nodeId);
    if(fusion)return {nodes:new Set<string>(fusion.application.memberNodeIds)};
    if(analysis.nodes.some(item=>item.nodeId===target.nodeId)||layout.communications.some(item=>communicationNode(item)===target.nodeId)){
      return {nodes:new Set<string>([target.nodeId])};
    }
  }
  return {message:'当前步骤没有该画布目标的布局记录。'};
}

function LayoutEvidence({layout,analysis,focus}:{layout:Layout;analysis:AnalysisResult;focus:AnalysisFocus|undefined}){
  const identity=focusIdentity(focus);
  const [choice,setChoice]=useState<{identity:string;scope:'all'|'selected'}>();
  const [group,setGroup]=useState<EvidenceGroup>('tensor'),[query,setQuery]=useState('');
  const scope=choice?.identity===identity?choice.scope:focus?.target?.kind==='model'?'all':'selected';
  const term=useDeferredValue(query.trim().toLocaleLowerCase());
  const selected=useMemo(()=>layoutSelection(layout,analysis,scope==='all'?undefined:focus),[layout,analysis,identity,scope]);
  const diagnostics=useMemo(()=>new Map(layout.diagnostics.map(diagnostic=>[diagnostic.diagnosticId,diagnostic.message])),[layout]);
  const rows=useMemo(()=>{
    const matchesNode=(nodeId:string)=>!selected.nodes||selected.nodes.has(nodeId);
    const matches=(...parts:string[])=>!term||parts.some(part=>part.toLocaleLowerCase().includes(term));
    const hasStorageUse=(nodeIds:readonly string[])=>!selected.nodes||nodeIds.some(matchesNode);
    return {
      tensor:group==='tensor'?layout.tensorLayouts.filter(item=>matchesNode(item.nodeId)&&matches(item.nodeId,item.tensorId)):[],
      storage:group==='storage'?layout.storageAllocations.filter(item=>hasStorageUse(item.nodeIds)&&matches(item.storageId,...item.aliasIds)):[],
      storageRules:group==='storage'?layout.storageLayouts.filter(item=>matchesNode(item.nodeId)&&matches(item.nodeId,item.storageId)):[],
      compute:group==='compute'?layout.localCosts.nodes.filter(item=>matchesNode(item.nodeId)&&matches(item.nodeId)):[],
      communication:group==='communication'?layout.communications.filter(item=>{
        const node=communicationNode(item);
        return (node?matchesNode(node):!selected.nodes)&&matches(node??'',item.evaluation.definition.operation,item.evaluation.source.tensorId,item.evaluation.destination.tensorId);
      }):[],
      missing:group==='missing'?layout.unassignedTensorUses.filter(item=>matchesNode(item.nodeId)&&matches(item.nodeId,item.tensorId)):[],
    };
  },[layout,selected,group,term]);
  const listKey=[identity,scope,term].join('\0');
  return <>
    <div className="layout-evidence-controls">
      <label>布局范围<select aria-label="布局范围" value={scope} onChange={event=>setChoice({identity,scope:event.target.value==='all'?'all':'selected'})}>
        <option value="all">整个模型</option><option value="selected">画布选择 · {focus?.label??'当前范围'}</option>
      </select></label>
      <label>布局证据<select aria-label="布局证据" value={group} onChange={event=>{setGroup(event.target.value as EvidenceGroup);setQuery('');}}>
        {Object.entries(groups).map(([id,label])=><option key={id} value={id}>{label}</option>)}
      </select></label>
    </div>
    {selected.message?<p role="status">{selected.message}</p>:<>
      <label>查找布局证据<input type="search" aria-label="查找布局证据" value={query} onChange={event=>setQuery(event.target.value)}/></label>
      {group==='tensor'&&<EvidenceList key={listKey} label="局部张量" items={rows.tensor} render={row=><TensorRow key={row.nodeId+':'+row.tensorId} row={row}/>}/>}
      {group==='storage'&&<>
        <EvidenceList key={listKey} label="规范存储" items={rows.storage} render={row=><StorageRow key={row.storageId} row={row}/>}/>
        <StudyEvidenceDetails summary={'存储布局规则 · '+rows.storageRules.length} render={()=> <EvidenceList key={listKey} items={rows.storageRules} label="存储布局规则" render={row=><p key={row.nodeId+':'+row.storageId}>
          {row.nodeId} → {row.storageId} · {row.distribution.kind} / {row.distribution.groupId} · 生效 {ruleText(row.assignmentIndices)} · 覆盖 {ruleText(row.overriddenIndices)}
        </p>}/>}/>
      </>}
      {group==='compute'&&<EvidenceList key={listKey} label="逐卡算子" items={rows.compute} render={row=><ComputeRow key={row.nodeId} row={row} diagnostics={diagnostics}/>}/>}
      {group==='communication'&&<EvidenceList key={listKey} label="显式通信" items={rows.communication} render={row=><CommunicationRow key={row.index} row={row}/>}/>}
      {group==='missing'&&<>
        <EvidenceList key={listKey} label="未配置节点使用" items={rows.missing} render={item=><p key={item.nodeId+':'+item.tensorId}>{item.nodeId} → {item.tensorId}</p>}/>
        {scope==='all'&&<>
          <StudyEvidenceDetails summary={'未配置存储 · '+layout.unassignedStorageIds.length} render={()=> <EvidenceList items={layout.unassignedStorageIds} label="未配置存储" render={id=><p key={id}>{id}</p>}/>}/>
          <StudyEvidenceDetails summary={'未配置张量 · '+layout.unassignedTensorIds.length} render={()=> <EvidenceList items={layout.unassignedTensorIds} label="未配置张量" render={id=><p key={id}>{id}</p>}/>}/>
          <StudyEvidenceDetails summary={'完整布局诊断 · '+layout.diagnostics.length} render={()=> <EvidenceList items={layout.diagnostics} label="诊断" render={diagnostic=><p key={diagnostic.diagnosticId}>{diagnostic.code} · {diagnostic.message}</p>}/>}/>
        </>}
      </>}
    </>}
  </>;
}

export function CanvasLayoutView({result,focus,request,exporter}:{result:AnalysisResult;focus:AnalysisFocus|undefined;request:number|undefined;exporter:AnalysisExporter}){
  const [open,setOpen]=useState(Boolean(request)),[index,setIndex]=useState(0),section=useRef<HTMLDetailsElement>(null);
  const {decode}=result;
  const step=decode?.steps.find(item=>item.index===index),frame=decode?step?.result:result,layout=frame?.distributed?.layout;
  const needsLayout=Boolean(request)||Boolean(result.distributed)||Boolean(decode?.steps.some(item=>item.result.distributed));
  useEffect(()=>{
    if(request){setOpen(true);section.current?.scrollIntoView({block:'start'});}
  },[request]);
  if(!needsLayout)return null;
  const state=exporter.exportState?.selection.kind==='layout'?exporter.exportState:undefined;
  const selection:AnalysisExportSelection|undefined=layout?{kind:'layout',index:step?.index??null,inputHash:layout.inputHash}:undefined;
  return <details className="canvas-layout-evidence" ref={section} open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>设备布局与通信</summary>
    {open&&<>
      {decode&&<label>布局 Decode 步骤<select aria-label="布局 Decode 步骤" value={index}
        onChange={event=>{if(state?.status==='running')exporter.cancelExport();setIndex(Number(event.target.value));}}>
        {!step&&<option value={index} disabled>步骤 {index+1} 不可用</option>}
        {decode.steps.map(item=><option key={item.index} value={item.index}>步骤 {item.index+1} · context {item.evaluatedContext}</option>)}
      </select></label>}
      {layout&&frame?<>
        <p className="scope-note">{step?'实际 Decode 步骤 '+(step.index+1)+' · ':''}input <code>{layout.inputHash.slice(0,20)}…</code></p>
        {selection&&<button type="button" disabled={exporter.exportState?.status==='running'} onClick={()=>exporter.exportFile(selection)}>导出完整布局 JSON</button>}
        {state?.status==='running'&&<><p role="status">正在后台生成布局 JSON…</p><button type="button" onClick={exporter.cancelExport}>取消布局导出</button></>}
        {state?.status==='cancelled'&&<p role="status">布局导出已取消。</p>}
        {state?.status==='error'&&<p role="alert">{state.message}</p>}
        <LayoutEvidence key={layout.inputHash} layout={layout} analysis={frame} focus={focus}/>
      </>:<p role="status">当前计算没有分布式布局记录。可在“并行方式”配置设备分片后重新计算。</p>}
    </>}
  </details>;
}
