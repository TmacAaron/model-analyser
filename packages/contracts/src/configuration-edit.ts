import { ConfigurationDraft,ConfigurationFields,ProjectDocument,Scenario,type NumericOverride } from './index.js';
import { canonical } from './validation.js';
import { sourceDigest } from './source-digest.js';

export const configurationFields=(scenario:Scenario)=>ConfigurationFields.parse(Object.fromEntries(Object.entries(scenario).filter(([key])=>!['scenarioId','model','ascendQuantizationImports'].includes(key))));
export const configurationAssetKey=(project:ProjectDocument)=>sourceDigest(canonical(project.assetSnapshots));
export function configurationDraft(project:ProjectDocument,scenarioId:string){const scenario=project.scenarios.find(s=>s.scenarioId===scenarioId);if(!scenario)throw Error('当前配置不存在');return project.configurationDrafts?.find(d=>d.scenarioId===scenarioId)??ConfigurationDraft.parse({scenarioId,model:scenario.model,base:configurationFields(scenario),assetKey:configurationAssetKey(project),text:JSON.stringify(configurationFields(scenario),null,2),inputs:{}});}
export function writeConfigurationDraft(project:ProjectDocument,draft:ConfigurationDraft):ProjectDocument{return {...project,configurationDrafts:[...(project.configurationDrafts??[]).filter(d=>d.scenarioId!==draft.scenarioId),draft]};}
export function configurationDraftIsStale(project:ProjectDocument,draft:ConfigurationDraft){const s=project.scenarios.find(s=>s.scenarioId===draft.scenarioId);return !s||canonical(s.model)!==canonical(draft.model)||canonical(configurationFields(s))!==canonical(draft.base)||configurationAssetKey(project)!==draft.assetKey;}
export function resetConfigurationDraft(project:ProjectDocument,scenarioId:string){return {...project,configurationDrafts:project.configurationDrafts?.filter(d=>d.scenarioId!==scenarioId)};}
export function prepareConfigurationEdit(project:ProjectDocument,scenarioId:string):ProjectDocument{
  const draft=project.configurationDrafts?.find(d=>d.scenarioId===scenarioId);if(!draft)throw Error('没有待应用的配置草稿');if(configurationDraftIsStale(project,draft))throw Error('当前生效配置或固定资产已变化；请保留草稿，核对差异后重新建立基线');if(Object.values(draft.inputs).some(v=>v!==''))throw Error('尚有表单输入未加入配置草稿，请先加入或清空表单输入');
  let raw:unknown;try{raw=JSON.parse(draft.text) as unknown;}catch{throw Error('配置草稿JSON尚未完成');}const parsed=ConfigurationFields.safeParse(raw);if(!parsed.success)throw Error(parsed.error.issues.slice(0,5).map(i=>i.path.join('.')+' '+i.message).join('；'));
  return ProjectDocument.parse({...project,scenarios:project.scenarios.map(s=>s.scenarioId===scenarioId?{...s,...parsed.data}:s),configurationDrafts:project.configurationDrafts?.filter(d=>d.scenarioId!==scenarioId)});
}
const remapOverrides=(values:NumericOverride[],from:string,to:string)=>values.map(o=>o.target.kind==='scenario'&&o.target.scenarioId===from?{...o,target:{kind:'scenario' as const,scenarioId:to}}:o);
/** Copy valid staged values with remapped scenario targets; preserve unfinished JSON verbatim. */
export function copyConfiguration(project:ProjectDocument,scenarioId:string,newId:string):ProjectDocument{
  if(project.scenarios.some(s=>s.scenarioId===newId))throw Error('配置身份已存在');const source=project.scenarios.find(s=>s.scenarioId===scenarioId);if(!source)throw Error('当前配置不存在');const name=source.name+' · 副本',copy=Scenario.parse({...structuredClone(source),scenarioId:newId,name,numericOverrides:remapOverrides(source.numericOverrides,scenarioId,newId)}),draft=project.configurationDrafts?.find(d=>d.scenarioId===scenarioId);let next:ProjectDocument={...project,scenarios:[...project.scenarios,copy]};
  if(draft){let text=draft.text;try{const parsed=ConfigurationFields.safeParse(JSON.parse(text) as unknown);if(parsed.success)text=JSON.stringify({...parsed.data,name:parsed.data.name+' · 副本',numericOverrides:remapOverrides(parsed.data.numericOverrides,scenarioId,newId)},null,2);}catch{/* Preserve partial text. */}const base={...structuredClone(draft.base),name:draft.base.name+' · 副本',numericOverrides:remapOverrides(draft.base.numericOverrides,scenarioId,newId)};next=writeConfigurationDraft(next,ConfigurationDraft.parse({...structuredClone(draft),scenarioId:newId,base,text}));}return next;
}
