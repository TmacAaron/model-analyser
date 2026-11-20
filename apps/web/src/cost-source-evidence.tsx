import {useMemo,useState,type ReactNode} from 'react';
import type {AssetDocument,AssetRef,Provenance,ResolvedParameter,Scenario} from '@model-analyser/contracts';
import {ParameterValues} from './resolved-inspector-view.js';

const pageSize=20;
type AssetLookup=(ref:Pick<AssetRef,'assetId'|'revision'>)=>AssetDocument|undefined;

export function useSourceAssets(assets:AssetDocument[]):AssetLookup{
 return useMemo(()=>{
  const byId=new Map<string,Map<number,AssetDocument>>();
  for(const asset of assets){
   const revisions=byId.get(asset.assetId);
   if(!revisions)byId.set(asset.assetId,new Map([[asset.revision,asset]]));
   else if(!revisions.has(asset.revision))revisions.set(asset.revision,asset);
  }
  return ref=>byId.get(ref.assetId)?.get(ref.revision);
 },[assets]);
}

function DeferredEvidence({summary,className,children,fallback}:{summary:string;className?:string;children:()=>ReactNode;fallback?:ReactNode}){
 const [open,setOpen]=useState(false);
 return <details className={className} onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary>{summary}</summary>{open?children():fallback}
 </details>;
}

function EvidencePage<T>({rows,label,children}:{rows:readonly T[];label:string;children:(visible:T[],offset:number)=>ReactNode}){
 const [cursor,setCursor]=useState({owner:rows,page:0}),page=cursor.owner===rows?cursor.page:0,start=page*pageSize;
 return <>
  {children(rows.slice(start,start+pageSize),start)}
  {rows.length>pageSize&&<div className="button-row">
   {page>0&&<button onClick={()=>setCursor({owner:rows,page:page-1})}>上一页{label}</button>}
   <small>第 {page+1}/{Math.ceil(rows.length/pageSize)} 页</small>
   {start+pageSize<rows.length&&<button onClick={()=>setCursor({owner:rows,page:page+1})}>下一页{label}</button>}
  </div>}
 </>;
}

function ScopedParameters({parameters,sources}:{parameters:ResolvedParameter[];sources:Provenance['parameterSources']}){
 const matches=useMemo(()=>{
  const keys=new Set(sources.map(source=>source.parameterKey));
  return parameters.filter(parameter=>keys.has(parameter.nodeId+':'+parameter.parameterKey));
 },[parameters,sources]);
 return <EvidencePage rows={matches} label="参数">{page=><ParameterValues parameters={page}/>}</EvidencePage>;
}

export function ProvenanceEvidence({provenance,findAsset,parameters,missingParameters}:{
 provenance:Provenance;findAsset:AssetLookup;parameters:ResolvedParameter[]|undefined;missingParameters:string;
}){
 const {formulaRefs,assetRefs,parameterSources,assumptions}=provenance;
 return <>
  <h4>范围共用公式记录（非精确贡献）</h4>
  {formulaRefs.length?<EvidencePage rows={formulaRefs} label="公式">{rows=>rows.map(ref=>{
   const asset=findAsset(ref);
   return <p key={ref.assetId+'@'+ref.revision}><code>{ref.assetId}@r{ref.revision}</code><small>{asset?.definition.kind==='formula'?asset.definition.formula.expression:'当前快照未含此公式；保留固定引用'}</small></p>;
  })}</EvidencePage>:<p>此指标没有独立公式引用；查看固定值与假设。</p>}
  <DeferredEvidence summary={'固定资产依赖 · '+assetRefs.length}>{()=><EvidencePage rows={assetRefs} label="资产">{rows=>rows.map(ref=>
   <p key={ref.assetId+'@'+ref.revision}><code>{ref.assetId}@r{ref.revision}</code> · {ref.kind}</p>
  )}</EvidencePage>}</DeferredEvidence>
  <DeferredEvidence className="evaluated-parameters" summary={'参数值与来源 · '+parameterSources.length} fallback={parameters===undefined?<p>{missingParameters}</p>:undefined}>
   {()=>parameters!==undefined?<ScopedParameters parameters={parameters} sources={parameterSources}/>:<p>{missingParameters}</p>}
  </DeferredEvidence>
  <DeferredEvidence className="source-assumptions" summary={'求值假设与覆盖记录 · '+assumptions.length}>{()=><EvidencePage rows={assumptions} label="假设">
   {(rows,offset)=>rows.map((text,index)=><p key={offset+index}>{text}</p>)}
  </EvidencePage>}</DeferredEvidence>
 </>;
}

export function ConfigurationEvidence({scenario,findAsset}:{scenario:Scenario;findAsset:AssetLookup}){
 const {numericOverrides,deviceTopology}=scenario;
 return <>
  <h4>当前方案数值覆盖声明 · {numericOverrides.length}</h4>
  {numericOverrides.length?<EvidencePage rows={numericOverrides} label="覆盖">{(rows,offset)=>
   <div className="analysis-table source-overrides"><table>
    <thead><tr><th>来源 / 目标</th><th>字段 / 值</th><th>作者说明</th></tr></thead>
    <tbody>{rows.map((override,index)=><tr key={offset+index}>
     <td>numericOverrides #{offset+index+1}<small>{JSON.stringify(override.target)}</small></td>
     <td>{override.field}{override.parameterKey?' · '+override.parameterKey:''}<small>{override.value.value} {override.value.unit}</small></td>
     <td>{override.description||'未附说明'}</td>
    </tr>)}</tbody>
   </table></div>
  }</EvidencePage>:<p>当前方案没有数值覆盖。</p>}
  <DeferredEvidence summary="固定硬件规格与作者来源">{()=><EvidencePage rows={deviceTopology.devices} label="硬件">{rows=>rows.map(device=>{
   const asset=findAsset(device.hardware);
   return <div key={device.deviceId}><h4>{device.deviceId} · {device.hardware.assetId}@r{device.hardware.revision}</h4>
    <pre>{JSON.stringify(asset?.definition,null,2)}</pre><pre>{JSON.stringify(asset?.sources??[],null,2)}</pre></div>;
  })}</EvidencePage>}</DeferredEvidence>
 </>;
}
