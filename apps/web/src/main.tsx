import { DisplayUnitsProvider } from './display-units.js';
import React,{useEffect,useRef,useState} from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { AssetDocument,AssetDraft,AssetKind,ConfigSource,ConfigImportSeed,WorkspaceCatalog,AssetDraftIndexEntry,RequestAck,type AssetIndexEntry } from '@model-analyser/contracts';
import { canonical } from '../../../packages/contracts/src/validation.js';
import { evaluateFormula } from '@model-analyser/core';
import { getAsset,getAssetDraft,request,commitResponse,ApiFailure } from './api.js';
import { Autosaver,type SaveState } from './autosave.js';
import { ProjectWorkbench } from './project-workbench.js';
import { GraphEditor } from './graph-editor.js';
import { graphEditorAsset } from './graph-editing.js';
import { ConfigImportView } from './config-import-view.js';
import { HardwareEditor,hardwareEditorAsset } from './hardware-editor.js';
import { AlgorithmLibrary } from './algorithm-library.js';
import './style.css';
type StorageFormat=NonNullable<AssetDraft['storageFormat']>;
type ImportIntent=NonNullable<AssetDraft['importIntent']>;
const imported=(a:AssetDocument,mode:ImportIntent['mode']):ImportIntent=>({source:{assetId:a.assetId,revision:a.revision,kind:a.definition.kind},mode});
const names:Record<string,string>={model:'模型',module:'模块',operator:'算子',formula:'公式',parallel:'并行',quantization:'量化',hardware:'硬件'};
function download(name:string,text:string){const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);}
function LegacyApp({initialAssetId,initialAsset,embedded=false,onLibraryChange}:{initialAssetId?:string|undefined;initialAsset?:AssetDocument|undefined;embedded?:boolean;onLibraryChange?:()=>void}){
  const autoSelected=useRef(false);
  const [workspace,setWorkspace]=useState<'assets'|'projects'>(()=>new URL(window.location.href).searchParams.get('workspace')==='projects'&&!embedded?'projects':'assets');
  function navigate(next:'assets'|'projects'){saver.current?.flush();setWorkspace(next);const url=new URL(window.location.href);url.searchParams.set('workspace',next);window.history.replaceState(null,'',url);}
  const [assets,setAssets]=useState<AssetIndexEntry[]>([]),[drafts,setDrafts]=useState<z.infer<typeof AssetDraftIndexEntry>[]>([]),[error,setError]=useState('');
  const [selected,setSelected]=useState<{draft:AssetDraft;text:string;builtin:boolean}|null>(null),[text,setText]=useState(''),[filter,setFilter]=useState(''),[archived,setArchived]=useState(false);
  const [save,setSave]=useState<SaveState>({generation:0,status:'committed',message:'选择资产或创建定义'}),[values,setValues]=useState<Record<string,string>>({});
  const [scan,setScan]=useState<z.infer<typeof WorkspaceCatalog>|null>(null);
  const [importConflict,setImportConflict]=useState<{incoming:AssetDocument;current:AssetDocument;builtin:boolean;storageFormat:StorageFormat;matching?:AssetDocument;existingFormat?:StorageFormat;collision?:boolean}|null>(null);
  const [importStorage,setImportStorage]=useState<'json'|'source'>('json');
  const [newKind,setNewKind]=useState<z.infer<typeof AssetKind>>('formula');
  const [loadingAsset,setLoadingAsset]=useState(false),loadVersion=useRef(0);
  const [kindFilter,setKindFilter]=useState('all'),[familyFilter,setFamilyFilter]=useState('all');
  const saver=useRef<Autosaver|null>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),session=useRef(0);
  const scanGeneration=useRef(0),showArchived=useRef(archived);showArchived.current=archived;
  async function refresh(fresh=false){const generation=++scanGeneration.current;try{const report=await request('catalog'+(fresh?'?fresh=true':''),WorkspaceCatalog);if(generation!==scanGeneration.current)return;setScan(report);setAssets(report.assets.filter(a=>showArchived.current||!a.archived));setDrafts(report.drafts);setError('');}catch(e){if(generation===scanGeneration.current)setError(String(e));}}
  useEffect(()=>{void refresh();},[archived]);
  useEffect(()=>()=>{clearTimeout(timer.current);saver.current?.flush();},[]);
  useEffect(()=>{const guard=(event:BeforeUnloadEvent)=>{if(['dirty','saving_draft','validating','committing','save_failed'].includes(save.status)){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[save.status]);
  function open(draft:AssetDraft,builtin=false){
    loadVersion.current++;setLoadingAsset(false);
    clearTimeout(timer.current);saver.current?.flush();const token=++session.current;
    const value=typeof draft.candidate==='string'?draft.candidate:JSON.stringify(draft.candidate,null,2);
    setSelected({draft,text:value,builtin});setText(value);setValues({});setSave({generation:draft.draftGeneration,status:'draft_saved',message:builtin?(initialAsset?'固定来源 · 编辑会自动创建用户副本':'内置基线 · 编辑会自动创建用户副本'):'已载入 · 编辑后自动保存'});
    saver.current=new Autosaver(draft,state=>{if(session.current===token)setSave(state);if(state.status==='draft_saved')void refresh();},()=>{void refresh();onLibraryChange?.();});
  }
  function newFormula(){const id=crypto.randomUUID();const asset=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:id,revision:1,name:'自定义公式',tags:[],parameters:[],sources:[],definition:{kind:'formula',formula:{inputs:{x:{unit:'count',integerRequired:true,min:0}},expression:'2 * x',output:{unit:'operation',integerRequired:false,nonNegative:true},description:'输入 x，输出运算次数'}}});openAsset(asset,false,null);const current=saver.current;if(current){const value=JSON.stringify(asset,null,2);void current.save(value,current.edit(value));}}
  function newAsset(){
    if(newKind==='formula'){newFormula();return;}
    const assetId=crypto.randomUUID(),graph={inputs:[],outputs:[],edges:[],dependencies:[],tensors:[],storages:[],states:[]};
    const definitions={model:{kind:'model',family:'custom',variant:'custom',graph},module:{kind:'module',graph},
      operator:{kind:'operator',operator:{category:'custom',inputs:[],outputs:[],tensors:[],storages:[],states:[],phases:['prefill','decode']}},
      hardware:{kind:'hardware',hardware:{computeCapabilities:[],memoryCapabilities:[],communicationDefaults:[]}},
      parallel:{kind:'parallel',plan:{assignments:[],communications:[],assumptions:[]}},
      quantization:{kind:'quantization',quantization:{selector:{kind:'nodes',nodeIds:[]},weight:{}}},
    };
    const candidate={documentType:'asset',schemaVersion:1,assetId,revision:1,name:'自定义'+names[newKind],tags:[],parameters:[],sources:[],definition:definitions[newKind]};
    open(AssetDraft.parse({documentType:'asset_draft',schemaVersion:1,draftId:crypto.randomUUID(),assetId,assetKind:newKind,baseRevision:null,draftGeneration:0,updatedAt:new Date().toISOString(),candidate}));
    const value=JSON.stringify(candidate,null,2),current=saver.current;if(current)void current.save(value,current.edit(value));
  }
  function openAsset(asset:AssetDocument,builtin:boolean,baseRevision:number|null=asset.revision,storageFormat?:StorageFormat,importIntent?:ImportIntent){open(AssetDraft.parse({documentType:'asset_draft',schemaVersion:1,draftId:crypto.randomUUID(),assetId:asset.assetId,assetKind:asset.definition.kind,baseRevision,draftGeneration:0,updatedAt:new Date().toISOString(),candidate:asset,...(storageFormat?{storageFormat}:{}),...(importIntent?{importIntent}:{})}),builtin);}
  async function selectDraft(entry:z.infer<typeof AssetDraftIndexEntry>){const version=++loadVersion.current;setLoadingAsset(true);try{const draft=await getAssetDraft(entry.draftId);if(draft.assetId!==entry.assetId||draft.assetKind!==entry.assetKind)throw Error('草稿身份已变化，请刷新目录');if(version===loadVersion.current)open(draft);}catch(e){if(version===loadVersion.current)setError(String(e));}finally{if(version===loadVersion.current)setLoadingAsset(false);}}
  async function selectAsset(entry:AssetIndexEntry){const version=++loadVersion.current;setLoadingAsset(true);try{const asset=await getAsset(entry.assetId);if(version===loadVersion.current)openAsset(asset,entry.origin==='builtin',asset.revision,entry.origin==='user'?entry.format:undefined);}catch(e){if(version===loadVersion.current){setError(String(e));setLoadingAsset(false);}}}
  useEffect(()=>{if(initialAsset&&!autoSelected.current){autoSelected.current=true;openAsset(initialAsset,true);return;}if(initialAssetId&&!autoSelected.current){const entry=assets.find(a=>a.assetId===initialAssetId);if(entry){autoSelected.current=true;void selectAsset(entry);}}},[assets,initialAssetId,initialAsset]);
  function saveAsset(asset:AssetDocument,baseRevision:number|null,storageFormat?:StorageFormat,importIntent?:ImportIntent){openAsset(asset,false,baseRevision,storageFormat,importIntent);const value=JSON.stringify(asset,null,2),current=saver.current;if(current)void current.save(value,current.edit(value));}
  function copyAsset(original:AssetDocument,storageFormat?:StorageFormat,fromImport=false){saveAsset({...original,assetId:AssetDocument.shape.assetId.parse(crypto.randomUUID()),revision:1,name:original.name+'（副本）'},null,storageFormat,fromImport?imported(original,'next'):undefined);}
  async function importFile(file:File){
    const sourceFormat:StorageFormat=/\.ya?ml$/i.test(file.name)?'yaml':'json',storageFormat=importStorage==='source'?sourceFormat:'json',version=++loadVersion.current;setLoadingAsset(true);setImportConflict(null);
    try{
      const incoming=await request('decode-asset',AssetDocument,{text:await file.text(),format:sourceFormat});
      if(version!==loadVersion.current)return;
      const report=await request('catalog',WorkspaceCatalog),entry=report.assets.find(a=>a.assetId===incoming.assetId);if(version!==loadVersion.current)return;
      if(!entry){saveAsset(incoming,null,storageFormat,imported(incoming,'preserve'));return;}
      const current=await getAsset(incoming.assetId);if(version!==loadVersion.current)return;
      let collision=false;try{const same=await getAsset(incoming.assetId,incoming.revision);if(version!==loadVersion.current)return;if(canonical(same)===canonical(incoming)){if(entry.revision!==same.revision||entry.format!==storageFormat){setImportConflict({incoming,current,builtin:entry.origin==='builtin',storageFormat,matching:same,...(entry.revision===same.revision?{existingFormat:entry.format}:{})});return;}openAsset(same,entry.origin==='builtin',current.revision,entry.origin==='user'?entry.format:undefined);return;}collision=true;}catch(e){if(!(e instanceof ApiFailure)||e.code!=='not_found')throw e;}
      if(version!==loadVersion.current)return;
      setImportConflict({incoming,current,builtin:entry.origin==='builtin',storageFormat,collision});
    }catch(e){if(version===loadVersion.current)setError(e instanceof Error?e.message:String(e));}finally{if(version===loadVersion.current)setLoadingAsset(false);}
  }
  async function importConfig(file:File){const storageFormat:StorageFormat=importStorage==='source'&&/\.ya?ml$/i.test(file.name)?'yaml':'json',version=++loadVersion.current;setLoadingAsset(true);try{const source=await request('decode-config',ConfigSource,{sourceName:file.name,text:await file.text(),format:/\.ya?ml$/i.test(file.name)?'yaml':'json'});if(version!==loadVersion.current)return;const assetId=crypto.randomUUID(),seed=ConfigImportSeed.parse({...source,documentType:'config_import_seed',version:'config-import.1',assetId,name:file.name.replace(/\.[^.]+$/,'')+' · config 草稿'});open(AssetDraft.parse({documentType:'asset_draft',schemaVersion:1,draftId:crypto.randomUUID(),assetId,assetKind:'model',baseRevision:null,draftGeneration:0,updatedAt:new Date().toISOString(),candidate:seed,storageFormat}));const value=JSON.stringify(seed,null,2),current=saver.current;if(current)void current.save(value,current.edit(value));}catch(e){if(version===loadVersion.current)setError(String(e));}finally{if(version===loadVersion.current)setLoadingAsset(false);}}
  async function toggleArchive(id:string,value:boolean){try{await request('archive',RequestAck,{requestId:crypto.randomUUID(),assetId:id,archived:value});await refresh();onLibraryChange?.();}catch(e){setError(String(e));}}
  function change(value:string){
    if(selected?.builtin){const original=AssetDocument.parse(selected.draft.candidate),id=crypto.randomUUID();const copy={...original,assetId:id,revision:1,name:original.name+'（副本）'};
      let updated:unknown;try{updated=JSON.parse(value) as unknown;}catch{updated=undefined;}
      if(updated&&typeof updated==='object'&&!Array.isArray(updated))value=JSON.stringify({...updated,assetId:id,revision:1},null,2);
      else value=value.replace(original.assetId,id);
      openAsset(AssetDocument.parse(copy),false,null);
    }
    setText(value);const current=saver.current;if(!current)return;const generation=current.edit(value);clearTimeout(timer.current);timer.current=setTimeout(()=>{void current.save(value,generation);},650);
  }
  function retry(){saver.current?.retry(text);}
  const parsed=(()=>{try{return AssetDocument.safeParse(JSON.parse(text) as unknown);}catch{return undefined;}})();
  const asset=parsed?.success?parsed.data:undefined;
  const structuredAsset=graphEditorAsset(text);
  const hardwareAsset=hardwareEditorAsset(text);
  const configSeed=(()=>{try{const p=ConfigImportSeed.safeParse(JSON.parse(text) as unknown);return p.success?p.data:undefined;}catch{return undefined;}})();
  let formulaResult='';
  if(asset?.definition.kind==='formula')try{const bindings=Object.fromEntries(Object.entries(asset.definition.formula.inputs).map(([k,s])=>[k,{value:Number(values[k]??''),unit:s.unit}]));
    if(Object.keys(asset.definition.formula.inputs).every(k=>values[k]!==undefined&&values[k]!=='')){const result=evaluateFormula(asset.definition.formula,bindings);formulaResult=`${result.value.toLocaleString()} ${result.unit}`;}
  }catch(e){formulaResult=e instanceof Error?e.message:'公式错误';}
  return <div className="app"><aside><div className="brand"><span className="mark">M</span><div>Model Analyser<small>模型推理 · 理论分析</small></div></div>
    <div className="navlabel">工作空间 <span>LOCAL</span></div><button className={'nav '+(workspace==='assets'?'active':'')} onClick={()=>navigate('assets')}>◈ 资产库 <b>{assets.length}</b></button><button className={'nav '+(workspace==='projects'?'active':'')} onClick={()=>navigate('projects')}>◇ 项目与方案</button>
    <div className="sidebar-note"><strong>从定义开始</strong><p>公式、算子与模型都是可复用资产。有效编辑自动生成修订，项目通过快照固定版本。</p></div>
    <footer><span className="dot"/> 本地文件存储<small>数据目录：data/assets</small></footer></aside>
    <main><div className="mobile-nav"><button onClick={()=>navigate('assets')}>资产库</button><button onClick={()=>navigate('projects')}>项目与方案</button></div><div hidden={workspace!=='projects'}><ProjectWorkbench active={workspace==='projects'}/></div><div hidden={workspace!=='assets'}><header><div className="crumb">工作空间 <span>/</span> 资产库</div><span className="badge">本地资产 · 自动保存</span></header>
    <section className="heading"><div><div className="eyebrow">ASSET WORKBENCH</div><h1>构建你的分析基础</h1><p>管理结构与成本定义，让每一个假设都可编辑、可追溯。</p></div><div className="new-asset-controls"><select aria-label="新资产类型" value={newKind} onChange={e=>setNewKind(AssetKind.parse(e.target.value))}>{AssetKind.options.map(kind=><option key={kind} value={kind}>{names[kind]}</option>)}</select><button className="primary" onClick={newAsset}>＋ 新建{names[newKind]}</button></div></section>
    {error&&<div role="alert" className="error">{error}<button onClick={()=>void refresh()}>重试连接</button></div>}
    {!!scan?.issues.length&&<details className="scan-issues"><summary>文件诊断 · {scan.issues.length} 项（原文件保留）</summary>{scan.issues.map((issue,i)=><p key={i}><code>{issue.file}</code> · {issue.code}<br/>{issue.message}</p>)}</details>}
    {!!scan?.recoveries.length&&<section className="recoveries"><h2>未提交修订 · 等待恢复</h2>{scan.recoveries.map(r=><div key={r.assetId+'@'+r.revision}><span>{r.name} · r{r.revision}</span><button onClick={()=>void request('recover-revision',commitResponse,{requestId:crypto.randomUUID(),assetId:r.assetId,revision:r.revision,expectedRevision:r.expectedRevision}).then(()=>{onLibraryChange?.();return refresh();}).catch(e=>setError(String(e)))}>验证并恢复修订</button></div>)}</section>}
    {importConflict&&<dialog open aria-label="导入冲突"><h2>资产 ID 已存在</h2><p>导入“{importConflict.incoming.name}”r{importConflict.incoming.revision}，当前为 r{importConflict.current.revision}。同 ID 同修订的不同内容不会直接覆盖。</p>{importConflict.matching&&<p>修订内容相同，已有文件为 {importConflict.existingFormat?.toUpperCase()??'固定历史文件'}，本次选择 {importConflict.storageFormat.toUpperCase()}。可保留原文件，或按本次选择创建独立副本；历史修订不会改写。</p>}<div><button onClick={()=>{copyAsset(importConflict.incoming,importConflict.storageFormat,true);setImportConflict(null);}}>创建独立副本</button>{!importConflict.builtin&&!importConflict.matching&&<p>{importConflict.collision?'所选源修订已被不同内容占用；提交将生成本地下一修订，并记录导入来源。':'提交将保留文件中的固定修订号；补入历史不会回退当前库头。'}</p>}{!importConflict.builtin&&!importConflict.matching&&<button onClick={()=>{saveAsset(importConflict.incoming,importConflict.current.revision,importConflict.storageFormat,imported(importConflict.incoming,importConflict.collision?'next':'preserve'));setImportConflict(null);}}>作为新修订提交</button>}<button onClick={()=>{if(importConflict.matching)openAsset(importConflict.matching,importConflict.builtin,importConflict.current.revision,assets.find(a=>a.assetId===importConflict.current.assetId)?.format);setImportConflict(null);}}>保留现有资产</button></div></dialog>}
    <div className="workspace"><section className="library"><div className="panel-title"><h2>资产目录</h2><button onClick={()=>void refresh(true)}>↻ 重新扫描</button></div><input aria-label="搜索资产" placeholder="搜索名称或类型…" value={filter} onChange={e=>setFilter(e.target.value)}/>
      <label className="check"><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/>显示已归档</label>
      <div className="library-filters"><label>类型<select aria-label="资产类型筛选" value={kindFilter} onChange={e=>{setKindFilter(e.target.value);if(e.target.value!=='model')setFamilyFilter('all');}}><option value="all">全部类型</option>{AssetKind.options.map(k=><option key={k} value={k}>{names[k]}</option>)}</select></label><label>模型家族<select aria-label="模型家族筛选" value={familyFilter} onChange={e=>{setFamilyFilter(e.target.value);if(e.target.value!=='all')setKindFilter('model');}}><option value="all">全部家族</option>{[...new Set(assets.flatMap(a=>a.family?[a.family]:[]))].sort().map(f=><option key={f}>{f}</option>)}</select></label></div>
      <div className="asset-list">{assets.filter(a=>(kindFilter==='all'||a.kind===kindFilter)&&(familyFilter==='all'||a.family===familyFilter)&&(a.name+a.kind+(a.family??'')).toLowerCase().includes(filter.toLowerCase())).map(a=><button key={a.assetId} className={'asset '+(selected?.draft.assetId===a.assetId?'chosen':'')} onClick={()=>void selectAsset(a)}><span className="asset-icon">{a.kind==='formula'?'ƒ':'◇'}</span><span><strong>{a.name}</strong><small>{names[a.kind]}{a.family?' · '+a.family:''} · {a.origin==='builtin'?'内置':'用户'} · r{a.revision} · {a.format.toUpperCase()}{a.archived?' · 已归档':''}</small></span><span>›</span></button>)}</div>
      <div className="draft-section"><h3>恢复草稿 <span>{drafts.length}</span></h3>{drafts.map(d=><button className="draft" key={d.draftId} onClick={()=>void selectDraft(d)}>◷ {names[d.assetKind]} · {d.assetId.slice(0,12)}<small>编辑代次 {d.draftGeneration}</small></button>)}</div>
      <label className="import-storage">导入后的保存格式<select aria-label="导入存储格式" value={importStorage} onChange={e=>setImportStorage(e.target.value==='source'?'source':'json')}><option value="json">转为 JSON（默认）</option><option value="source">保留文件格式</option></select><small>新定义或新修订按此格式保存。相同修订可保留原文件，或创建独立副本；YAML 将规范化保存，不保留注释。</small></label>
      <label className="import">↑ 导入 JSON / YAML<input aria-label="导入资产文件" type="file" accept=".json,.yaml,.yml" onChange={e=>{const file=e.target.files?.[0];if(file)void importFile(file);e.target.value='';}}/></label>
      <label className="import">↑ 从 config 创建模型草稿<input aria-label="导入模型 config" type="file" accept=".json,.yaml,.yml" onChange={e=>{const file=e.target.files?.[0];if(file)void importConfig(file);e.target.value='';}}/></label>
    </section><section className="editor"><div className="panel-title"><div><h2>{asset?.name??'定义编辑器'}</h2><small>{selected?(selected.builtin?'内置定义':'用户定义')+' · '+(names[selected.draft.assetKind]??''):'选择左侧资产开始'}</small></div>{selected&&<button onClick={()=>download('asset-recovery.json',text)}>↓ 导出恢复文件</button>}</div>
      {selected?<><div className={'save-state '+save.status} role="status"><span className="dot"/>{loadingAsset?'正在读取资产…':save.message}{save.status==='save_failed'&&<button onClick={retry}>重试保存</button>}</div>
        {!selected.builtin&&<p className="asset-storage-format">后续保存格式：{(selected.draft.storageFormat??scan?.assets.find(a=>a.assetId===selected.draft.assetId)?.format??'json').toUpperCase()}</p>}
        {asset&&<div className="asset-actions"><button onClick={()=>copyAsset(asset)}>复制为新资产</button>{scan?.assets.some(a=>a.assetId===asset.assetId)&&<button onClick={()=>void toggleArchive(asset.assetId,!scan.assets.find(a=>a.assetId===asset.assetId)?.archived)}>{scan.assets.find(a=>a.assetId===asset.assetId)?.archived?'取消归档':'归档资产'}</button>}</div>}
        {(configSeed||asset?.configImport)&&<fieldset className="graph-editor-fieldset" disabled={loadingAsset}><ConfigImportView key={selected.draft.draftId} seed={configSeed} asset={asset} catalog={assets} onChange={change}/></fieldset>}
        {structuredAsset&&<fieldset className="graph-editor-fieldset" disabled={loadingAsset}><GraphEditor key={selected.draft.draftId} asset={structuredAsset} catalog={assets} onChange={next=>change(JSON.stringify(next,null,2))} onOpenReference={async ref=>{const version=++loadVersion.current;setLoadingAsset(true);try{const child=await getAsset(ref.assetId,ref.revision);if(version===loadVersion.current)openAsset(child,scan?.assets.find(a=>a.assetId===ref.assetId)?.origin==='builtin');}finally{if(version===loadVersion.current)setLoadingAsset(false);}}}/></fieldset>}
        {hardwareAsset&&<fieldset disabled={loadingAsset}><HardwareEditor key={selected.draft.draftId} asset={hardwareAsset} onChange={next=>change(JSON.stringify(next,null,2))}/></fieldset>}
        <div className="editor-tools"><span>定义 JSON</span><span>固定修订引用 · 自动保存</span></div><textarea aria-label="资产定义 JSON" disabled={loadingAsset} spellCheck={false} value={text} onChange={e=>change(e.target.value)}/>
        {asset?.definition.kind==='formula'&&<div className="preview"><h3>公式试算</h3><code>{asset.definition.formula.expression}</code><div className="bindings">{Object.entries(asset.definition.formula.inputs).map(([key,s])=><label key={key}>{key} <small>{s.unit}</small><input aria-label={'参数 '+key} type="number" value={values[key]??''} onChange={e=>setValues({...values,[key]:e.target.value})}/></label>)}</div><output>{formulaResult||'填写参数以验证公式结果'}</output></div>}
      </>:<div className="empty"><div>ƒ</div><h2>让成本从公式开始</h2><p>选择 GEMM 运算量，或创建自己的公式。<br/>编辑会自动保存为可复用资产。</p><button onClick={newFormula}>创建第一个定义 →</button></div>}
    </section></div><div className="bottom-note">结构配置与 JSON 编辑使用同一份定义；有效修改自动入库，项目通过固定快照与显式升级保持可复现。</div></div></main></div>;
}
function App(){const [library,setLibrary]=useState<AssetDocument[]|null>(null),[maintenance,setMaintenance]=useState<{id?:string;asset?:AssetDocument}|null>(null),[catalogRevision,setCatalogRevision]=useState(0);const libraryChanged=()=>setCatalogRevision(n=>n+1);if(new URL(window.location.href).searchParams.get('legacy')==='1')return <LegacyApp/>;return <><ProjectWorkbench active surface="canvas" catalogRevision={catalogRevision} onOpenLibrary={setLibrary}/>{library&&<AlgorithmLibrary snapshots={library} onClose={()=>setLibrary(null)} onManage={id=>{const asset=library?.find(a=>a.assetId===id);setMaintenance(id?{id,...(asset?{asset}:{})}:{});setLibrary(null);}}/>}{maintenance&&<dialog open className="studio-maintenance-dialog" aria-label="高级定义编辑"><div className="maintenance-header"><strong>模块／算子高级定义 · 自动保存与草稿恢复</strong><button onClick={()=>{setMaintenance(null);libraryChanged();}}>返回模型画布 ✕</button></div><LegacyApp initialAssetId={maintenance.id} initialAsset={maintenance.asset} embedded onLibraryChange={libraryChanged}/></dialog>}</>;}
const root=document.getElementById('root');if(root)createRoot(root).render(<DisplayUnitsProvider><App/></DisplayUnitsProvider>);
