import {quantizationEmitter,type QuantizationObserver} from './quantization-observation.js';
import { QuantizedStorageSpec,type ResolvedGraph,type Scenario,type AssetDocument,type Diagnostic,type NodeId,type StorageId } from '@model-analyser/contracts';
import { canonical } from '../../contracts/src/validation.js';
import { FormulaError } from './formula.js';
import { allocateStorage,numericValue } from './storage.js';
import { quantizationRuleIssues } from '../../contracts/src/quantization-validation.js';
import { scopedNumericSymbols } from './evaluation-scope.js';
import { decodeContextModules } from '../../contracts/src/parallel-bindings.js';

const inside=(id:string,root:string)=>root==='$model'||id===root||id.startsWith(root+'/')||id.startsWith(root+'[');
type WeightProfile=NonNullable<Extract<AssetDocument['definition'],{kind:'quantization'}>['modelWeights']>;
type WeightTarget=WeightProfile['moduleRules'][number]['targets'][number];

function resolveWeightTargets(profile:WeightProfile,resolved:ResolvedGraph,scenario:Scenario,assets:AssetDocument[]){
  if(profile.model.kind!=='model'||profile.model.assetId!==scenario.model.assetId||profile.model.revision!==scenario.model.revision){
    throw new FormulaError('incompatible_model_weight_profile','发布权重预设只适用于 '+profile.model.assetId+' r'+profile.model.revision);
  }
  const bindings=new Map(resolved.objectBindings.map(binding=>[binding.nodeId,binding]));
  const byStorage=new Map<StorageId,WeightTarget>();
  const context=scenario.workload.kind==='decode'?scenario.parallelPlan.decodeContext:undefined;
  const replacements=context?decodeContextModules(context):[];
  const sameRef=(a:WeightProfile['moduleRules'][number]['module'],b:typeof a)=>a.assetId===b.assetId&&a.revision===b.revision&&a.kind===b.kind;
  for(const section of profile.moduleRules){
    const replacement=replacements.find(row=>sameRef(row.module,section.module))?.replacement;
    if(replacement){
      const original=assets.find(asset=>asset.assetId===section.module.assetId&&asset.revision===section.module.revision);
      const substituted=assets.find(asset=>asset.assetId===replacement.assetId&&asset.revision===replacement.revision);
      if(original?.definition.kind!=='module'||substituted?.definition.kind!=='module'){
        throw new FormulaError('incompatible_model_weight_profile','Decode 替代模块需要兼容的发布权重声明');
      }
      const before=original.definition.graph.storages,after=substituted.definition.graph.storages;
      for(const target of section.targets){
        const a=before.find(row=>row.storageId===target.storageId),b=after.find(row=>row.storageId===target.storageId);
        if(!a||!b||canonical(a)!==canonical(b))throw new FormulaError('incompatible_model_weight_profile','Decode 替代模块的发布权重存储发生变化 '+target.storageId);
      }
    }
    const calls=resolved.containers.filter(row=>bindings.has(row.nodeId)&&(sameRef(row.asset,section.module)||replacement&&sameRef(row.asset,replacement)));
    if(!calls.length)throw new FormulaError('invalid_model_weight_profile','当前图缺少发布权重模块 '+section.module.assetId);
    for(const call of calls){
      const binding=bindings.get(call.nodeId);
      if(!binding)throw new FormulaError('invalid_model_weight_profile','发布权重模块缺少存储映射 '+call.nodeId);
      const byLocalId=new Map(binding.storages.map(row=>[row.localStorageId,row.storageId]));
      for(const target of section.targets){
        const id=byLocalId.get(target.storageId);
        if(!id||byStorage.has(id))throw new FormulaError('invalid_model_weight_profile','发布权重存储不存在或重复 '+call.nodeId+'/'+target.storageId);
        byStorage.set(id,target);
      }
    }
  }
  return byStorage;
}

/** Transform only the expanded copy. A canonical physical allocation cannot have two incompatible formats. */
export function applyQuantization(resolved:ResolvedGraph,scenario:Scenario,assets:AssetDocument[],diagnostics:Diagnostic[],observer?:QuantizationObserver,hasExecution=false):void{
  const emit=quantizationEmitter(observer);
  const rules=scenario.quantizationOverrides;if(!rules.length)return;
  for(const rule of rules){const issue=quantizationRuleIssues(rule,assets,scenario.model)[0];if(issue)throw new FormulaError(issue.code,issue.message);}
  const graph=resolved.graph,storages=new Map(graph.storages.map(s=>[s.storageId,s])),tensors=new Map(graph.tensors.map(t=>[t.tensorId,t])),leaves=new Set(graph.nodes.map(n=>n.nodeId));
  const bindings=new Map(resolved.objectBindings.map(b=>[b.nodeId,b]));
  const scopes=new Set([...leaves,...resolved.containers.map(c=>c.nodeId),...bindings.keys()]);
  const uses=new Map<StorageId,Set<NodeId>>(),owners=new Map<StorageId,Set<NodeId>>(),canonicalIds=new Map<StorageId,StorageId>();
  function canonicalStorage(id:StorageId):StorageId{const prior=canonicalIds.get(id);if(prior)return prior;const first=id,seen=new Set<StorageId>();while(true){const s=storages.get(id);if(!s)throw new FormulaError('missing_reference','量化引用缺少存储 '+id);if(s.allocation.kind!=='alias'){canonicalIds.set(first,id);return id;}if(seen.has(id))throw new FormulaError('dependency_cycle','量化存储 alias 环');seen.add(id);id=s.allocation.targetStorageId;}}
  function note(target:Map<StorageId,Set<NodeId>>,id:StorageId,nodeId:NodeId){id=canonicalStorage(id);const nodes=target.get(id);if(nodes)nodes.add(nodeId);else target.set(id,new Set([nodeId]));}
  const use=(id:StorageId,nodeId:NodeId)=>note(uses,id,nodeId);
  for(const binding of resolved.objectBindings)for(const storage of binding.storages)note(owners,storage.storageId,binding.nodeId);
  for(const n of graph.nodes){if(n.body.kind!=='opaque')continue;for(const p of n.portBindings){const t=tensors.get(p.tensorId);if(t)use(t.storageId,n.nodeId);}for(const s of bindings.get(n.nodeId)?.storages??[])use(s.storageId,n.nodeId);for(const c of [n.body.cost,...(n.body.localCost?[n.body.localCost.cost]:[])])for(const id of [...c.memoryAccess.map(a=>a.storageId),...c.temporaryStorageIds])use(id,n.nodeId);if(n.body.localCost){const r=n.body.localCost;if(r.participation.kind==='storage_layout')use(r.participation.storageId,n.nodeId);for(const b of r.bindings)if(b.source.kind==='storage_bytes')use(b.source.storageId,n.nodeId);}}
  const selections=rules.map((rule,index)=>{
    const preset=rule.preset&&assets.find(asset=>asset.assetId===rule.preset?.assetId&&asset.revision===rule.preset.revision);
    const profile=preset?.definition.kind==='quantization'?preset.definition.modelWeights:undefined;
    const targets=profile?resolveWeightTargets(profile,resolved,scenario,assets):undefined;
    for(const id of rule.storageIds??[])if(!storages.has(id)||canonicalStorage(id)!==id)throw new FormulaError('invalid_quantization_storage','精确量化目标必须为当前图的规范存储 '+id);
    const roots=rule.selector.kind==='nodes'?rule.selector.nodeIds:[rule.selector.rootNodeId];
    for(const root of roots)if(!scopes.has(root))throw new FormulaError('empty_selector','量化规则 #'+(index+1)+' 未匹配当前阶段范围 '+root);
    return {rule,index,roots,targets,storageIds:rule.storageIds?new Set(rule.storageIds):undefined};
  });
  function bound(spec:ResolvedGraph['quantizationApplications'][number]['specification'],nodeId:NodeId,storageId:StorageId,ruleIndex:number,target?:WeightTarget){
    const selected=observer?.storageIds.has(storageId),symbols=scopedNumericSymbols(resolved.parameters,scenario.workload,nodeId,selected&&emit?assignment=>emit({kind:'scope_assignment',storageId,nodeId,ruleIndex,assignment}):undefined);
    const axis=(key:string)=>target?.axes&&Object.hasOwn(target.axes,key)?target.axes[key]??key:key;
    const specification=QuantizedStorageSpec.parse({...spec,auxiliaries:spec.auxiliaries.map(a=>{
      const count=a.count;
      if(count.kind==='formula')return {...a,count:{kind:'formula',value:{kind:'literal',quantity:{value:numericValue(count.value,'count',{symbols,assets},true),unit:'count'}}}};
      if(count.kind==='channel')return {...a,count:{...count,axisId:axis(count.axisId)}};
      if(count.kind==='block')return {...a,count:{...count,axes:count.axes.map(item=>({...item,axisId:axis(item.axisId)}))}};
      return a;
    })});if(selected)emit?.({kind:'specification_bound',storageId,nodeId,ruleIndex,raw:spec,specification});return specification;
  }
  const matchedTargets=new Set<string>();let applied=0;for(const storage of graph.storages){if(storage.allocation.kind==='alias'||!['weight','activation','state'].includes(storage.category))continue;const category=storage.category as 'weight'|'activation'|'state',consumers=uses.get(storage.storageId),storageOwners=[...owners.get(storage.storageId)??[]],contexts=consumers?.size?[...consumers]:storageOwners.filter(id=>!storageOwners.some(other=>other!==id&&inside(other,id)));
    const decisions=contexts.map(nodeId=>{const candidates=selections.filter(s=>s.rule[category]&&(!s.storageIds||s.storageIds.has(storage.storageId))&&(!s.targets||s.targets.has(storage.storageId))&&s.roots.some(root=>inside(nodeId,root))).map(s=>({...s,priority:s.storageIds?3:s.targets?0:s.rule.selector.kind==='nodes'&&s.roots.includes(nodeId)&&leaves.has(nodeId)?2:1})),priority=Math.max(0,...candidates.map(c=>c.priority)),winners=candidates.filter(c=>c.priority===priority),specs=winners.map(c=>{const target=c.targets?.get(storage.storageId),raw=target?.specification??c.rule[category];if(!raw)throw new FormulaError('invalid_quantization','缺少已选量化规则');return bound(raw,nodeId,storage.storageId,c.index,target);});if(specs.some(s=>canonical(s)!==canonical(specs[0])))throw new FormulaError('ambiguous_quantization','相同优先级量化规则冲突：'+nodeId+' → '+storage.storageId);const losers=candidates.filter(c=>c.priority<priority),spec=specs[0]??(storage.allocation.kind==='tensor'?storage.allocation.quantization:undefined);if(observer?.storageIds.has(storage.storageId))emit?.({kind:'rule_decision',storageId:storage.storageId,nodeId,winners:winners.map(c=>({ruleIndex:c.index,priority:c.priority})),losers:losers.map(c=>({ruleIndex:c.index,priority:c.priority})),...(spec?{specification:spec}:{})});return {nodeId,winners,losers,spec};});
    for(const d of decisions)for(const candidate of [...d.winners,...d.losers])matchedTargets.add(JSON.stringify([candidate.index,storage.storageId]));if(!decisions.some(d=>d.winners.length))continue;if(storage.allocation.kind!=='tensor')throw new FormulaError('invalid_quantization','量化需要 shape/dtype，不能猜测 bytes 分配 '+storage.storageId);
    if(decisions.some(d=>canonical(d.spec??null)!==canonical(decisions[0]?.spec??null)))throw new FormulaError('shared_quantization_conflict','同一规范存储在不同使用节点有不同量化要求：'+storage.storageId+'；请统一规则或拆分存储');
    const specification=decisions.find(d=>d.winners.length)?.spec;if(specification&&decisions.some(d=>d.winners.some(w=>w.rule.importOrigin?.sourceLabel==='FLOAT'))&&(storage.allocation.dtype.category!=='float'||specification.payloadBits!==storage.allocation.dtype.bits||specification.auxiliaries.length||specification.packingUnitElements!==1||specification.alignmentBytes!==1))throw new FormulaError('invalid_quantization_import','FLOAT映射必须保留当前模型原始浮点格式');if(!specification)throw new FormulaError('invalid_quantization','量化规则未生成存储格式');const previousSpecification=storage.allocation.quantization,before=allocateStorage(storage.storageId,graph.storages,{symbols:{},assets},observer?.storageIds.has(storage.storageId)&&emit?event=>emit({kind:'allocation_operation',storageId:storage.storageId,phase:'before',event}):undefined),shape=storage.allocation.shape,dtype=storage.allocation.dtype;if(before.totalBytes.status!=='available')throw new FormulaError('invalid_quantization','量化前存储分配不可计算');if(observer?.storageIds.has(storage.storageId))emit?.({kind:'storage_before',storageId:storage.storageId,storage,allocation:before});storage.allocation={...storage.allocation,quantization:specification};
    const allocation=allocateStorage(storage.storageId,graph.storages,{symbols:{},assets},observer?.storageIds.has(storage.storageId)&&emit?event=>emit({kind:'allocation_operation',storageId:storage.storageId,phase:'after',event}):undefined);if(allocation.totalBytes.status==='unavailable')throw new FormulaError('invalid_quantization',allocation.diagnostics.map(d=>d.message).join('; '));
    const assignmentIndices=[...new Set(decisions.flatMap(d=>d.winners.map(w=>w.index)))].sort((a,b)=>a-b),overriddenIndices=[...new Set(decisions.flatMap(d=>d.losers.map(w=>w.index)))].sort((a,b)=>a-b),allocationOverride=scenario.numericOverrides.find(o=>o.target.kind==='storage'&&o.field==='memory_bytes'&&canonicalStorage(o.target.storageId)===storage.storageId),allocationOverridden=allocationOverride!==undefined;
    resolved.quantizationApplications.push({storageId:storage.storageId,category,nodeIds:contexts,assignmentIndices,overriddenIndices,shape,dtype,beforeBytes:before.totalBytes.quantity.value,afterBytes:allocation.totalBytes.quantity.value,specification,...(previousSpecification?{previousSpecification}:{}),allocationOverridden,...(assignmentIndices.some(i=>rules[i]?.importOrigin)?{importOrigins:assignmentIndices.flatMap(i=>rules[i]?.importOrigin?[rules[i].importOrigin]:[])}:{}),...(allocationOverride?{allocationOverrideBytes:allocationOverride.value.value}:{})});applied++;const application=resolved.quantizationApplications.at(-1);if(application&&observer?.storageIds.has(storage.storageId))emit?.({kind:'storage_applied',storageId:storage.storageId,storage,application,allocation});
    diagnostics.push({diagnosticId:'quantization-'+diagnostics.length,severity:'info',code:allocationOverridden?'quantization_allocation_overridden':'quantization_applied',message:storage.storageId+' · '+specification.payloadBits+' bit · 规则 '+assignmentIndices.map(i=>'#'+(i+1)).join(', ')+(allocationOverridden?'；显式 memory_bytes 覆盖最终分配，packing/辅助项不再推导':hasExecution?'；算子精度和转换按固定执行预设':'；ComputeClass 和显式流量/通信方程保持作者定义'),location:{kind:'scenario',scenarioId:scenario.scenarioId,fieldPath:'quantizationOverrides'}});
  }
  for(const s of selections)for(const id of s.storageIds??s.targets?.keys()??[])if(!matchedTargets.has(JSON.stringify([s.index,id])))throw new FormulaError('empty_quantization_storage','精确存储未在该规则的节点范围/类别中匹配 '+id);
  if(!applied)throw new FormulaError('empty_quantization','量化选择范围未匹配对应类别的物理存储');
  diagnostics.push({diagnosticId:'quantization-'+diagnostics.length,...(hasExecution?
    {severity:'info' as const,code:'quantization_execution_applied',message:'已应用固定量化执行规则，算子转换、计算类别和通信按各自声明求值。'}:
    {severity:'warning' as const,code:'quantization_compute_unchanged',message:'量化覆盖只改变存储分配；计算类别、通信 payload 和转换开销必须由节点/方程显式声明，不按位宽猜测吞吐。'}),
    location:{kind:'scenario',scenarioId:scenario.scenarioId,fieldPath:'quantizationOverrides'}});
}
