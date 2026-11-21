import {serializeProjectRecovery} from '../../../packages/contracts/src/project-recovery.js';
import {readProjectFile} from './project-import-task.js';
import {runProjectTextTask,useProjectTextPreview,type KnownProjectText} from './project-text-task.js';
import {ProjectRepairView} from './project-repair-view.js';
import { DisplayUnitsControl } from './display-units.js';
import { copyConfiguration } from '../../../packages/contracts/src/configuration-edit.js';
import { removeQuantizationRule } from '../../../packages/contracts/src/ascend-quantization.js';
import { AscendQuantizationEditor } from './ascend-quantization-view.js';
import { calculationInput, expertMeshPresets, pipelineExpertMeshPresets, pipelineExpertPreset, supportsRequestReplicas } from '@model-analyser/core';
import { publishCanvasEdit,type CanvasEditPlan } from './canvas-editing.js';
import {runCanvasEditTask} from './canvas-edit-task.js';
import type {CanvasEditIntent,CanvasEditControls} from './canvas-edit-worker.js';
import { ModelWorkspace } from './model-workspace.js';
import { useModelValidation } from './model-validation-task.js';
import { defaultDeclaredLayout,prepareDeclaredLayout } from './declared-layout-task.js';
import { MemoryPeakEditor } from './memory-peak-view.js';
import { useEffect,useRef,useState } from 'react';
import { z } from 'zod';
import { Id,AssetDocument,ProjectDocument,ProjectDraft,ProjectImportDocument,ProjectRecoveryDocument,SaveProjectResponse,Scenario,WorkspaceCatalog,ProjectDraftIndexEntry,type AssetRef,type ParallelPresetTemplate } from '@model-analyser/contracts';
import { canonical } from '../../../packages/contracts/src/validation.js';
import { ProjectAutosaver } from './project-autosave.js';
import { type SaveState } from './serialized-autosave.js';
import { request,lookupProject,getProjectDraft } from './api.js';
import { StructureView } from './structure-view.js';
import { AnalysisView } from './analysis-view.js';
import { ScenarioComparisonView } from './comparison-view.js';
import { ExecutionEditor } from './execution-view.js';
import { CapacityView } from './capacity-view.js';
import { ParallelView } from './parallel-view.js';
import { QuantizationEditor,type QuantizationPresetChoice } from './quantization-view.js';
import { FusionEditor } from './fusion-view.js';
import { DependencyUpgradeView } from './dependency-upgrade-view.js';
import { ParallelPresetEditor } from './parallel-preset-view.js';
import { mergeMeasurements } from '../../../packages/contracts/src/measurement-file.js';
// Raw text previews and formal validation run in independently owned workers.

function presetLayoutKey(preset?:ParallelPresetTemplate){
  // Compare the authored axes and boundaries across revisions, then validate the saved layout on the new graph.
  if(preset?.strategy!=='tensor_sharded')return canonical(preset);
  return canonical({...preset,moduleRules:preset.moduleRules?.map(rule=>({...rule,
    module:{assetId:rule.module.assetId,kind:rule.module.kind},
  }))});
}

function download(name:string,value:unknown){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();URL.revokeObjectURL(url);}
function NumericField({label,value,min,onChange}:{label:string;value:number;min:number;onChange:(value:number)=>void}){
  const [text,setText]=useState(String(value));useEffect(()=>setText(String(value)),[value]);
  const valid=Number.isSafeInteger(Number(text))&&text!==''&&Number(text)>=min;
  return <label>{label}<input aria-label={label} type="number" min={min} step={1} value={text} onChange={event=>{const raw=event.target.value;setText(raw);if(raw!==''&&Number.isSafeInteger(Number(raw))&&Number(raw)>=min)onChange(Number(raw));}}/>{!valid&&<small className="field-error">请输入 ≥ {min} 的安全整数</small>}</label>;
}
export function ProjectWorkbench({active:visible,surface='legacy',onOpenLibrary,catalogRevision=0}:{active:boolean;surface?:'legacy'|'canvas';onOpenLibrary?:(assets:AssetDocument[])=>void;catalogRevision?:number}){
  const [report,setReport]=useState<z.infer<typeof WorkspaceCatalog>|null>(null),[error,setError]=useState(''),[text,setText]=useState(''),[draft,setDraft]=useState<ProjectDraft|null>(null),[scenarioId,setScenarioId]=useState('');
  const [knownProject,setKnownProject]=useState<KnownProjectText|null>(null),[identityEditing,setIdentityEditing]=useState(false);
  const identityEdit=useRef<AbortController|null>(null);
  const [status,setStatus]=useState<SaveState>({generation:0,status:'committed',message:'选择项目或创建分析项目'});
  const [modelId,setModelId]=useState(''),[hardwareId,setHardwareId]=useState('');
  const [importing,setImporting]=useState<number|null>(null),[identityProposal,setIdentityProposal]=useState<{projectId:string;existing:ProjectDocument|null;text:string;token:number}|null>(null);
  const [repairMode,setRepairMode]=useState(false),[recoveryPicker,setRecoveryPicker]=useState(false);
  const [upgradeBusy,setUpgradeBusy]=useState(false),[canvasSession,setCanvasSession]=useState(0);
  const [conflict,setConflict]=useState<{incoming:ProjectDocument;existing:ProjectDocument}|null>(null);
  const pendingImport=useRef<number|null>(null),importController=useRef<AbortController|null>(null);
  const autoOpened=useRef(false),canvasEdit=useRef<{text:string;intent:CanvasEditIntent;key:string|AssetDocument;plan:CanvasEditPlan}|null>(null),preparingEdit=useRef<AbortController|null>(null);
  const publishingEdit=useRef(false);
  const saver=useRef<ProjectAutosaver|null>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),session=useRef(0),navigation=useRef(0),pendingNavigation=useRef<number|null>(null),saved=useRef<ProjectDocument|null>(null),recoveryBase=useRef<ProjectDocument|null>(null);
  const scanGeneration=useRef(0);
  async function refresh(fresh=false){const generation=++scanGeneration.current;try{const report=await request('catalog'+(fresh?'?fresh=true':''),WorkspaceCatalog);if(generation===scanGeneration.current)setReport(report);}catch(e){if(generation===scanGeneration.current)setError(String(e));}}
  useEffect(()=>{void refresh();return()=>{importController.current?.abort();importController.current=null;clearTimeout(timer.current);saver.current?.flush();};},[]);
  useEffect(()=>{if(visible)void refresh();},[visible,catalogRevision]);
  useEffect(()=>{const guard=(event:BeforeUnloadEvent)=>{if(['dirty','saving_draft','validating','committing','save_failed'].includes(status.status)){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[status.status]);
  function openDraft(next:ProjectDraft,formal:ProjectDocument|null=null,recover=false,baseline:ProjectDocument|null=formal,known?:ProjectDocument){
    importController.current?.abort();importController.current=null;pendingImport.current=null;setImporting(null);setIdentityProposal(null);setRepairMode(recover);setRecoveryPicker(false);if(surface==='canvas'&&recover)try{localStorage.setItem('model-studio:last-draft',next.draftId);}catch{}
    if(draft)setCanvasSession(value=>value+1);
    clearTimeout(timer.current);saver.current?.flush();setUpgradeBusy(false);pendingNavigation.current=null;++navigation.current;const token=++session.current;saved.current=formal;recoveryBase.current=baseline?.projectRevision===next.baseProjectRevision&&baseline.projectId===next.projectId?baseline:null;
    const incomingText=typeof next.candidate==='string'?next.candidate:JSON.stringify(next.candidate,null,2);setKnownProject(known?{text:incomingText,format:next.editorFormat??'json',session:token,project:known}:null);setDraft(next);setText(incomingText);setScenarioId('');setError('');
    setStatus({generation:next.draftGeneration,status:'draft_saved',message:'项目已载入 · 编辑自动保存'});
    saver.current=new ProjectAutosaver(next,state=>{if(token===session.current){setStatus(state);if(state.status==='committed'){setRepairMode(false);try{localStorage.removeItem('model-studio:last-draft');}catch{}}}if(state.status==='draft_saved')void refresh();},(project,source)=>{if(token===session.current){saved.current=project;recoveryBase.current=project;if(source!==undefined&&source===latest.current.text)setKnownProject({text:source,format:next.editorFormat??'json',session:token,project});setDraft(current=>current?{...current,baseProjectRevision:project.projectRevision}:current);}void refresh();});
  }
  function openProject(project:ProjectDocument,base:number|null=project.projectRevision){if(surface==='canvas')try{localStorage.setItem('model-studio:last-workspace',project.projectId);}catch{/* Browser cache is optional. */}openDraft(ProjectDraft.parse({documentType:'project_draft',schemaVersion:1,draftId:crypto.randomUUID(),projectId:project.projectId,baseProjectRevision:base,draftGeneration:0,updatedAt:new Date().toISOString(),candidate:project}),base===null?null:project,false,base===null?null:project,project);if(base!==null)setStatus({generation:0,status:'committed',message:`已保存 · 修订 ${base}`});}
  function change(value:string,immediate=false){latest.current={...latest.current,text:value};setText(value);const current=saver.current;if(!current)return;const generation=current.edit(value);clearTimeout(timer.current);if(immediate)void current.save(value,generation);else timer.current=setTimeout(()=>{void current.save(value,generation);},650);}
  function create(){const project=ProjectDocument.parse({documentType:'project',schemaVersion:1,projectId:crypto.randomUUID(),projectRevision:1,name:'新分析项目',scenarios:[],assetSnapshots:[],measurements:[],viewState:{nodes:[]}});openProject(project,null);change(JSON.stringify(project,null,2),true);}
  const preview=useProjectTextPreview(text,draft?.editorFormat??'json',session.current,knownProject),project=preview.project??preview.pendingProject;
  useEffect(()=>{setIdentityEditing(false);return()=>{identityEdit.current?.abort();identityEdit.current=null;};},[text,draft?.draftId]);
  const active=project?.scenarios.find(s=>s.scenarioId===scenarioId)??project?.scenarios[0];
  const modelUpgradeValidation=useModelValidation((active?.scenarioId??'')+'\n'+text);
  const latest=useRef({text,scenarioId:active?.scenarioId,projectId:project?.projectId});latest.current={text,scenarioId:active?.scenarioId,projectId:project?.projectId};const workspaceSession=session.current,workspaceNavigation=navigation.current;
  const quantizationPresets:QuantizationPresetChoice[]=[...new Map([
    ...(project?.assetSnapshots.flatMap(a=>a.definition.kind==='quantization'?[{ref:{assetId:a.assetId,revision:a.revision,kind:'quantization' as const},name:a.name,
      ...(a.definition.modelWeights?{weightPresetModel:a.definition.modelWeights.model,
        weightPresetExecution:a.definition.modelWeights.moduleRules.some(rule=>rule.execution?.length)}:{})}]:[])??[]),
    ...[...report?.assets??[],...report?.pinnedWeightPresets??[]].filter(a=>a.kind==='quantization'&&!a.archived).filter(a=>!project?.assetSnapshots.some(s=>s.assetId===a.assetId&&s.revision===a.revision)).map(a=>({
      ref:{assetId:a.assetId,revision:a.revision,kind:'quantization' as const},name:a.name,
      ...(a.weightPresetModel?{weightPresetModel:a.weightPresetModel,weightPresetExecution:a.weightPresetExecution===true}:{})})),
  ].map(p=>[p.ref.assetId+'@'+p.ref.revision,p])).values()];
  const models=report?.assets.filter(a=>a.kind==='model'&&!a.archived)??[],hardwares=report?.assets.filter(a=>a.kind==='hardware'&&!a.archived)??[];
  const hardwareChoices=[...new Map([...(project?.assetSnapshots.filter(a=>a.definition.kind==='hardware').map(a=>({ref:{assetId:a.assetId,revision:a.revision,kind:'hardware' as const},name:a.name+' · 项目快照'}))??[]),...hardwares.map(a=>({ref:{assetId:a.assetId,revision:a.revision,kind:'hardware' as const},name:a.name+' · '+(a.origin==='builtin'?'内置库':'用户库')+' · '+a.assetId.slice(-8)}))].map(a=>[a.ref.assetId+'@'+a.ref.revision,a])).values()];
  async function applyHardware(deviceId:string|null,ref:AssetRef){if(!project||!active)return;const token=session.current,operationNavigation=navigation.current,snapshot=latest.current,savedAsset=project.assetSnapshots.find(a=>a.assetId===ref.assetId&&a.revision===ref.revision),incoming=savedAsset?[]:await request('snapshot',z.array(AssetDocument),{refs:[ref]});if(token!==session.current||operationNavigation!==navigation.current||snapshot.text!==latest.current.text||snapshot.scenarioId!==latest.current.scenarioId)throw Error('项目或方案已变化，未应用晚到的硬件快照；请重新选择。');const h=savedAsset??incoming.find(a=>a.assetId===ref.assetId&&a.revision===ref.revision);if(h?.definition.kind!=='hardware')throw Error('所选快照不是硬件');update({...project,assetSnapshots:mergeSnapshots(project.assetSnapshots,incoming),scenarios:project.scenarios.map(s=>s.scenarioId===active.scenarioId?{...s,deviceTopology:{...s.deviceTopology,devices:s.deviceTopology.devices.map(d=>deviceId===null||d.deviceId===deviceId?{...d,hardware:ref}:d)}}:s)});}
  function update(next:ProjectDocument){if(preview.status==='pending')throw Error('正文预览仍在校验，保留当前原文；校验完成后再编辑配置。');const cancellingImport=workspaceSession===session.current&&workspaceNavigation===navigation.current&&next.projectId===latest.current.projectId&&pendingImport.current!==null&&pendingImport.current===navigation.current;if(cancellingImport){++navigation.current;importController.current?.abort();importController.current=null;setImporting(null);pendingImport.current=null;pendingNavigation.current=null;}if(pendingNavigation.current!==null||workspaceSession!==session.current||(!cancellingImport&&workspaceNavigation!==navigation.current)||next.projectId!==latest.current.projectId){const message='项目导航已变化，未应用旧编辑结果';setError(message);throw Error(message);}const value=JSON.stringify(next,null,2);setKnownProject({text:value,format:draft?.editorFormat??'json',session:session.current,project:next});change(value);}
  function patchScenario(next:Scenario){if(project)update({...project,scenarios:project.scenarios.map(s=>s.scenarioId===next.scenarioId?next:s)});}
  async function upgradePublished(operation:import('@model-analyser/contracts').DependencyUpgradeOperation,adopt=true){const token=session.current,operationNavigation=navigation.current,snapshot=latest.current;if(token!==workspaceSession||workspaceNavigation!==navigation.current||operation.plan.intent.projectId!==project?.projectId||latest.current.projectId!==project?.projectId)return;if(!adopt){await refresh();return;}const next=await request('project?id='+encodeURIComponent(project.projectId),ProjectDocument);if(token!==session.current||operationNavigation!==navigation.current||snapshot.text!==latest.current.text||snapshot.scenarioId!==latest.current.scenarioId)throw Error('升级已保存；当前编辑已变化，保留编辑内容，请导出恢复文件后重新打开项目');openProject(next);setScenarioId(operation.plan.intent.scenarioId);void refresh();}
  function mergeSnapshots(current:AssetDocument[],incoming:AssetDocument[]){const existing=new Map(current.map(a=>[a.assetId+'@'+a.revision,a]));for(const a of incoming){const key=a.assetId+'@'+a.revision,prior=existing.get(key);if(prior&&canonical(prior)!==canonical(a))throw Error('项目快照与资产库的同修订内容冲突：'+key);existing.set(key,a);}return [...existing.values()];}
  async function applyQuantizationPreset(ref:AssetRef,selector:Scenario['quantizationOverrides'][number]['selector']){
    if(!project||!active)return;const token=session.current,operationNavigation=navigation.current,snapshot=latest.current,savedAsset=project.assetSnapshots.find(a=>a.assetId===ref.assetId&&a.revision===ref.revision),incoming=savedAsset?[]:await request('snapshot',z.array(AssetDocument),{refs:[ref]}),preset=savedAsset??incoming.find(a=>a.assetId===ref.assetId&&a.revision===ref.revision);
    if(token!==session.current||operationNavigation!==navigation.current||snapshot.text!==latest.current.text||snapshot.scenarioId!==latest.current.scenarioId)throw Error('项目或所选方案已变化，未应用预设，请重新选择。');if(preset?.definition.kind!=='quantization')throw Error('选择的资产不是量化预设');
    const modelWeights=preset.definition.modelWeights;
    if(modelWeights&&(modelWeights.model.assetId!==active.model.assetId||modelWeights.model.revision!==active.model.revision||selector.kind!=='subtree'||selector.rootNodeId!=='$model'))throw Error('发布权重预设只用于整个固定版本的模型。');
    const rule={...structuredClone(preset.definition.quantization),selector,preset:ref};
    const overrides=modelWeights?active.quantizationOverrides.filter(item=>!quantizationPresets.some(form=>form.weightPresetModel&&
      form.ref.assetId===item.preset?.assetId&&form.ref.revision===item.preset.revision)):active.quantizationOverrides;
    update({...project,assetSnapshots:mergeSnapshots(project.assetSnapshots,incoming),scenarios:project.scenarios.map(s=>s.scenarioId===active.scenarioId?{...s,quantizationOverrides:[...overrides,rule]}:s)});
  }
  async function updateModelReference(){if(!active||!project)return;const token=session.current,operationNavigation=navigation.current,snapshot=latest.current;
   const live=()=>token===session.current&&operationNavigation===navigation.current&&snapshot.text===latest.current.text&&snapshot.scenarioId===latest.current.scenarioId;
   try{
    const current=report?.assets.find(a=>a.kind==='model'&&a.assetId===active.model.assetId);if(!current)throw Error('资产库中没有该模型，项目仍可使用已保存快照');
    const model={assetId:current.assetId,revision:current.revision,kind:'model' as const};
    const replacements=new Map<string,{previous:AssetDocument;ref:AssetRef}>();
    for(const {preset} of active.quantizationOverrides){
      if(!preset)continue;
      const previous=project.assetSnapshots.find(asset=>asset.assetId===preset.assetId&&asset.revision===preset.revision);
      if(previous?.definition.kind!=='quantization'||!previous.definition.modelWeights)continue;
      const compatible=quantizationPresets.filter(choice=>choice.ref.assetId===preset.assetId&&
        choice.weightPresetModel?.assetId===model.assetId&&choice.weightPresetModel.revision===model.revision)
        .sort((a,b)=>b.ref.revision-a.ref.revision)[0];
      if(!compatible)throw Error('新模型修订没有兼容的发布权重预设：'+previous.name);
      replacements.set(preset.assetId+'@'+preset.revision,{previous,ref:compatible.ref});
    }
    const snapshots=await request('snapshot',z.array(AssetDocument),{refs:[model,...[...replacements.values()].map(row=>row.ref)]});
    if(!live())return;
    const assets=mergeSnapshots(project.assetSnapshots,snapshots);
    const next={...active,model,quantizationOverrides:active.quantizationOverrides.map(override=>{
      const item=override.preset&&replacements.get(override.preset.assetId+'@'+override.preset.revision);
      if(!item)return override;
      const incoming=snapshots.find(asset=>asset.assetId===item.ref.assetId&&asset.revision===item.ref.revision);
      if(item.previous.definition.kind!=='quantization'||incoming?.definition.kind!=='quantization'||
        incoming.definition.modelWeights?.model.assetId!==model.assetId||incoming.definition.modelWeights.model.revision!==model.revision||
        canonical(incoming.definition.modelWeights?.moduleRules)!==canonical(item.previous.definition.modelWeights?.moduleRules)||
        canonical(incoming.definition.quantization)!==canonical(item.previous.definition.quantization)){
        throw Error('发布权重预设的存储或执行规则已变化：'+item.previous.name);
      }
      return {...override,preset:item.ref};
    })};
    const {decodeContext,generatedFrom:origin}=active.parallelPlan;
    const previousPresets=project.assetSnapshots.find(asset=>asset.assetId===active.model.assetId&&asset.revision===active.model.revision)?.parallelPresets??[];
    const previous=previousPresets.find(preset=>preset.presetId===origin?.presetId);
    const target=snapshots.find(asset=>asset.assetId===model.assetId&&asset.revision===model.revision);
    const preset=target?.parallelPresets?.find(row=>row.presetId===origin?.presetId);
    const samePreset=previous&&preset&&presetLayoutKey(previous)===presetLayoutKey(preset);
    if(decodeContext||previous?.queryParallel||previous?.pipeline||samePreset){
      if(!origin||!preset||origin.modelId!==active.model.assetId||
         origin.requestDp&&!supportsRequestReplicas(preset)){
        throw Error('新模型修订没有兼容的并行布局');
      }
      next.parallelPlan={...active.parallelPlan,generatedFrom:{...origin,modelRevision:model.revision}};
      if(decodeContext){
        if(origin.modelRevision!==active.model.revision||!preset.decodeContext||canonical(preset.decodeContext.module)!==canonical(decodeContext.module)||
           preset.decodeContext.replacement.assetId!==decodeContext.replacement.assetId)throw Error('新模型修订没有兼容的 Decode KV 布局');
        next.parallelPlan.decodeContext=preset.decodeContext;
      }else if(previous?.queryParallel&&(!preset.queryParallel||canonical(preset.queryParallel)!==canonical(previous.queryParallel))){
        throw Error('新模型修订没有兼容的 Prefill 查询分片布局');
      }else if(previous?.pipeline){
        const before=previous.pipeline,after=preset.pipeline;
        if(!after||before.chainNodeId!==after.chainNodeId||canonical(before.payloadBytes)!==canonical(after.payloadBytes)||
           canonical(before.payloadDtype)!==canonical(after.payloadDtype)||origin.pipelineTp&&before.attentionPresetId!==after.attentionPresetId){
          throw Error('新模型修订没有兼容的流水线布局');
        }
        if(origin.pipelineStage){
          const stageId=origin.pipelineStage.presetId, phase=next.workload.kind;
          const oldStage=pipelineExpertPreset(previous,previousPresets,stageId,phase);
          const newStage=pipelineExpertPreset(preset,target?.parallelPresets??[],stageId,phase);
          if(!oldStage||!newStage||canonical(oldStage)!==canonical(newStage))throw Error('新模型修订没有兼容的阶段内专家布局');
          if(origin.expertMesh){
            const oldMesh=pipelineExpertMeshPresets(previous,previousPresets,phase);
            const newMesh=pipelineExpertMeshPresets(preset,target?.parallelPresets??[],phase);
            if(!oldMesh||!newMesh||canonical([oldMesh.ep,oldMesh.tp,oldStage===oldMesh.shared?oldMesh.sharedRules:null])!==
              canonical([newMesh.ep,newMesh.tp,newStage===newMesh.shared?newMesh.sharedRules:null])){
              throw Error('新模型修订没有兼容的阶段内专家网格');
            }
          }
        }
      }else if(origin.expertMesh){
        const oldMesh=expertMeshPresets(previousPresets,next.workload.kind),newMesh=expertMeshPresets(target?.parallelPresets??[],next.workload.kind);
        const meshKeys=(mesh:typeof oldMesh,selected:ParallelPresetTemplate|undefined)=>mesh&&[
          presetLayoutKey(mesh.ep),presetLayoutKey(mesh.tp),selected===mesh.shared?presetLayoutKey(mesh.sharedRules):null,
        ];
        if(!oldMesh||!newMesh||canonical(meshKeys(oldMesh,previous))!==canonical(meshKeys(newMesh,preset))){
          throw Error('新模型修订没有兼容的专家网格');
        }
      }
      if(preset.phases.includes(next.workload.kind)){
        await modelUpgradeValidation.run({kind:'model',scenario:next,assets,validateLayout:true});
        if(!live())return;
      }
    }
    update({...project,assetSnapshots:assets,scenarios:project.scenarios.map(s=>s.scenarioId===active.scenarioId?next:s)});
  }catch(e){if(live())setError(String(e));}}
  async function addScenario(){
    if(!project)return;const token=session.current,operationNavigation=navigation.current,snapshot=latest.current;
    try{
      const model=models.find(a=>a.assetId===(modelId||models[0]?.assetId)),hardware=hardwares.find(a=>a.assetId===(hardwareId||hardwares[0]?.assetId));
      if(!model||!hardware)throw Error('请先在资产库创建有效模型和硬件，或导入含快照的项目');
      const modelRef={assetId:model.assetId,revision:model.revision,kind:'model'},hardwareRef={assetId:hardware.assetId,revision:hardware.revision,kind:'hardware'};
      const snapshots=await request('snapshot',z.array(AssetDocument),{refs:[modelRef,hardwareRef]});
      if(token!==session.current||operationNavigation!==navigation.current||snapshot.text!==latest.current.text||snapshot.scenarioId!==latest.current.scenarioId)throw Error('项目或方案已变化，未添加晚到的新方案');
      const merged=mergeSnapshots(project.assetSnapshots,snapshots);
      const next=Scenario.parse({scenarioId:crypto.randomUUID(),name:'方案 '+(project.scenarios.length+1),model:modelRef,bindings:[],workload:{kind:'decode',batchSize:1,contextTokensPerRequest:0,queryTokensPerRequest:1,steps:1},deviceTopology:{devices:[{deviceId:'gpu0',hardware:hardwareRef}],groups:[{groupId:'main',members:['gpu0']}]},parallelPlan:{assignments:[],communications:[],assumptions:[]},executionPlan:{kind:'serial'},quantizationOverrides:[],numericOverrides:[],fusionGroups:[]});
      update({...project,scenarios:[...project.scenarios,next],assetSnapshots:merged});setScenarioId(next.scenarioId);
    }catch(e){setError(String(e));}
  }
  async function selectCurrentProject(id:string){const ticket=++navigation.current,snapshot=latest.current.text;pendingNavigation.current=ticket;try{const current=await request('project?id='+encodeURIComponent(id),ProjectDocument);if(ticket!==navigation.current||latest.current.text!==snapshot)return;openProject(current);void refresh();}catch(e){if(ticket===navigation.current)setError(String(e));}finally{if(pendingNavigation.current===ticket)pendingNavigation.current=null;}}
  function copyScenario(){if(project&&active){const id=crypto.randomUUID();update(copyConfiguration(project,active.scenarioId,id));setScenarioId(id);}}
  function copyProject(original:ProjectDocument){const next={...original,projectId:crypto.randomUUID(),projectRevision:1,name:original.name+'（副本）'};openProject(next,null);change(JSON.stringify(next,null,2),true);}
  async function importFile(file:File){const ticket=++navigation.current,snapshot=latest.current.text,scenarioSnapshot=latest.current.scenarioId,owner=()=>ticket===navigation.current&&latest.current.text===snapshot&&latest.current.scenarioId===scenarioSnapshot;autoOpened.current=true;pendingNavigation.current=ticket;pendingImport.current=ticket;setImporting(ticket);try{
    importController.current?.abort();const controller=new AbortController();importController.current=controller;const incoming=await readProjectFile(file,controller.signal);if(!owner())return;
    const existing=await lookupProject(incoming.projectId,{signal:controller.signal});if(!owner())return;
    if(incoming.documentType==='project_recovery'){
      let formal=existing??null,base=existing?incoming.baseProjectRevision:null;
      if(!formal&&incoming.formalProject){const restored=await request('projects',SaveProjectResponse,{requestId:crypto.randomUUID(),expectedRevision:null,project:incoming.formalProject});if(!owner())return;formal=restored.project;base=formal.projectRevision;}
      let baseline=incoming.formalProject?.projectRevision===base?incoming.formalProject:formal?.projectRevision===base?formal:null;if(!baseline&&existing&&base!==null)try{baseline=await request('project?id='+encodeURIComponent(incoming.projectId)+'&revision='+base,ProjectDocument);}catch{}if(!owner())return;
      openDraft(ProjectDraft.parse({documentType:'project_draft',schemaVersion:1,draftId:crypto.randomUUID(),projectId:incoming.projectId,baseProjectRevision:base,draftGeneration:0,updatedAt:new Date().toISOString(),candidate:incoming.editorText,...(incoming.editorFormat?{editorFormat:incoming.editorFormat}:{})}),formal,true,baseline);change(incoming.editorText,true);return;
    }
    if(existing){setConflict({incoming,existing});return;}openProject(incoming,null);change(JSON.stringify(incoming,null,2),true);
  }catch(e){if(owner())setError(String(e));}finally{if(pendingNavigation.current===ticket)pendingNavigation.current=null;if(pendingImport.current===ticket){pendingImport.current=null;importController.current?.abort();importController.current=null;}setImporting(current=>current===ticket?null:current);}}
  function exportProject(){
    const committed=saved.current;
    if(committed&&status.status==='committed')download('model-analyser-project.json',committed);
    else if(draft)try{const body=serializeProjectRecovery({documentType:'project_recovery',schemaVersion:1,status:'draft',projectId:draft.projectId,baseProjectRevision:draft.baseProjectRevision,formalProject:recoveryBase.current,editorText:text,...(draft.editorFormat?{editorFormat:draft.editorFormat}:{})}),url=URL.createObjectURL(new Blob([body],{type:'application/json;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download='model-analyser-project-recovery.json';link.click();URL.revokeObjectURL(url);}catch(e){setError((e instanceof Error?e.message:'恢复封装无法导出')+'；仍可导出原始正文保留全部内容。');}
  }
  useEffect(()=>()=>{preparingEdit.current?.abort();preparingEdit.current=null;},[text,active?.scenarioId,canvasSession,importing]);
  async function editCanvas(intent:CanvasEditIntent,controls:CanvasEditControls){
    if(!project||!active||workspaceSession!==session.current||workspaceNavigation!==navigation.current)throw Error('当前模型或配置已变化，请重新编辑');
    if(publishingEdit.current)throw Error('正在保存上一项结构修改，请稍后重试');
    const snapshot=latest.current,token=session.current,ticket=navigation.current,controller=new AbortController(),abort=()=>controller.abort();
    preparingEdit.current?.abort();preparingEdit.current=controller;controls.signal.addEventListener('abort',abort,{once:true});if(controls.signal.aborted)controller.abort();
    const owner=()=>!controller.signal.aborted&&token===session.current&&ticket===navigation.current&&snapshot.text===latest.current.text&&snapshot.scenarioId===latest.current.scenarioId;
    const check=()=>{if(!owner())throw Error('模型结构准备已取消或工作区已变化，未应用旧连接');};
    const key=intent.kind==='definition'?intent.candidate:JSON.stringify([intent.fromId,intent.toId,intent.kind,intent.outputPort,intent.inputPort,intent.removeId]);
    try{
      if(canvasEdit.current?.text!==snapshot.text||canvasEdit.current.intent.asset!==intent.asset||canvasEdit.current.key!==key){
        const discovered=await runCanvasEditTask({kind:'references',taskId:crypto.randomUUID(),scenario:active,assets:project.assetSnapshots,catalog:(report?.assets??[]).map(a=>({assetId:a.assetId,revision:a.revision,kind:a.kind})),...(intent.kind==='definition'?{candidate:intent.candidate}:{})},controller.signal);check();if(discovered.kind!=='references')throw Error('固定定义核验阶段无效');
        let library:AssetDocument[]=[];try{if(discovered.refs.length)library=await request('snapshot',z.array(AssetDocument),{refs:discovered.refs},{signal:controller.signal});}catch{/* Unverified fixed revisions are copied from the complete portable closure. */}check();
        const added=discovered.required?.length?await request('snapshot',z.array(AssetDocument),{refs:discovered.required},{signal:controller.signal}):[];
        check();
        const withDependencies=added.length?{...project,assetSnapshots:mergeSnapshots(project.assetSnapshots,added)}:project;
        const prepared=await runCanvasEditTask({kind:'prepare',taskId:crypto.randomUUID(),project:withDependencies,modelRef:active.model,intent,library:[...library,...added]},controller.signal);check();if(prepared.kind!=='prepared'||prepared.plan.project.projectId!==project.projectId)throw Error('结构准备的项目身份不一致');canvasEdit.current={text:snapshot.text,intent,key,plan:prepared.plan};
      }
      check();publishingEdit.current=true;
      try{
        controls.onPublishing();if(preparingEdit.current===controller)preparingEdit.current=null;controls.signal.removeEventListener('abort',abort);
        const next=await publishCanvasEdit(canvasEdit.current.plan);if(token!==session.current||ticket!==navigation.current||snapshot.text!==latest.current.text||snapshot.scenarioId!==latest.current.scenarioId)throw Error('定义已保存，当前配置已变化；可从算法库重新打开新模型。');update(next);canvasEdit.current=null;void refresh();
      }finally{publishingEdit.current=false;}
    }finally{controls.signal.removeEventListener('abort',abort);if(preparingEdit.current===controller)preparingEdit.current=null;}
  }
  async function openCanvasModel(id:string){
    const entry=models.find(m=>m.assetId===id);if(!entry)throw Error('模型不存在');const existing=report?.projects.filter(p=>p.scenarios.some(s=>s.model.assetId===id&&s.model.revision===entry.revision)).toSorted((a,b)=>b.projectRevision-a.projectRevision)[0];if(existing){await selectCurrentProject(existing.projectId);setScenarioId(existing.scenarios.find(s=>s.model.assetId===id&&s.model.revision===entry.revision)?.scenarioId??'');return;}
    const ticket=++navigation.current,snapshot=latest.current.text;pendingNavigation.current=ticket;try{const hardware=hardwares.find(h=>/A100/.test(h.name))??hardwares[0];if(!hardware)throw Error('请先导入硬件定义');const modelRef={assetId:entry.assetId,revision:entry.revision,kind:'model' as const},hardwareRef={assetId:hardware.assetId,revision:hardware.revision,kind:'hardware' as const},snapshots=await request('snapshot',z.array(AssetDocument),{refs:[modelRef,hardwareRef]});if(ticket!==navigation.current||snapshot!==latest.current.text)return;
      const modelAsset=snapshots.find(a=>a.assetId===modelRef.assetId),definition=modelAsset?.definition.kind==='model'?modelAsset.definition:undefined,phase=definition?.graph.nodes.length&&!definition.graph.nodes.some(n=>n.phases.includes('prefill'))?'decode':'prefill';let workload:Scenario['workload']=phase==='prefill'?{kind:'prefill',batchSize:1,queryTokensPerRequest:4,pastTokensPerRequest:0}:{kind:'decode',batchSize:1,queryTokensPerRequest:1,contextTokensPerRequest:0,steps:1};
      for(const binding of definition?.workloadBindings??[]){if(binding.phase!==phase||binding.value.kind!=='symbol')continue;const field=binding.value.name,parameter=modelAsset?.parameters.find(p=>p.key===binding.parameterKey),value=parameter?.default;if(value&&(value.kind==='integer'||value.kind==='number')&&Object.entries(workload).some(([key,current])=>key===field&&typeof current==='number')){const minimum=['pastTokensPerRequest','contextTokensPerRequest'].includes(field)?0:1;if(Number.isSafeInteger(value.value)&&value.value>=minimum)workload={...workload,[field]:value.value};}}
      const base=Scenario.parse({scenarioId:crypto.randomUUID(),name:'基准配置',model:modelRef,bindings:[],workload,deviceTopology:{devices:[{deviceId:'gpu0',hardware:hardwareRef}],groups:[{groupId:'main',members:['gpu0']}]},parallelPlan:{assignments:[],communications:[],assumptions:[]},executionPlan:{kind:'serial'},quantizationOverrides:[],numericOverrides:[],fusionGroups:[]});
      let initial={scenario:base,assets:snapshots};
      if(defaultDeclaredLayout(base,modelAsset)){
        try{initial=await prepareDeclaredLayout(base,snapshots);}catch{/* The canvas can apply the layout or show the binding error. */}
        if(ticket!==navigation.current||snapshot!==latest.current.text)return;
      }
      const next=ProjectDocument.parse({documentType:'project',schemaVersion:1,projectId:crypto.randomUUID(),projectRevision:1,name:entry.name+' · 模型工作区',scenarios:[initial.scenario],assetSnapshots:initial.assets,measurements:[],viewState:{nodes:[]}});openProject(next,null);change(JSON.stringify(next,null,2),true);
    }finally{if(pendingNavigation.current===ticket)pendingNavigation.current=null;}
  }
  useEffect(()=>{if(surface!=='canvas'||!report||draft||autoOpened.current)return;autoOpened.current=true;let last:string|null=null;let lastDraft:string|null=null;try{lastDraft=localStorage.getItem('model-studio:last-draft');}catch{}const pending=report.projectDrafts.find(d=>d.draftId===lastDraft);if(pending){void openStoredRecovery(pending);return;}try{last=localStorage.getItem('model-studio:last-workspace');}catch{/* No cache required. */}const existing=report.projects.find(p=>p.projectId===last&&p.scenarios.length);if(existing){void selectCurrentProject(existing.projectId);return;}const preferred=models.find(m=>/Qwen3-0.6B/i.test(m.name))??models.find(m=>/GQA.*attention/i.test(m.name))??models[0];if(preferred)void openCanvasModel(preferred.assetId).catch(e=>setError(String(e)));},[report,surface]);
  async function openStoredRecovery(summary:z.infer<typeof ProjectDraftIndexEntry>){
    const ticket=++navigation.current,snapshot=latest.current.text,scenarioSnapshot=latest.current.scenarioId,owner=()=>ticket===navigation.current&&snapshot===latest.current.text&&scenarioSnapshot===latest.current.scenarioId;
    importController.current?.abort();const controller=new AbortController();importController.current=controller;pendingNavigation.current=ticket;pendingImport.current=ticket;setImporting(ticket);
    try{
      const next=await getProjectDraft(summary.draftId,{signal:controller.signal});if(!owner())return;if(next.projectId!==summary.projectId)throw Error('草稿身份已变化，请刷新目录');
      const formal=await lookupProject(next.projectId,{signal:controller.signal});if(!owner())return;
      let baseline=formal?.projectRevision===next.baseProjectRevision?formal:null;
      if(!baseline&&next.baseProjectRevision!==null)try{baseline=await request('project',ProjectDocument,{projectId:next.projectId,revision:next.baseProjectRevision},{signal:controller.signal});}catch{}if(!owner())return;
      openDraft(next,formal,surface==='canvas',baseline);if(surface==='canvas')change(typeof next.candidate==='string'?next.candidate:JSON.stringify(next.candidate,null,2),true);
    }catch(e){if(owner())setError(String(e));}finally{if(pendingNavigation.current===ticket)pendingNavigation.current=null;if(pendingImport.current===ticket){pendingImport.current=null;if(importController.current===controller)importController.current=null;}setImporting(current=>current===ticket?null:current);}
  }
  function exportRaw(){const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download='model-analyser-project-source.'+(draft?.editorFormat==='yaml'?'yaml':'json');link.click();URL.revokeObjectURL(url);}
  async function proposeIdentity(){if(!draft||!preview.header?.projectId)return;const id={data:preview.header.projectId};const token=session.current,snapshot=latest.current.text,ticket=++navigation.current;pendingNavigation.current=ticket;try{const existing=await lookupProject(id.data);if(token!==session.current||snapshot!==latest.current.text||ticket!==navigation.current)return;setIdentityProposal({projectId:id.data,existing,text:snapshot,token});}catch(e){if(token===session.current)setError(String(e));}finally{if(pendingNavigation.current===ticket)pendingNavigation.current=null;}}
  function confirmIdentity(){const proposal=identityProposal;if(!proposal||!draft||proposal.token!==session.current||proposal.text!==latest.current.text)return;const next=ProjectDraft.parse({...draft,draftId:crypto.randomUUID(),projectId:proposal.projectId,baseProjectRevision:proposal.existing?.projectRevision??null,draftGeneration:0,updatedAt:new Date().toISOString(),candidate:text});openDraft(next,proposal.existing,true);change(text,true);}
  async function returnCanvas(){const token=session.current,snapshot=latest.current.text;clearTimeout(timer.current);try{await saver.current?.save(text,status.generation);if(token!==session.current||snapshot!==latest.current.text)return;let formal=saved.current;if(formal){formal=await request('project?id='+encodeURIComponent(formal.projectId),ProjectDocument);if(token!==session.current||snapshot!==latest.current.text)return;}setRepairMode(false);try{localStorage.removeItem('model-studio:last-draft');}catch{}if(formal)openProject(formal);else{setDraft(null);setText('');autoOpened.current=false;void refresh();}}catch(e){if(token===session.current)setError(String(e));}}

  async function rewriteIdentity(){if(!draft||!preview.header?.isProjectV1)return;const token=session.current,snapshot=latest.current.text,nav=navigation.current;identityEdit.current?.abort();const controller=new AbortController();identityEdit.current=controller;setIdentityEditing(true);try{const reply=await runProjectTextTask({taskId:crypto.randomUUID(),kind:'identity',text:snapshot,format:draft.editorFormat??'json',projectId:draft.projectId},controller.signal);if(controller.signal.aborted||identityEdit.current!==controller||token!==session.current||snapshot!==latest.current.text||nav!==navigation.current)return;if(reply.kind!=='identity')throw Error('正文身份返回错误阶段');change(reply.text,true);}catch(e){if(!controller.signal.aborted&&token===session.current&&snapshot===latest.current.text)setError(e instanceof Error?e.message:'正文身份修改失败');}finally{if(identityEdit.current===controller){identityEdit.current=null;setIdentityEditing(false);}}}
  if(surface==='canvas'&&repairMode&&draft){const header=preview.header,issues=[...preview.issues,...(preview.message?[preview.message]:[]),...(error?[error]:[])];return <ProjectRepairView draft={draft} baseline={recoveryBase.current} hasSavedModel={saved.current!==null} text={text} status={status} issues={issues} previewStatus={preview.status} onCancelPreview={preview.cancel} onRetryPreview={preview.retry} identityEditing={identityEditing} onChange={change} onExport={exportProject} onRaw={exportRaw} onRetry={()=>saver.current?.retry(text)} onBack={returnCanvas} canAdoptIdentity={!!header?.projectId} onAdoptIdentity={()=>void proposeIdentity()} identityProposal={identityProposal&&identityProposal.text===text&&identityProposal.token===session.current?{projectId:identityProposal.projectId,name:identityProposal.existing?.name??null,revision:identityProposal.existing?.projectRevision??null}:null} onConfirmIdentity={confirmIdentity} identityMismatch={!!header?.isProjectV1&&header.projectId!==draft.projectId} onIdentity={()=>void rewriteIdentity()}/>;}
  if(surface==='canvas')return <><ModelWorkspace recoveryTools={<>{importing!==null&&<small data-import-active>正在读取工作区…<button onClick={()=>{++navigation.current;importController.current?.abort();importController.current=null;pendingImport.current=null;pendingNavigation.current=null;setImporting(null);setError('工作区读取已取消，当前模型保留');}}>取消工作区读取</button></small>}{report?.projectDrafts.length?<button onClick={()=>setRecoveryPicker(true)}>恢复草稿（{report.projectDrafts.length}）</button>:null}</>} key={canvasSession} project={project} scenario={active} catalog={report?.assets??[]} status={status} error={error} onModel={openCanvasModel} onImport={importFile} onExport={exportProject} onScenario={patchScenario} onProject={update} onSelectConfiguration={setScenarioId} onCopyConfiguration={()=>{if(project&&active){const id=crypto.randomUUID();update(copyConfiguration(project,active.scenarioId,id));setScenarioId(id);}}} hardwareChoices={hardwareChoices} quantizationPresets={quantizationPresets} onHardware={applyHardware} onQuantization={applyQuantizationPreset} onUpdateModel={updateModelReference} onPreset={(next,required)=>{if(!project||!active)return;update({...project,assetSnapshots:mergeSnapshots(project.assetSnapshots,required),scenarios:project.scenarios.map(s=>s.scenarioId===active.scenarioId?next:s)});}} onLibrary={()=>{let assets=project?.assetSnapshots??[];try{if(active)assets=calculationInput(active,assets).assets;}catch{/* Invalid definitions remain inspectable for recovery. */}onOpenLibrary?.(assets);}} onEditStructure={editCanvas}/>{recoveryPicker&&<dialog open aria-label="恢复模型工作区草稿"><h2>待修复草稿</h2>{report?.projectDrafts.map(d=><button key={d.draftId} onClick={()=>{void openStoredRecovery(d);}}>{d.projectId} · 代次 {d.draftGeneration}</button>)}<button onClick={()=>setRecoveryPicker(false)}>关闭草稿列表</button></dialog>}{conflict&&<dialog open aria-label="工作区导入冲突"><h2>此模型工作区已存在</h2><button onClick={()=>{openProject(conflict.existing);setConflict(null);}}>打开已保存配置</button><button onClick={()=>{copyProject(conflict.incoming);setConflict(null);}}>导入为独立工作区</button><button onClick={()=>setConflict(null)}>取消导入</button></dialog>}</>;
  return <><header><div className="crumb">工作空间 <span>/</span> 项目与方案</div><DisplayUnitsControl/><span className="badge">项目快照 · 本地保存</span></header>
    <section className="heading"><div><div className="eyebrow">PROJECT WORKBENCH</div><h1>保存每一次分析假设</h1><p>工作负载与方案覆盖保存在项目中，资产引用固定到具体修订。</p></div><button className="primary" onClick={create}>＋ 新建项目</button></section>
    {error&&<div className="error" role="alert">{error}<button onClick={()=>setError('')}>关闭</button></div>}
    {conflict&&<dialog open aria-label="项目导入冲突"><h2>项目 ID 已存在</h2><p>当前 r{conflict.existing.projectRevision}；导入文件 r{conflict.incoming.projectRevision}。选择如何保留内容。</p><div><button onClick={()=>{copyProject(conflict.incoming);setConflict(null);}}>导入为独立项目</button><button onClick={()=>{openProject(conflict.incoming,conflict.existing.projectRevision);saved.current=conflict.existing;change(JSON.stringify(conflict.incoming,null,2),true);setConflict(null);}}>提交项目新修订</button><button onClick={()=>setConflict(null)}>取消导入</button></div></dialog>}
    <div className="workspace"><section className="library"><div className="panel-title"><h2>分析项目</h2><button onClick={()=>void refresh(true)}>↻ 刷新</button></div>
      <div className="project-list">{report?.projects.map(p=><button className={'asset '+(draft?.projectId===p.projectId?'chosen':'')} key={p.projectId} onClick={()=>void selectCurrentProject(p.projectId)}><span className="asset-icon">◇</span><span><strong>{p.name}</strong><small>{p.scenarios.length} 个方案 · r{p.projectRevision} · {p.assetSnapshotCount} 份快照</small></span></button>)}</div>
      <div className="draft-section"><h3>恢复项目草稿</h3>{report?.projectDrafts.map(d=><button className="draft" key={d.draftId} onClick={()=>void openStoredRecovery(d)}>◷ {d.projectId.slice(0,12)}<small>代次 {d.draftGeneration}</small></button>)}</div>
      <label className="import">↑ 导入项目 JSON / YAML<input aria-label="导入项目文件" type="file" accept=".json,.yaml,.yml" onChange={e=>{const file=e.target.files?.[0];if(file)void importFile(file);e.target.value='';}}/></label>
    </section><section className="editor project-editor"><div className="panel-title"><div><h2>{project?.name??'项目编辑器'}</h2><small>方案覆盖与资产定义分别保存</small></div>{draft&&<button onClick={exportProject}>↓ 导出项目 / 恢复文件</button>}</div>
      {draft?<><div className="project-preview-state" aria-live="polite">{preview.status==='pending'?<>正在后台校验正文预览；上次有效内容仅供查看…<button onClick={preview.cancel}>取消正文预览</button></>:preview.status==='canceled'||preview.status==='error'?<>正文预览已暂停，原文继续自动保存。<button onClick={preview.retry}>重试正文预览</button></>:null}</div><div className={'save-state '+status.status} role="status"><span className="dot"/>{status.message}{status.status==='save_failed'&&<button onClick={()=>saver.current?.retry(text)}>重试项目保存</button>}</div>
        {project&&<fieldset disabled={upgradeBusy||preview.status==='pending'} className="project-form"><label>项目名称<input aria-label="项目名称" value={project.name} onChange={e=>update({...project,name:e.target.value})}/></label><div className="asset-actions"><button onClick={()=>copyProject(project)}>复制项目</button><button disabled={!active} onClick={copyScenario}>复制方案</button></div>
          <div className="scenario-list">{project.scenarios.map(s=><button key={s.scenarioId} className={s.scenarioId===active?.scenarioId?'selected':''} onClick={()=>setScenarioId(s.scenarioId)}>{s.name}</button>)}</div>
          <div className="scenario-create"><label>新增方案模型<select aria-label="新增方案模型" value={modelId||models[0]?.assetId||''} onChange={e=>setModelId(e.target.value)}><option value="" disabled>暂无模型资产</option>{models.map(m=><option key={m.assetId} value={m.assetId}>{m.name} · r{m.revision}</option>)}</select></label><label>新增方案硬件<select aria-label="新增方案硬件" value={hardwareId||hardwares[0]?.assetId||''} onChange={e=>setHardwareId(e.target.value)}><option value="" disabled>暂无硬件资产</option>{hardwares.map(h=><option key={h.assetId} value={h.assetId}>{h.name} · r{h.revision}</option>)}</select></label><button disabled={!models.length||!hardwares.length} onClick={()=>void addScenario()}>添加方案</button></div>
          {active&&<div className="scenario-form" key={active.scenarioId}><label>方案名称<input aria-label="方案名称" value={active.name} onChange={e=>patchScenario({...active,name:e.target.value})}/></label><label>推理阶段<select aria-label="推理阶段" value={active.workload.kind} onChange={e=>{const shared={batchSize:active.workload.batchSize,queryTokensPerRequest:active.workload.queryTokensPerRequest};patchScenario({...active,workload:e.target.value==='prefill'?{kind:'prefill',...shared,pastTokensPerRequest:active.workload.kind==='decode'?active.workload.contextTokensPerRequest:active.workload.pastTokensPerRequest}:{kind:'decode',...shared,contextTokensPerRequest:active.workload.kind==='prefill'?active.workload.pastTokensPerRequest:active.workload.contextTokensPerRequest,steps:1}});}}><option value="prefill">Prefill</option><option value="decode">Decode</option></select></label><div className="workload-fields"><NumericField label="Batch" value={active.workload.batchSize} min={1} onChange={batchSize=>patchScenario({...active,workload:{...active.workload,batchSize}})}/><NumericField label="Query tokens" value={active.workload.queryTokensPerRequest} min={1} onChange={queryTokensPerRequest=>patchScenario({...active,workload:{...active.workload,queryTokensPerRequest}})}/>{active.workload.kind==='decode'?<><NumericField label="Context tokens" value={active.workload.contextTokensPerRequest} min={0} onChange={contextTokensPerRequest=>{if(active.workload.kind==='decode')patchScenario({...active,workload:{...active.workload,contextTokensPerRequest}});}}/><NumericField label="Decode steps" value={active.workload.steps} min={1} onChange={steps=>{if(active.workload.kind==='decode')patchScenario({...active,workload:{...active.workload,steps}});}}/></>:<NumericField label="Past tokens" value={active.workload.pastTokensPerRequest} min={0} onChange={pastTokensPerRequest=>{if(active.workload.kind==='prefill')patchScenario({...active,workload:{...active.workload,pastTokensPerRequest}});}}/>}</div><p className="scope-note">当前阶段：{active.workload.kind} · {project.assetSnapshots.find(a=>a.assetId===active.model.assetId&&a.revision===active.model.revision)?.name??'模型'} r{active.model.revision} · {active.deviceTopology.devices.length} 个物理设备</p><button disabled={!report?.assets.some(a=>a.kind==='model'&&a.assetId===active.model.assetId&&a.revision!==active.model.revision)} onClick={()=>void updateModelReference()}>将当前方案更新到库中最新模型修订</button></div>}
          <details className="snapshot-list"><summary>固定资产快照 · {project.assetSnapshots.length} 份</summary>{project.assetSnapshots.map(a=><p key={a.assetId+'@'+a.revision}>{a.name} · {a.definition.kind} · r{a.revision}<small>{a.assetId}</small></p>)}<p>资产库变化不会自动更新这些快照。依赖修改使用固定修订并经项目校验。</p></details>
          {active&&<DependencyUpgradeView key={project.projectId+':'+active.scenarioId} project={project} scenario={active} revision={saved.current?.projectRevision??null} ready={status.status==='committed'} index={report?.assets??[]} onPublished={upgradePublished} onBusyChange={busy=>{if(session.current===workspaceSession&&workspaceNavigation===navigation.current&&latest.current.projectId===project.projectId&&latest.current.scenarioId===active.scenarioId)setUpgradeBusy(busy);}}/>}
          {active&&<><AscendQuantizationEditor key={project.projectId+':'+active.scenarioId} project={project} scenario={active} onProject={update}/><QuantizationEditor key={'quantization:'+active.scenarioId} scenario={active} presets={quantizationPresets} onApply={applyQuantizationPreset} onRemove={index=>patchScenario(removeQuantizationRule(active,index))}/></>}
          {active&&<ParallelPresetEditor key={project.projectId+':preset:'+active.scenarioId} project={project} scenario={active} hardwareChoices={hardwareChoices} onHardware={applyHardware} onTopology={patchScenario} onApply={(next,required)=>{const assets=[...project.assetSnapshots];for(const a of required){const old=assets.find(v=>v.assetId===a.assetId&&v.revision===a.revision);if(old&&canonical(old)!==canonical(a))throw Error('预设资产与现有快照冲突');if(!old)assets.push(a);}update({...project,assetSnapshots:assets,scenarios:project.scenarios.map(s=>s.scenarioId===active.scenarioId?next:s)});}}/>}
          {active&&<MemoryPeakEditor key={'memory-peak:'+active.scenarioId} scenario={active} assets={project.assetSnapshots} onChange={patchScenario}/>}
          {active&&<FusionEditor key={'fusion:'+active.scenarioId} scenario={active} assets={project.assetSnapshots} onChange={patchScenario}/>}
          {active?.workload.kind==='decode'&&<label className="decode-approximation">Decode 上下文模式<select aria-label="Decode 上下文模式" value={active.workload.approximation??'growing_context'} onChange={e=>{if(active.workload.kind!=='decode')return;const {approximation,...workload}=active.workload;void approximation;patchScenario({...active,workload:e.target.value==='fixed_context'?{...workload,approximation:'fixed_context'}:workload});}}><option value="growing_context">逐步增长（默认）</option><option value="fixed_context">固定上下文近似</option></select></label>}
          {active&&<StructureView key={active.scenarioId} scenario={active} assets={project.assetSnapshots}/>}
          {active&&<ExecutionEditor key={'execution:'+active.scenarioId} scenario={active} assets={project.assetSnapshots} onChange={patchScenario}/>}
          {active&&<AnalysisView key={'analysis:'+project.projectId+':'+active.scenarioId} scenario={active} assets={project.assetSnapshots} measurements={project.measurements} onMeasurement={record=>update({...project,measurements:[...project.measurements,record]})} onMeasurements={records=>update({...project,measurements:mergeMeasurements(project.measurements,records)})}/>}
          {active&&<CapacityView key={'capacity:'+active.scenarioId} scenario={active} assets={project.assetSnapshots}/>}
          {project.scenarios.length>=2&&<ScenarioComparisonView key={'comparison:'+project.projectId} scenarios={project.scenarios} assets={project.assetSnapshots}/>}
          {active&&<ParallelView key={'parallel:'+active.scenarioId} scenario={active} assets={project.assetSnapshots}/>}
        </fieldset>}
        <details className="project-json" open={!project}><summary>高级编辑：项目 JSON</summary><textarea disabled={upgradeBusy} aria-label="项目定义 JSON" spellCheck={false} value={text} onChange={e=>change(e.target.value)}/></details>
      </>:<div className="empty"><div>◇</div><h2>创建可复现的分析项目</h2><p>选择已有项目，或导入包含完整资产快照的项目。<br/>工作负载修改自动保存，不会创建新资产。</p><button onClick={create}>创建分析项目 →</button></div>}
    </section></div><div className="bottom-note">项目数据与恢复草稿写入 data/projects。完整分析引擎仍在建设中。</div>
  </>;
}
