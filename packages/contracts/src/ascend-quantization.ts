import { AscendQuantizationSource,QuantizationDefinition,NodeId,type AscendQuantizationMapping,type AscendQuantizationReview,type ProjectDocument,type ResolvedGraph,type AssetDocument,type Scenario } from './index.js';
import { sourceDigest } from './source-digest.js';
import { canonical } from './validation.js';

export const MAX_ASCEND_SOURCE_BYTES=8*1024*1024;
export const MAX_ASCEND_ENTRIES=100000;
export const MAX_QUANTIZATION_SOURCE_BYTES=16*1024*1024;
const auxiliaries=new Set(['weight_scale','weight_offset','input_scale','input_offset','quant_bias','deq_scale','kv_cache_scale','kv_cache_offset','scale','offset','index']);
/** JSON.parse supplies syntax validation; this bounded second pass rejects duplicate keys, including nested unknown metadata. */
function uniqueKeys(text:string){let p=0,nodes=0;const space=()=>{while(/\s/.test(text[p]??'')&&p<text.length)p++;};
  function string(){space();const start=p++;while(p<text.length){const c=text[p++];if(c==='\\'){p++;continue;}if(c==='"')return JSON.parse(text.slice(start,p)) as string;}throw Error('JSON字符串未闭合');}
  function value(depth:number){if(depth>48||++nodes>250000)throw Error('量化描述嵌套或节点数超过限制');space();const c=text[p];if(c==='{'){p++;space();const keys=new Set<string>();if(text[p]==='}'){p++;return;}while(p<text.length){const key=string();if(keys.has(key))throw Error('量化描述JSON字段重复：'+key);keys.add(key);space();p++;value(depth+1);space();if(text[p++]==='}')return;}}else if(c==='['){p++;space();if(text[p]===']'){p++;return;}while(p<text.length){value(depth+1);space();if(text[p++]===']')return;}}else if(c==='"')string();else while(p<text.length&&!/[\s,}\]]/.test(text[p]??''))p++;}
  value(0);
}
export function readAscendDescription(text:string):Record<string,unknown>{
  if(new TextEncoder().encode(text).length>MAX_ASCEND_SOURCE_BYTES)throw Error('Ascend描述文件超过8 MiB');const clean=text.charCodeAt(0)===0xfeff?text.slice(1):text;let data:unknown;try{data=JSON.parse(clean) as unknown;}catch{throw Error('Ascend描述不是有效JSON');}
  if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Ascend描述必须为JSON对象');uniqueKeys(clean);if(Object.keys(data).length>MAX_ASCEND_ENTRIES)throw Error('Ascend描述最多100000项');return data as Record<string,unknown>;
}
export function decodeAscendDescription(text:string,sourceName:string):AscendQuantizationSource{readAscendDescription(text);const sha256=sourceDigest(text);return AscendQuantizationSource.parse({sourceId:'ascend:'+sha256,sourceName,format:'ascend-description.1',text,sha256});}
export function verifyAscendSource(source:AscendQuantizationSource):Record<string,unknown>{const entries=readAscendDescription(source.text);if(source.sha256!==sourceDigest(source.text)||source.sourceId!=='ascend:'+source.sha256)throw Error('Ascend来源内容与SHA256/身份不符');return entries;}
export function ascendAuxiliaryIndex(entries:Record<string,unknown>):Map<string,string[]>{const map=new Map<string,string[]>();for(const key of Object.keys(entries)){const dot=key.lastIndexOf('.'),suffix=key.slice(dot+1);if(dot<0||!auxiliaries.has(suffix))continue;const base=key.slice(0,dot);map.set(base,[...(map.get(base)??[]),key]);}for(const list of map.values())list.sort();return map;}
export function expectedPayloadBits(label:string,category:AscendQuantizationMapping['category']):number|undefined{const m=/^W(\d+)A(\d+)(?:_DYNAMIC)?$/.exec(label);if(m&&category!=='state')return Number(m[category==='weight'?1:2]);return category==='state'&&label==='C8'?8:undefined;}
export function importMappingRule(source:AscendQuantizationSource,review:Pick<AscendQuantizationReview,'importId'>,mapping:AscendQuantizationMapping,entries:Record<string,unknown>,auxIndex=ascendAuxiliaryIndex(entries)){
  const label=entries[mapping.sourceKey];if(typeof label!=='string'||!label.trim())throw Error('映射字段必须为源文件中的字符串标签');if(auxiliaries.has(mapping.sourceKey.slice(mapping.sourceKey.lastIndexOf('.')+1)))throw Error('辅助字段不能另当主payload；请在对应权重的辅助规格中声明');
  if(!mapping.sourceKey.includes('.')&&!(mapping.category==='state'&&['kv_cache_type','kv_quant_type'].includes(mapping.sourceKey)&&label==='C8'))throw Error('总体类型或版本元数据不能替代逐张量字段');
  if(mapping.sourceKey.endsWith('.weight')&&mapping.category!=='weight')throw Error('源weight字段只能映射到权重存储');if(!mapping.note.trim())throw Error('每条映射必须说明辅助布局与精度假设');
  const bits=expectedPayloadBits(label,mapping.category);if(bits!==undefined&&mapping.specification.payloadBits!==bits)throw Error('payload位宽与源标签的对应字段不符');
  const base=mapping.sourceKey.endsWith('.weight')?mapping.sourceKey.slice(0,-7):mapping.sourceKey,keys=auxIndex.get(base)??[],names=new Set(mapping.specification.auxiliaries.map(a=>a.name));
  for(const key of keys)if(!names.has(key.slice(key.lastIndexOf('.')+1)))throw Error('缺少源辅助字段的明确规格：'+key);
  if(label==='FLOAT'&&mapping.specification.auxiliaries.length)throw Error('FLOAT保留模型原始格式，不隐式增加量化辅助项');
  if(label!=='FLOAT'&&!mapping.specification.auxiliaries.length)throw Error('源标签没有完整辅助布局；请明确声明辅助规格后确认');
  return QuantizationDefinition.parse({selector:{kind:'subtree',rootNodeId:NodeId.parse('$model')},storageIds:[mapping.storageId],[mapping.category]:mapping.specification,importOrigin:{importId:review.importId,sourceId:source.sourceId,sourceName:source.sourceName,sourceHash:source.sha256,sourceKey:mapping.sourceKey,sourceLabel:label,auxiliaryKeys:keys,note:mapping.note}});
}
export function ascendProjectProblems(project:ProjectDocument):string[]{const issues:string[]=[],sources=new Map<string,{source:AscendQuantizationSource;entries:Record<string,unknown>;aux:Map<string,string[]>}>();let bytes=0;
  for(const source of project.quantizationSources??[])try{if(sources.has(source.sourceId))throw Error('来源身份重复');bytes+=new TextEncoder().encode(source.text).length;const entries=verifyAscendSource(source);sources.set(source.sourceId,{source,entries,aux:ascendAuxiliaryIndex(entries)});}catch(e){issues.push(e instanceof Error?e.message:'量化来源无效');}
  if(bytes>MAX_QUANTIZATION_SOURCE_BYTES)issues.push('工作区量化来源合计超过16 MiB');
  for(const scenario of project.scenarios){const ids=new Set<string>(),expected:ReturnType<typeof importMappingRule>[]=[],actual=scenario.quantizationOverrides.filter(r=>r.importOrigin);
    for(const review of scenario.ascendQuantizationImports??[]){if(ids.has(review.importId))issues.push('配置内量化导入身份重复');ids.add(review.importId);const pack=sources.get(review.sourceId);if(!pack){issues.push('量化导入缺少完整固定来源');continue;}if(review.appliedMappings.length&&!review.appliedNote?.trim())issues.push('生效导入缺少明确确认说明');for(const mapping of review.appliedMappings)try{expected.push(importMappingRule(pack.source,review,mapping,pack.entries,pack.aux));}catch(e){issues.push(e instanceof Error?e.message:'量化映射无效');}}
    if(canonical(expected.map(r=>canonical(r)).sort())!==canonical(actual.map(r=>canonical(r)).sort()))issues.push('生效量化规则必须与已确认导入映射和来源完全一致');
  }return issues;
}

export function removeQuantizationRule(scenario:Scenario,index:number):Scenario{const rule=scenario.quantizationOverrides[index],origin=rule?.importOrigin;return {...scenario,quantizationOverrides:scenario.quantizationOverrides.filter((_,i)=>i!==index),...(origin?{ascendQuantizationImports:scenario.ascendQuantizationImports?.map(r=>r.importId===origin.importId?{...r,appliedMappings:r.appliedMappings.filter(m=>m.sourceKey!==origin.sourceKey||!rule.storageIds?.includes(m.storageId))}:r)}:{})};}
export function withoutQuantizationReviews(scenario:Scenario):Scenario{const {ascendQuantizationImports,...base}=scenario;void ascendQuantizationImports;return base;}

export type AscendCandidate={sourceKey:string;label:string;storageId:string;category:'weight'|'activation'|'state';owner:string;name:string};
/** Explicit Qwen3 template adapter. Unknown architectures and source names require manual mapping. */
export function ascendMappingCandidates(entries:Record<string,unknown>,resolved:ResolvedGraph,model:AssetDocument|undefined):AscendCandidate[]{
  if(model?.definition.kind!=='model'||model.definition.family!=='qwen3'||entries['version']!==undefined&&entries['version']!=='1.0.0')return [];
  const layerFields:Record<string,string>={'self_attn.q_proj':'q-weight','self_attn.k_proj':'k-weight','self_attn.v_proj':'v-weight','self_attn.o_proj':'o-weight','self_attn.q_norm':'q-norm-weight','self_attn.k_norm':'k-norm-weight','input_layernorm':'input-norm-weight','post_attention_layernorm':'post-norm-weight','mlp.gate_proj':'gate-weight','mlp.up_proj':'up-weight','mlp.down_proj':'down-weight'},rows:AscendCandidate[]=[];
  for(const [sourceKey,label] of Object.entries(entries)){if(typeof label!=='string')continue;let owner='$model',local=sourceKey==='model.embed_tokens.weight'?'embedding':sourceKey==='model.norm.weight'?'final-norm-weight':sourceKey==='lm_head.weight'?'embedding':undefined;
    const m=/^model\.layers\.(0|[1-9]\d*)\.(.+)\.weight$/.exec(sourceKey);if(m){owner='decoder['+m[1]+']';local=layerFields[m[2]??''];}if(!local)continue;const binding=resolved.objectBindings.find(b=>b.nodeId===owner)?.tensors.find(t=>t.localTensorId===local);let tensor=binding?resolved.graph.tensors.find(t=>t.tensorId===binding.tensorId):undefined;
    if(sourceKey==='lm_head.weight'){const head=resolved.graph.nodes.find(n=>n.nodeId==='lm-head'),weights=head?.body.kind==='opaque'?head.body.inputs.flatMap(p=>{const t=resolved.graph.tensors.find(t=>t.tensorId===p.tensorId),s=resolved.graph.storages.find(s=>s.storageId===t?.storageId);return t&&s?.category==='weight'?[t]:[];}):[];tensor=weights.length===1?weights[0]:undefined;}
    if(!tensor)continue;let storage=resolved.graph.storages.find(s=>s.storageId===tensor.storageId);const seen=new Set<string>();while(storage?.allocation.kind==='alias'){if(seen.has(storage.storageId)){storage=undefined;break;}seen.add(storage.storageId);const target=storage.allocation.targetStorageId;storage=resolved.graph.storages.find(s=>s.storageId===target);}
    if(storage?.category!=='weight'||storage.allocation.kind!=='tensor')continue;rows.push({sourceKey,label,storageId:storage.storageId,category:'weight',owner,name:resolved.containers.find(c=>c.nodeId===owner)?.name??model.name});
  }return rows;
}
