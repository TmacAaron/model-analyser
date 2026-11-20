import { AssetDocument,ConfigImportSeed,ConfigImportMetadata,ConfigMappingProfile,ParameterDef,ParameterValue,type ConfigImportIssue } from './index.js';

type Parameter=AssetDocument['parameters'][number];
type Resolution=ConfigImportMetadata['resolutions'][number];
const escape=(key:string)=>key.replaceAll('~','~0').replaceAll('/','~1');
export function configValue(raw:ConfigImportMetadata['rawConfig'],pointer:string):unknown {
  if(!pointer.startsWith('/'))return undefined;let current:unknown=raw;
  for(const key of pointer.slice(1).split('/').map(k=>k.replaceAll('~1','/').replaceAll('~0','~'))){if(current===null||typeof current!=='object'||Array.isArray(current)||!Object.hasOwn(current,key))return undefined;current=Reflect.get(current,key);}
  return current;
}
function equivalent(a:unknown,b:unknown):boolean {if(a===b)return true;if(a===null||b===null||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&equivalent(Reflect.get(a,k),Reflect.get(b,k)));}
export function mapConfigParameter(p:Parameter,raw:unknown,offset=0):ReturnType<typeof ParameterValue.parse>|undefined {
  let value:unknown=raw;if(offset){if(typeof value!=='number')return;value+=offset;}
  if(p.type==='integer'||p.type==='number'){if(typeof value!=='number'||!Number.isFinite(value)||(p.type==='integer'&&!Number.isSafeInteger(value))||(p.min!==undefined&&value<p.min)||(p.max!==undefined&&value>p.max))return;return p.type==='integer'?{kind:'integer',value}:{kind:'number',value};}
  if(p.type==='boolean'&&typeof value==='boolean')return {kind:'boolean',value};
  if(p.type==='enum'&&typeof value==='string'&&p.choices.includes(value))return {kind:'enum',value};
  return;
}
function leafPaths(raw:ConfigImportMetadata['rawConfig']):string[]{const paths:string[]=[];let count=0;function walk(value:unknown,path:string,depth:number){if(++count>10000||depth>24)throw Error('config 层级或字段数量超过预算');if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length){for(const [key,v] of Object.entries(value))walk(v,path+'/'+escape(key),depth+1);}else paths.push(path);}walk(raw,'',0);return paths.filter(Boolean);}
export function configProfileProblems(asset:AssetDocument):string[]{const p=asset.configMapping;if(!p)return [];const problems:string[]=[];if(asset.definition.kind!=='model')problems.push('config 映射仅适用于模型');const keys=p.parameters.map(r=>r.parameterKey);if(new Set(keys).size!==keys.length)problems.push('config 映射参数重复');for(const r of p.parameters){const target=asset.parameters.find(p=>p.key===r.parameterKey);if(!target)problems.push('映射目标参数缺失 '+r.parameterKey);if(!r.field.startsWith('/'))problems.push('映射路径必须为 JSON Pointer '+r.field);if(r.offset&&(target?.type!=='integer'&&target?.type!=='number'))problems.push('非数值参数不能使用偏移 '+r.parameterKey);}return problems;}
export function reviewConfigImport(asset:AssetDocument):ConfigImportIssue[]{
  const meta=asset.configImport;if(!meta)return [];const issues:ConfigImportIssue[]=[],seen=new Set<string>();
  const add=(key:string,field:string,code:string,message:string,severity:'error'|'review'='review')=>{if(seen.has(key))return;seen.add(key);issues.push({key,field,code,message,severity,resolved:severity==='review'&&meta.decisions.some(d=>d.key===key&&d.note.trim().length>0)});};
  if(asset.definition.kind!=='model')add('model-only','configImport','invalid_config_import','config 导入只适用于模型','error');
  if(meta.template.kind!=='model')add('template-kind','configImport.template','invalid_config_import','来源模板必须是模型','error');
  if(new Set(meta.resolutions.map(r=>r.parameterKey)).size!==meta.resolutions.length||new Set(meta.decisions.map(d=>d.key)).size!==meta.decisions.length)add('duplicates','configImport','invalid_config_import','映射或核对记录重复','error');
  const profile=meta.profile;for(const message of configProfileProblems({...asset,configMapping:profile}))add('profile:'+message,'configImport.profile','invalid_config_profile',message,'error');
  add('template-scope','template','template_scope',profile.description+'；'+profile.assumptions.join('；'));
  const modelType=configValue(meta.rawConfig,'/model_type');if(typeof modelType!=='string'||!profile.modelTypes.includes(modelType))add('model-type','/model_type','unmatched_model_type','未精确匹配 model_type；按用户所选相近模板建立草稿，不能认定结构已适配。');
  for(const r of profile.parameters){const p=asset.parameters.find(p=>p.key===r.parameterKey);if(!p)continue;const source=configValue(meta.rawConfig,r.field),auto=mapConfigParameter(p,source,r.offset),resolution=meta.resolutions.find(v=>v.parameterKey===p.key);
    if(!resolution){if(r.required||source!==undefined)add('mapping:'+p.key,r.field,source===undefined?'missing_field':'invalid_field',`${r.field} → ${p.key} ${source===undefined?'缺失':'类型/范围不合法'}；请手工补充，不沿用模板默认值。`,'error');continue;}
    const checked=mapConfigParameter(p,resolution.value.value);if(!checked||checked.kind!==resolution.value.kind)add('mapping-type:'+p.key,r.field,'invalid_mapping',`${p.key} 的映射值类型或范围不合法`,'error');
    if(resolution.origin==='config'&&(!auto||!equivalent(auto,resolution.value)))add('mapping-source:'+p.key,r.field,'invalid_mapping',`${p.key} 的来源值与映射记录不同，请重新映射或明确使用手工值`,'error');
    if(!equivalent(p.default,resolution.value))add('mapping-value:'+p.key,r.field,'mapping_changed',`${p.key} 当前默认值与导入记录不同；请在导入表中采用当前值或重新填写`,'error');
  }
  for(const r of meta.resolutions)if(!profile.parameters.some(p=>p.parameterKey===r.parameterKey))add('extra-mapping:'+r.parameterKey,'configImport.resolutions','invalid_mapping','未声明的参数映射 '+r.parameterKey,'error');
  for(const c of profile.constraints){const value=configValue(meta.rawConfig,c.field);if(value===undefined&&!c.required)continue;if(!equivalent(value,c.expected))add('constraint:'+c.field,c.field,value===undefined?'missing_constraint':'unsupported_value',`${c.description}；模板期望 ${JSON.stringify(c.expected)}，来源为 ${value===undefined?'缺失':JSON.stringify(value)}。未自动改写结构，需修正结构或明确记录模板近似。`);}
  const known=['/model_type','/architectures',...profile.parameters.map(r=>r.field),...profile.constraints.map(c=>c.field),...profile.ignoredFields.map(c=>c.field)];
  const quantFields=new Set(['bits','w_bit','group_size','q_group_size','quant_method','desc_act','sym','zero_point','version','modules_to_not_convert']);
  try{for(const field of leafPaths(meta.rawConfig)){if(field==='/quantization_config'||field.startsWith('/quantization_config/')){const tail=field.split('/')[2]??'',recognized=quantFields.has(tail);add('quant:'+field,field,recognized?'quantization_unapplied':'unknown_quantization',`${recognized?'已识别量化元数据':'未识别量化字段'} ${JSON.stringify(configValue(meta.rawConfig,field))}；尚未应用到存储位宽、辅助项或 ComputeClass，请显式配置量化或记录未采用的原因。`);}else if(!known.some(k=>field===k||field.startsWith(k+'/')))add('unknown:'+field,field,'unknown_field','未自动映射字段；原值保留在来源中，不能当作已支持。');}}
  catch(e){add('config-budget','rawConfig','config_limit',e instanceof Error?e.message:'config 超过预算','error');}
  if(meta.status==='confirmed'&&asset.definition.kind==='model')for(const issue of issues.filter(i=>i.severity==='review'&&i.resolved)){const note=meta.decisions.find(d=>d.key===issue.key);if(note&&!asset.definition.assumptions?.includes(configAssumption(issue,note.note)))add('assumption:'+issue.key,'definition.assumptions','missing_config_assumption','已核对的未自动映射内容必须保留在模型假设中：'+issue.field,'error');}
  return issues;
}
function configAssumption(issue:ConfigImportIssue,note:string){return `Config import review: ${issue.field} · ${issue.message} 用户说明：${note}`;}
export function genericConfigProfile(asset:AssetDocument):ConfigMappingProfile {return ConfigMappingProfile.parse({profileId:'manual-template',modelTypes:[],description:'自选模板，仅按明确参数键映射；结构一致性由用户核对。',parameters:asset.parameters.filter(p=>!['B','Q','C'].includes(p.key)).map(p=>({field:'/'+escape(p.key),parameterKey:p.key,required:true})),constraints:[],ignoredFields:[],assumptions:['没有此模型的已核对 config 映射；保留所选模板的固定结构与成本假设，用户需要补充未知语义。']});}
export function createConfigModel(seed:ConfigImportSeed,template:AssetDocument):AssetDocument {
  if(template.definition.kind!=='model')throw Error('请选择模型模板');const profile=template.configMapping??genericConfigProfile(template),problems=configProfileProblems({...template,configMapping:profile});if(problems.length)throw Error(problems.join('；'));
  const resolutions:Resolution[]=profile.parameters.flatMap(r=>{const p=template.parameters.find(p=>p.key===r.parameterKey),v=p?mapConfigParameter(p,configValue(seed.rawConfig,r.field),r.offset):undefined;return v?[{parameterKey:r.parameterKey,value:v,origin:'config' as const}]:[];});
  const {configMapping,...base}=template;void configMapping;
  return AssetDocument.parse({...base,assetId:seed.assetId,revision:1,name:seed.name||seed.sourceName,description:'由 config 创建的待核对模型；未采用字段和模板近似需明确记录。',tags:[...template.tags,'config-import'],sources:[...template.sources,{kind:'note',text:'Imported local config: '+seed.sourceName}],
    parameters:template.parameters.map(p=>{const r=resolutions.find(r=>r.parameterKey===p.key);if(r)return {...p,default:r.value};if(profile.parameters.some(r=>r.parameterKey===p.key&&r.required)){const {default:old,...rest}=p;void old;return rest;}return p;}),
    definition:{...template.definition,family:typeof seed.rawConfig['model_type']==='string'&&seed.rawConfig['model_type'].trim()?seed.rawConfig['model_type']:template.definition.family,variant:'config-'+profile.profileId,
      graph:{...template.definition.graph,nodes:template.definition.graph.nodes.map(n=>n.repeat?{...n,name:'重复 '+n.nodeId+' · '+(n.repeat.count.kind==='symbol'?n.repeat.count.name:'显式次数')}:n)},
      assumptions:['Imported variant: current layer/expert/dimension counts come from this asset parameter table and bindings. Baseline numbers in source notes describe the original preset.',...(template.definition.assumptions??[]).map(note=>'Template reference note (baseline-specific numbers are not imported variant counts): '+note)]},
    configImport:{version:'config-import.1',sourceName:seed.sourceName,format:seed.format,rawConfig:seed.rawConfig,template:{assetId:template.assetId,revision:template.revision,kind:'model'},profile,resolutions,decisions:[],status:'review'}});
}
export function setConfigParameter(asset:AssetDocument,key:string,value:ReturnType<typeof ParameterValue.parse>|undefined):AssetDocument {
  if(!asset.configImport)throw Error('缺少 config 导入记录');const p=asset.parameters.find(p=>p.key===key);if(!p)throw Error('参数不存在');if(value&&!mapConfigParameter(p,value.value))throw Error('参数值类型或范围不合法');
  const resolutions=asset.configImport.resolutions.filter(r=>r.parameterKey!==key);if(value)resolutions.push({parameterKey:key,value,origin:'manual'});
  return {...asset,parameters:asset.parameters.map(p=>{if(p.key!==key)return p;if(value)return ParameterDef.parse({...p,default:value});const {default:old,...rest}=p;void old;return rest;}),configImport:{...asset.configImport,resolutions,status:'review'}};
}
export function remapConfigField(asset:AssetDocument,key:string,field:string):AssetDocument {
  const meta=asset.configImport,p=asset.parameters.find(p=>p.key===key);if(!meta||!p||!field.startsWith('/'))throw Error('请输入 JSON Pointer（例如 /hidden_size）');
  const rules=meta.profile.parameters.map(r=>r.parameterKey===key?{...r,field}:r),rule=rules.find(r=>r.parameterKey===key);if(!rule)throw Error('映射规则不存在');
  const value=mapConfigParameter(p,configValue(meta.rawConfig,field),rule.offset),next=setConfigParameter(asset,key,value);if(!next.configImport)throw Error();return {...next,configImport:{...next.configImport,profile:{...meta.profile,parameters:rules},resolutions:next.configImport.resolutions.map(r=>r.parameterKey===key?{...r,origin:'config'}:r)}};
}
export function decideConfigIssue(asset:AssetDocument,key:string,note:string):AssetDocument {const meta=asset.configImport;if(!meta)throw Error('缺少 config 导入记录');return {...asset,configImport:{...meta,status:'review',decisions:[...meta.decisions.filter(d=>d.key!==key),...(note.trim()?[{key,note}]:[])]}};}
export function confirmConfigModel(asset:AssetDocument):AssetDocument {
  if(!asset.configImport||asset.definition.kind!=='model')throw Error('缺少模型 config 导入记录');const issues=reviewConfigImport({...asset,configImport:{...asset.configImport,status:'review'}});if(issues.some(i=>!i.resolved))throw Error('请先补全映射并逐项说明所有未自动采用的字段/模板假设。');
  return {...asset,definition:{...asset.definition,assumptions:[...(asset.definition.assumptions??[]).filter(a=>!a.startsWith('Config import review: ')),...issues.flatMap(i=>{const d=asset.configImport?.decisions.find(d=>d.key===i.key);return d?[configAssumption(i,d.note)]:[];})]},configImport:{...asset.configImport,status:'confirmed'}};
}
