import type {CanvasEditIntent,CanvasEditControls} from './canvas-edit-worker.js';
import { canvasAnalysisFocus } from './analysis-focus.js';
import { DisplayUnitsControl,useDisplayUnits } from './display-units.js';
import { ConfigurationEditor } from './configuration-editor.js';
import { removeQuantizationRule,withoutQuantizationReviews } from '../../../packages/contracts/src/ascend-quantization.js';
import { AscendQuantizationEditor } from './ascend-quantization-view.js';
import { useEffect,useMemo,useState } from 'react';
import { type AssetDocument,type AssetIndexEntry,type AssetRef,type AnalysisResult,type ProjectDocument,type Scenario } from '@model-analyser/contracts';
import { useFusionTask } from './use-fusion-task.js';
import { useModelInstantiation } from './use-model-instantiation.js';
import { mergeMeasurements } from '../../../packages/contracts/src/measurement-file.js';
import { canonical } from '../../../packages/contracts/src/validation.js';
import { validateScenario } from '../../../packages/contracts/src/scenario-validation.js';
import { type SaveState } from './serialized-autosave.js';
import { CanvasConnectionEditor } from './canvas-connection-editor.js';
import { CanvasStructureEditor } from './canvas-structure-editor.js';
import { graphAsset,localCanvasNodeId } from './canvas-editing.js';
import { ModelCanvas } from './model-canvas.js';
import { canvasOperatorScope } from './canvas-operator-groups.js';
import { OperatorCalculation } from './operator-calculation.js';
import type { CanvasGraph,CanvasNode } from './canvas-graph.js';
import { ResolvedNodeInspector } from './resolved-inspector-view.js';
import { traceNodeFormulas } from './formula-trace.js';
import { ParallelPresetEditor } from './parallel-preset-view.js';
import { ParallelDegreeEditor } from './parallel-degree-view.js';
import { DeviceSettings } from './device-settings.js';
import { QuantizationEditor } from './quantization-view.js';
import { FusionEditor } from './fusion-view.js';
import { ExecutionEditor } from './execution-view.js';
import { MemoryPeakEditor } from './memory-peak-view.js';
import { AnalysisView } from './analysis-view.js';
import { KvCapacityView } from './kv-capacity-view.js';
import { ScenarioComparisonView } from './comparison-view.js';
type Props={recoveryTools?:React.ReactNode;project:ProjectDocument|undefined;scenario:Scenario|undefined;catalog:AssetIndexEntry[];status:SaveState;error:string;
  onModel:(id:string)=>Promise<void>;onImport:(file:File)=>Promise<void>;onExport:()=>void;onScenario:(s:Scenario)=>void;onProject:(p:ProjectDocument)=>void;onSelectConfiguration:(id:string)=>void;onCopyConfiguration:()=>void;
  hardwareChoices:{ref:AssetRef;name:string}[];quantizationPresets:{ref:AssetRef;name:string}[];onHardware:(deviceId:string|null,ref:AssetRef)=>Promise<void>;onQuantization:(ref:AssetRef,selector:Scenario['quantizationOverrides'][number]['selector'])=>Promise<void>;onPreset:(scenario:Scenario,assets:AssetDocument[])=>void;onUpdateModel:()=>Promise<void>;onLibrary:()=>void;onEditStructure:(intent:CanvasEditIntent,controls:CanvasEditControls)=>Promise<void>};
type Panel='inspect'|'workload'|'parallel'|'device'|'quantization'|'fusion'|'execution'|'memory'|'analysis'|'capacity'|'compare'|'connection'|'advanced'|'structure';
const familyLabel=(family:string|undefined)=>family?.startsWith('qwen')?'Qwen':family?.startsWith('deepseek')?'DeepSeek':family?.startsWith('glm')?'GLM':family?.startsWith('synthetic')?'研究与合成参考':family??'其他';
const panels:Record<Panel,string>={inspect:'节点与算法',workload:'推理配置',parallel:'并行方式',device:'设备',quantization:'量化',fusion:'融合',execution:'执行与多流',memory:'显存假设',analysis:'分析结果',capacity:'容量',compare:'配置对比',connection:'连接编辑',advanced:'高级配置',structure:'编辑结构'};
const number=(n:number)=>new Intl.NumberFormat('en-US',{maximumFractionDigits:3,notation:n>=1e6?'compact':'standard'}).format(n);
const emptyCanvas:CanvasGraph={nodes:[],edges:[]};
const layoutPanels:Panel[]=['analysis','capacity','parallel','device'];

function primaryDeviceTopology(scenario:Scenario):Scenario['deviceTopology']{
  const primary=scenario.deviceTopology.devices[0]!;
  return {
    devices:[primary],
    groups:scenario.deviceTopology.groups.filter(group=>group.members.length===1&&group.members[0]===primary.deviceId),
  };
}

export function ModelWorkspace(props:Props){
  const display=useDisplayUnits();
  const {project,scenario:s,catalog,status}=props,[scope,setScope]=useState('$model'),[selected,setSelected]=useState<string[]>([]),[panel,setPanel]=useState<Panel>('inspect'),[error,setError]=useState(''),[result,setResult]=useState<AnalysisResult|null>(null),[analysisRun,setAnalysisRun]=useState(0),[connection,setConnection]=useState<{from:string;to:string}|null>(null);
  const [expandOperatorCalls,setExpandOperatorCalls]=useState(false);
  const [openLayout,setOpenLayout]=useState(false);
  const [sidebarCollapsed,setSidebarCollapsed]=useState(false);
  const [upgradingModel,setUpgradingModel]=useState(false);
  const [structureScope,setStructureScope]=useState<string>();
  const fingerprint=useMemo(()=>canonical({scenario:s?withoutQuantizationReviews(s):s,assets:project?.assetSnapshots}),[s,project?.assetSnapshots]);
  const expansion=useModelInstantiation(s,project?.assetSnapshots,fingerprint,{scope,expandOperatorCalls}),{attempt,projection}=expansion;
  const resolved=attempt?.status==='available'?attempt.resolved:undefined,graph=projection?.graph??emptyCanvas;
  const missingLayout=!!s&&s.deviceTopology.devices.length>1&&!s.parallelPlan.nativeBindings&&
    !s.parallelPlan.assignments.some(assignment=>assignment.phases.includes(s.workload.kind));
  const singleDeviceFallback=useMemo(()=>{
    if(!missingLayout||!s||!project||!resolved||s.parallelPlan.assignments.length||
      s.parallelPlan.communications.length||resolved.graph.nodes.some(node=>node.body.kind==='collective'))return undefined;
    const candidate={...s,deviceTopology:primaryDeviceTopology(s)};
    return validateScenario(candidate,project.assetSnapshots).some(diagnostic=>diagnostic.severity==='error')?undefined:candidate;
  },[missingLayout,s,project?.assetSnapshots,resolved]);
  useEffect(()=>{if(singleDeviceFallback)setResult(null);},[singleDeviceFallback]);
  const resolvedNodes=useMemo(()=>new Map(resolved?.graph.nodes.map(node=>[node.nodeId as string,node])),[resolved]);
  const repeatRoot=scope.replace(/\[\d+\]$/,'');
  const repeatInstances=useMemo(()=>resolved?[...new Set([...resolved.containers,...resolved.graph.nodes]
    .filter(c=>c.nodeId.startsWith(repeatRoot+'[')&&/^\[\d+\]$/.test(c.nodeId.slice(repeatRoot.length))).map(c=>c.nodeId))]:[],[resolved,repeatRoot]);
  const nodesById=useMemo(()=>new Map(graph.nodes.map(node=>[node.id,node])),[graph.nodes]);
  const selectedIds=useMemo(()=>new Set(selected),[selected]);
  const models=catalog.filter(a=>a.kind==='model'&&!a.archived),model=project?.assetSnapshots.find(a=>a.assetId===s?.model.assetId&&a.revision===s.model.revision),configurations=project?.scenarios.filter(c=>c.model.assetId===s?.model.assetId)??[];
  const latestModel=models.find(entry=>entry.assetId===s?.model.assetId);
  const viewScope=useMemo(()=>canvasOperatorScope(resolved,scope),[resolved,scope]),ownerScope=viewScope?.ownerScope??scope;
  const scopeContainer=resolved?.containers.find(c=>c.nodeId===ownerScope);
  const scopeDefinition=ownerScope==='$model'?model:project?.assetSnapshots.find(a=>a.assetId===scopeContainer?.asset.assetId&&a.revision===scopeContainer.asset.revision);
  const template=graphAsset(scopeDefinition);
  let templateNodeId='';
  if(template&&selected.length===1) {
    try{templateNodeId=localCanvasNodeId(selected[0]!,ownerScope,template.definition.graph);}
    catch{/* Canvas boundary and communication overlays are not editable template nodes. */}
  }
  const node=(selected.length===1?nodesById.get(selected[0]!):selected.length?graph.nodes.find(n=>selectedIds.has(n.id)):undefined)??nodesById.get(scope)??
    (viewScope?{id:scope,name:viewScope.name,kind:'module' as const,leafIds:viewScope.leafIds,viewGroup:viewScope}:
      scope!=='$model'&&scopeContainer?{id:scope,name:scopeContainer.name,kind:'module' as const,leafIds:scopeContainer.leafNodeIds}:undefined);
  const leaves=selected.flatMap(id=>nodesById.get(id)?.leafIds??[]);
  const allOperators=selected.length>0&&selected.every(id=>nodesById.get(id)?.kind==='operator');
  const focusedGroup=selected.length===1?nodesById.get(selected[0]!)?.viewGroup:!selected.length?viewScope:undefined;
  const baseFocus=canvasAnalysisFocus(resolved,scope,selected,(project?.projectId??'')+':'+(s?.scenarioId??'')+':'+(s?.model.assetId??'')+'@'+s?.model.revision);
  const analysisFocus=focusedGroup?.fusionNodeId?canvasAnalysisFocus(resolved,ownerScope,[focusedGroup.fusionNodeId],baseFocus.key):
    focusedGroup?{key:baseFocus.key,label:focusedGroup.name,reason:'请进入计算流程并选择内部算子，查看其实际指标。'}:baseFocus;
  useEffect(()=>{document.querySelector('.studio-panel-body')?.scrollTo({top:0,left:0});},[scope,selected.join('\0'),panel]);
  const canvasPositions=useMemo(()=>Object.fromEntries(project?.viewState.nodes.map(n=>[n.nodeId,{x:n.x,y:n.y}])??[]),[project?.viewState.nodes]);
  const fusionKey=fingerprint+'\0'+scope+'\0'+selected.join('\0')+'\0'+panel,fusionTask=useFusionTask(fusionKey),recommendations=fusionTask.reply?.kind==='candidates'?fusionTask.reply.candidates:[];
  function recommend(){if(panel!=='fusion'||!resolved||!projection||!s||!project)return;const operators=new Set(graph.nodes.filter(n=>n.kind==='operator').map(n=>n.id)),selections=allOperators&&leaves.length>1?[leaves]:graph.edges.filter(e=>operators.has(e.from)&&operators.has(e.to)).slice(0,6).map(e=>[e.from,e.to]);fusionTask.run({kind:'candidates',resolved,scenario:s,assets:project.assetSnapshots,selections});}
  useEffect(()=>{recommend();},[fusionKey,resolved,projection]);
  useEffect(()=>{
    if(resolved&&scope!=='$model'&&!viewScope&&!resolved.containers.some(c=>c.nodeId===scope)&&!resolved.graph.nodes.some(n=>n.nodeId===scope)){
      const parent=scope.split('/$view:')[0];
      setScope(parent&&parent!==scope&&resolved.containers.some(c=>c.nodeId===parent)?parent:'$model');setSelected([]);
    }
  },[resolved,scope,viewScope]);
  useEffect(()=>{
    if(!projection||!selected.length)return;
    const hidden=selected.filter(id=>!nodesById.has(id));
    if(!hidden.length)return;
    const fusion=graph.nodes.find(item=>item.viewGroup?.kind==='fusion'&&hidden.every(id=>item.leafIds.includes(id)));
    if(fusion)setSelected([fusion.id]);
  },[projection,selected,nodesById,graph.nodes]);
  function patch(next:Scenario){setError('');props.onScenario(next);}
  function openPanel(next:Panel){setSidebarCollapsed(false);setPanel(next);}
  function analyzeCanvas(layout=false){setOpenLayout(layout);openPanel('analysis');setAnalysisRun(value=>value+1);}
  function useSingleDevice(){
    if(!singleDeviceFallback)return;
    try{
      patch(singleDeviceFallback);
      if(panel!=='capacity')analyzeCanvas();
    }catch(issue){setError(issue instanceof Error?issue.message:String(issue));}
  }
  function selectPresetMembers(ids:string[]){
    const group=graph.nodes.find(item=>item.viewGroup?.kind==='operator'&&ids.every(id=>item.leafIds.includes(id)));
    if(group)setScope(group.id);
    setSelected(ids);
  }
  function drill(n:CanvasNode){if(n.kind==='module'){setExpandOperatorCalls(false);const first=n.viewGroup?undefined:[...(resolved?.containers??[]),...(resolved?.graph.nodes??[])].find(c=>c.nodeId===n.id+'[0]');setScope(first?.nodeId??n.id);setSelected([]);setPanel('inspect');}}
  function summary(n:CanvasNode){if(n.communication){const c=n.communication;return <><p>{c.operation} · 设备组 {c.groupId}</p><p>发送 payload / 成员：{c.sendBytesPerMember.kind==='literal'?display.quantity(c.sendBytesPerMember.quantity.value,c.sendBytesPerMember.quantity.unit):'由消息公式计算'}</p><p>接收 payload / 成员：{c.receiveBytesPerMember.kind==='literal'?display.quantity(c.receiveBytesPerMember.quantity.value,c.receiveBytesPerMember.quantity.unit):'由消息公式计算'}</p><small>通信跨度、本地算术与 HBM 由明确成本声明；未声明项保持未知。</small></>;}const math=n.leafIds.flatMap(id=>{const leaf=resolvedNodes.get(id);return leaf?[leaf]:[];}),communications=math.filter(v=>v.body.kind==='collective').length,values=math.flatMap(v=>v.body.kind==='opaque'?v.body.cost.compute.map(c=>c.usefulOperations):[]),known=values.every(v=>v.kind==='literal'),ops=values.reduce((sum,v)=>sum+(v.kind==='literal'?v.quantity.value:0),0);return <><p>{n.kind==='module'?'模块内计算流程':'算子计算'} · {n.leafIds.length} 个算子</p><p>{known?'有效运算 '+number(ops)+' operations':'计算含未解析项'}</p>{communications>0&&<small>另含 {communications} 次图内通信，本地成本见分析。</small>}<ul>{math.slice(0,6).map(v=><li key={v.nodeId}>{v.name}</li>)}</ul>{math.length>6&&<small>其余 {math.length-6} 个算子可点击展开</small>}</>;}
  const trace=node&&s&&project?traceNodeFormulas(s.model,node.id,project.assetSnapshots):undefined;
  function workload(field:string,value:string){if(!s||!value.trim()||!Number.isSafeInteger(Number(value)))return;const n=Number(value),min=['contextTokensPerRequest','pastTokensPerRequest'].includes(field)?0:1;if(n<min)return;patch({...s,workload:{...s.workload,[field]:n}});}
  return <div className="model-studio" data-workspace-id={project?.projectId}><header className="studio-header"><div className="studio-brand"><span>M</span><strong>Model Analyser<small>模型结构与推理分析</small></strong></div><label className="studio-model-select">模型<select aria-label="当前模型" value={s?.model.assetId??''} onChange={e=>{setScope('$model');setSelected([]);setPanel('inspect');setConnection(null);setResult(null);void props.onModel(e.target.value).catch(e=>setError(String(e)));}}><option value="" disabled>选择模型，打开结构画布</option>{model&&!models.some(m=>m.assetId===model.assetId)&&<option value={model.assetId}>{model.name}</option>}{[...new Set(models.map(m=>familyLabel(m.family)))].sort((a,b)=>a.localeCompare(b)).map(family=><optgroup key={family} label={family}>{models.filter(m=>(familyLabel(m.family))===family).map(m=><option key={m.assetId} value={m.assetId}>{m.name}</option>)}</optgroup>)}</select></label><div className="studio-header-actions"><DisplayUnitsControl/><label className="studio-import">导入模型工作区<input aria-label="导入模型工作区" type="file" accept=".json,.yaml,.yml" onChange={e=>{const file=e.target.files?.[0];if(file)void props.onImport(file);e.target.value='';}}/></label><button onClick={props.onExport} disabled={!project}>导出</button>{props.recoveryTools}<button onClick={props.onLibrary}>模块与算法库</button></div></header>
    <div className="studio-configuration"><div className="configuration-tabs" role="tablist" aria-label="模型配置">{configurations.map(c=><button key={c.scenarioId} role="tab" aria-selected={s?.scenarioId===c.scenarioId} onClick={()=>{props.onSelectConfiguration(c.scenarioId);setSelected([]);}}>{c.name}<small>{c.workload.kind} · {c.quantizationOverrides.length?'量化':'原始精度'} · {c.fusionGroups.length?'融合 '+c.fusionGroups.length:'未融合'}</small></button>)}<button onClick={props.onCopyConfiguration} disabled={!s}>＋ 复制配置</button></div><span role="status" className={'studio-save '+status.status}>{status.message.replaceAll('项目','模型工作区').replaceAll('方案','配置')}</span></div>
    <nav className="studio-toolbar" aria-label="模型分析工具">{(['workload','parallel','device','quantization','fusion','execution','memory','capacity','compare','advanced'] as Panel[]).map(key=><button key={key} className={panel===key?'active':''} onClick={()=>openPanel(key)}>{panels[key]}{key==='fusion'&&leaves.length>1?' · '+leaves.length:''}</button>)}<button className={panel==='structure'?'active':''} disabled={!template} onClick={()=>{setStructureScope(scope);openPanel('structure');}}>{panels.structure}</button><button type="button" className="studio-sidebar-toggle" aria-controls="studio-inspector" aria-expanded={!sidebarCollapsed} onClick={()=>setSidebarCollapsed(value=>!value)}>{sidebarCollapsed?'展开侧栏':'收起侧栏'}</button><button className="studio-analyze" disabled={!s} onClick={()=>analyzeCanvas()}>分析此配置 ↗</button></nav>
    {(props.error||error)&&<div role="alert" className="studio-error">{props.error||error}<button onClick={()=>setError('')}>关闭</button></div>}
    <div className={'studio-content'+(sidebarCollapsed?' inspector-collapsed':'')}><section className="studio-stage"><nav className="canvas-breadcrumb" aria-label="模块路径">{repeatInstances.length>0&&<span className="repeat-instance-control">模块内部 · {repeatInstances.length} × <select disabled={expandOperatorCalls} aria-label="查看重复模块实例" value={scope===repeatRoot?repeatInstances[0]:scope} onChange={e=>{setScope(e.target.value);setSelected([]);}}>{repeatInstances.findIndex(id=>id===scope)>=128&&<option value={scope}>实例 {repeatInstances.findIndex(id=>id===scope)+1} / {repeatInstances.length}</option>}{repeatInstances.slice(0,128).map((id,i)=><option key={id} value={id}>实例 {i+1} / {repeatInstances.length}</option>)}</select>{repeatInstances.length>128&&<label>调用编号<input type="number" aria-label="重复算子调用编号" min={1} max={repeatInstances.length} value={Math.max(1,repeatInstances.findIndex(id=>id===scope)+1)} disabled={expandOperatorCalls} onChange={e=>{const i=Number(e.target.value)-1;if(Number.isSafeInteger(i)&&repeatInstances[i]){setScope(repeatInstances[i]!);setSelected([]);}}}/></label>}{resolved?.graph.nodes.some(n=>n.nodeId===repeatRoot+'[0]')&&<label><input type="checkbox" aria-label="跨调用选择算子" checked={expandOperatorCalls} onChange={e=>{setExpandOperatorCalls(e.target.checked);setScope(e.target.checked?repeatRoot:repeatInstances[0]!);setSelected([]);}}/>跨调用选择算子</label>}</span>}<button onClick={()=>{setScope('$model');setSelected([]);}}>{model?.name??'模型结构'}</button>{scope!=='$model'&&scope.split('/').map((part,i,parts)=><span key={i}>／<button onClick={()=>{setScope(parts.slice(0,i+1).join('/'));setSelected([]);}}>{canvasOperatorScope(resolved,parts.slice(0,i+1).join('/'))?.name??decodeURIComponent(part)}</button></span>)}<span className="canvas-stage-caption">{graph.nodes.length} 个{scope==='$model'?'模块／算子':'子模块／算子'} · 数据依赖连线</span></nav>
      {project&&s&&projection?<ModelCanvas key={project.projectId+':'+scope} graph={graph} defaultPositions={projection.defaultPositions} scopeKey={project.projectId+':'+s.model.assetId+':'+scope} layout={canvasPositions} selected={selected} onSelect={ids=>{setSelected(ids);if(ids.length>1)setPanel('fusion');else if(panel==='fusion')setPanel('inspect');}} onOpen={drill} onMove={positions=>{const nodes=project.viewState.nodes.map(n=>({...n})),byId=new Map<string,typeof nodes[number]>();for(const item of nodes)if(!byId.has(item.nodeId))byId.set(item.nodeId,item);for(const [nodeId,p] of Object.entries(positions)){const old=byId.get(nodeId);if(old){old.x=p.x;old.y=p.y;}else nodes.push({nodeId:nodeId as ProjectDocument['viewState']['nodes'][number]['nodeId'],...p,collapsed:false});}props.onProject({...project,viewState:{...project.viewState,nodes}});}} onConnect={(from,to)=>{setConnection({from,to});openPanel('connection');}} tooltip={summary}/>:<div className="studio-empty"><span>◇</span><h1>{expansion.pending?'正在展开模型结构':expansion.cancelled?'模型展开已取消':expansion.error?(resolved?'画布准备失败':'模型结构展开失败'):resolved?'正在准备画布':attempt?.status==='unavailable'?'当前模型需要补充配置':'从一张模型结构图开始'}</h1>{(expansion.pending||resolved&&!expansion.error)?<><p role="status">可继续修改配置或选择其他模型。</p><button onClick={expansion.cancel}>{expansion.pending?'取消展开':'取消准备画布'}</button></>:<p>选择模型后直接探索模块与算子，配置、融合与分析都在这张画布上展开。</p>}{expansion.error&&<p role="alert">{expansion.error}</p>}{(expansion.cancelled||expansion.error)&&<button onClick={expansion.retry}>{resolved?'重新准备画布':'重新展开模型'}</button>}{attempt?.status==='unavailable'&&attempt.diagnostics.map(d=><p key={d.diagnosticId}>{d.message}</p>)}</div>}
      {resolved&&<div className="canvas-status"><span>{resolved.graph.nodes.length} 算子 · {resolved.containers.length-1} 模块 · {s?.deviceTopology.devices.length} 物理设备</span><span>{s?.workload.kind} · Batch {s?.workload.batchSize}{result?' · 分析结果已生成':''}</span></div>}
    </section><section id="studio-inspector" hidden={sidebarCollapsed} className="studio-inspector" aria-label="画布配置与详情"><div className="inspector-heading"><div><small>{scope==='$model'?'MODEL WORKSPACE':'MODULE WORKSPACE'}</small><h2>{panels[panel]}</h2></div><button onClick={()=>setPanel('inspect')} aria-label="返回节点详情">⌕</button></div>
      {project&&s&&<div className="studio-panel-body">
        {missingLayout&&layoutPanels.includes(panel)&&<div className="studio-layout-notice" role="status">
          <p>{s.deviceTopology.devices.length} 张卡尚未应用当前阶段的并行布局。</p>
          {singleDeviceFallback&&<button type="button" onClick={useSingleDevice}>改为单卡并计算</button>}
          {panel!=='parallel'&&<button type="button" onClick={()=>openPanel('parallel')}>前往并行配置</button>}
        </div>}
        {panel==='inspect'&&<>{node?<><h3>{node.name}</h3><p className="studio-node-path">{node.id}</p>{summary(node)}{node.kind==='operator'&&<OperatorCalculation key={'calculation:'+node.id} asset={scopeDefinition} nodeId={node.id}/>}{resolved&&<ResolvedNodeInspector key={node.id} resolved={resolved} model={s.model} assets={project.assetSnapshots} nodeId={node.id} leafIds={node.leafIds}/>} {node.kind==='module'&&node.id!==scope&&<button onClick={()=>drill(node)}>进入模块计算流程 →</button>}{node.kind==='module'&&!node.viewGroup&&<button onClick={()=>setPanel('memory')}>配置此模块显存预算</button>}<button type="button" onClick={()=>analyzeCanvas(true)}>查看所选节点设备布局</button><h3>算法与计算来源</h3>{trace?.chain.filter((c,i,a)=>a.findIndex(v=>v.name===c.name)===i).map((c,i)=><p key={i}>{c.name}</p>)}{trace?.formulas.map(a=><div className="studio-algorithm" key={a.assetId}><strong>{a.name}</strong>{a.definition.kind==='formula'&&<><p>{a.definition.formula.description}</p><code>{a.definition.formula.expression}</code><small>输入：{Object.entries(a.definition.formula.inputs).map(([name,v])=>name+' ('+v.unit+')').join('，')} · 输出 {a.definition.formula.output.unit}</small></>}</div>)}</>:<><h3>{model?.name}</h3><p>点击模块进入计算流程，悬浮查看涉及的算子与计算；在算子层框选多个节点以配置融合。</p>{resolved&&<ResolvedNodeInspector key="$model" resolved={resolved} model={s.model} assets={project.assetSnapshots} nodeId="$model" leafIds={resolved.graph.nodes.map(n=>n.nodeId)}/>}<h3>当前配置</h3><p>{s.name} · {s.workload.kind} · {s.deviceTopology.devices.length} 卡</p><p>并行、量化和其他配置保存在同一模型下，可复制配置后对照查看。</p></>}{attempt?.diagnostics.length?attempt.diagnostics.map(d=><p key={d.diagnosticId}>{d.message}</p>):null}</>}
        {panel==='workload'&&<><label>配置名称<input aria-label="配置名称" value={s.name} onChange={e=>{if(e.target.value.trim())patch({...s,name:e.target.value});}}/></label><label>推理阶段<select aria-label="画布推理阶段" value={s.workload.kind} onChange={e=>{const shared={batchSize:s.workload.batchSize,queryTokensPerRequest:s.workload.queryTokensPerRequest};patch({...s,workload:e.target.value==='prefill'?{kind:'prefill',...shared,pastTokensPerRequest:s.workload.kind==='decode'?s.workload.contextTokensPerRequest:s.workload.pastTokensPerRequest}:{kind:'decode',...shared,contextTokensPerRequest:s.workload.kind==='prefill'?s.workload.pastTokensPerRequest:s.workload.contextTokensPerRequest,steps:1}});}}><option value="prefill">Prefill</option><option value="decode">Decode</option></select></label>{Object.entries(s.workload).filter((entry):entry is [string,number]=>typeof entry[1]==='number').map(([key,value])=><label key={key}>{{batchSize:'Batch',queryTokensPerRequest:'Query tokens',contextTokensPerRequest:'Context tokens',pastTokensPerRequest:'Past tokens',steps:'Decode steps',chunkTokens:'Chunk tokens'}[key]??key}<input aria-label={'画布 '+key} type="number" min={key.includes('context')||key.includes('past')?0:1} value={value} onChange={e=>workload(key,e.target.value)}/></label>)}</>}
        {panel==='parallel'&&<>
          {latestModel&&latestModel.revision>s.model.revision&&<button type="button" disabled={upgradingModel} onClick={()=>{
            setUpgradingModel(true);
            void props.onUpdateModel().finally(()=>setUpgradingModel(false));
          }}>{upgradingModel?'正在更新模型…':'更新模型到 r'+latestModel.revision}</button>}
          <ParallelDegreeEditor key={project.projectId+':'+s.scenarioId} project={project} scenario={s} onApply={props.onPreset}/>
          <button type="button" onClick={()=>analyzeCanvas(true)}>分析设备布局与通信</button>
        </>}
        {panel==='device'&&<DeviceSettings key={project.projectId+':'+s.scenarioId} scenario={s} snapshots={project.assetSnapshots} choices={props.hardwareChoices} onHardware={ref=>props.onHardware(null,ref)} onCustom={props.onPreset}/>}
        {panel==='quantization'&&<><AscendQuantizationEditor key={project.projectId+':'+s.scenarioId} project={project} scenario={s} resolved={resolved} resolveIfMissing={false} onProject={props.onProject}/><QuantizationEditor scenario={s} presets={props.quantizationPresets} onApply={props.onQuantization} selection={focusedGroup?focusedGroup.leafIds:selected.length===1?selected:leaves.length?leaves:[scope]} onRemove={index=>patch(removeQuantizationRule(s,index))}/></>}
        {panel==='fusion'&&<><p>{allOperators?'已选择 '+leaves.length+' 个算子':'进入模块后框选多个算子。'}</p><h3>推荐融合 · 结构候选</h3><p className="scope-note">以下组合通过当前图的融合约束；时间默认合计，不预设 kernel 加速或取消存储。</p>{fusionTask.pending&&<p role="status">正在后台检查融合候选…<button onClick={fusionTask.cancel}>取消融合推荐</button></p>}{fusionTask.cancelled&&<p>融合推荐已取消。<button onClick={recommend}>重新检查融合推荐</button></p>}{fusionTask.error&&<p role="alert">{fusionTask.error}<button onClick={recommend}>重新检查融合推荐</button></p>}{recommendations.map((r,i)=><button className="studio-fusion-suggestion" key={i} onClick={()=>setSelected(r.nodeIds)}>{r.names.join(' → ')}<small>{r.description}</small></button>)}{!fusionTask.pending&&!fusionTask.cancelled&&!fusionTask.error&&!recommendations.length&&<p>当前选择没有可确认的结构建议；可调整选择并查看约束诊断。</p>}<FusionEditor canvasSelection={selected} onPresetSelection={selectPresetMembers} scope={ownerScope} key={s.scenarioId} scenario={s} assets={project.assetSnapshots} onChange={patch} selection={allOperators?leaves:[]} resolved={resolved}/></>}
        {panel==='execution'&&<ExecutionEditor scenario={s} assets={project.assetSnapshots} onChange={patch}/>}
        {panel==='memory'&&<MemoryPeakEditor scenario={s} assets={project.assetSnapshots} onChange={patch} resolved={resolved} resolveIfMissing={false} selection={node?.kind==='module'?node.id:scope}/>}
        {!singleDeviceFallback&&<div hidden={panel!=='analysis'}><AnalysisView key={project.projectId+':'+s.scenarioId} focus={analysisFocus} scenario={s} assets={project.assetSnapshots} measurements={project.measurements} onMeasurement={m=>props.onProject({...project,measurements:[...project.measurements,m]})} onMeasurements={rows=>props.onProject({...project,measurements:mergeMeasurements(project.measurements,rows)})} autoRunKey={analysisRun} layoutRequest={openLayout?analysisRun:undefined} onResult={setResult}/></div>}
        {panel==='advanced'&&<>
          <ParallelPresetEditor key={project.projectId+':topology:'+s.scenarioId} summary="高级设备与拓扑" project={project} scenario={s} hardwareChoices={props.hardwareChoices} onHardware={props.onHardware} onTopology={patch} onApply={props.onPreset}/>
          <ConfigurationEditor key={project.projectId+':'+s.scenarioId} project={project} scenario={s} resolved={resolved} selection={selected.length?selected:[scope]} onProject={props.onProject}/>
        </>}
        {panel==='capacity'&&!singleDeviceFallback&&<KvCapacityView scenario={s} assets={project.assetSnapshots}/>}
        {panel==='compare'&&<ScenarioComparisonView scenarios={configurations} assets={project.assetSnapshots} focus={analysisFocus}/>}
        {structureScope===scope&&template&&<div hidden={panel!=='structure'}><CanvasStructureEditor key={scope+':'+template.assetId+'@'+template.revision} source={template} initialNodeId={templateNodeId} assets={project.assetSnapshots} catalog={catalog} active={panel==='structure'} onApply={props.onEditStructure}/></div>}
        {panel==='connection'&&connection&&<CanvasConnectionEditor key={scope+':'+connection.from+':'+connection.to} source={scopeDefinition} scope={ownerScope} from={connection.from} to={connection.to} assets={project.assetSnapshots} onApply={props.onEditStructure}/>}
      </div>}
    </section></div>
  </div>;
}
