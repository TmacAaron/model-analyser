import {ParameterCapture} from './parameter-capture.js';
import type {ParameterCaptureTrace} from './parameter-observation.js';
import type {QuantizationObserver} from './quantization-observation.js';
import { AssetDocument,GraphTemplate,InstantiationResult,NodeId,StorageId,TensorId,StateId,Scenario,ResolvedGraph,DecodeStepContext,type AssetRef,type Quantity,type ValueExpr,type CostDefinition,type StorageSpec,type ResolvedParameter,type ModelWeightExecution } from '@model-analyser/contracts';
import { bindParameters } from './parameters.js';
import { evaluateValue,FormulaError } from './formula.js';
import { allocateStorage,bindAllocationAccess,numericValue } from './storage.js';
import { canonical,collectRefs,validateAssets } from '../../contracts/src/validation.js';
import { topologicalOrder } from './graph.js';
import { bindLocalCostRule } from './local-cost-rule.js';
import { quantizedExecutionBody } from '../../contracts/src/quantized-execution.js';
import { applyQuantization } from './quantization.js';
import { applyFusion } from './fusion.js';
import type {FusionDeclarationObserver} from './fusion-observation.js';
import { collectivePorts } from '../../contracts/src/collective.js';
import { bindNativeCommunication,decodeContextModules,nativeBindingIssues } from '../../contracts/src/parallel-bindings.js';
import {communicationSymbols,type BoundCollectiveObservation} from './communication-observation.js';
import type {LocalPlanObserver} from './local-cost-observation.js';
import type {LayoutDeclaration,LayoutObjectObserver,RepeatCountObservation,ShapeDeclaration} from './layout-observation.js';

type Node=GraphTemplate['nodes'][number];

function executionOperands(module:AssetDocument,recipe:ModelWeightExecution){
  if(module.definition.kind!=='module')return;
  const graph=module.definition.graph,node=graph.nodes.find(row=>row.nodeId===recipe.nodeId);
  if(node?.body.kind!=='opaque'||!node.body.localCost)return;
  const tensorIds=new Set(node.portBindings.map(port=>port.tensorId));
  const storageIds=new Set([...recipe.weights,...node.body.cost.memoryAccess.map(access=>access.storageId),...node.body.cost.temporaryStorageIds]);
  for(const {source} of [...node.body.localCost.bindings,...recipe.local.bindings]){
    if(source.kind==='storage_bytes')storageIds.add(source.storageId);
    else tensorIds.add(source.tensorId);
  }
  const tensors=graph.tensors.filter(tensor=>tensorIds.has(tensor.tensorId));
  for(const {storageId} of tensors)storageIds.add(storageId);
  const storages=graph.storages.filter(storage=>storageIds.has(storage.storageId));
  if(tensors.length!==tensorIds.size||storages.length!==storageIds.size)return;
  return canonical({body:node.body,portBindings:node.portBindings,tensors,storages});
}
type Port=GraphTemplate['inputs'][number];
type Endpoint=GraphTemplate['edges'][number]['from'];
type Frame=Pick<GraphTemplate,'inputs'|'outputs'|'tensors'|'storages'|'states'>;
type Expansion={inputs:Map<string,string>;outputs:Map<string,string>;leaves:NodeId[]};
type WirePort={tensorId:TensorId;source?:Endpoint;consumer?:Endpoint};
const encode=(id:string)=>encodeURIComponent(id);
const objectId=(path:string,id:string)=>path?path+'::'+encode(id):encode(id);
const nodePath=(path:string,id:string)=>path?path+'/'+encode(id):encode(id);
const key=(path:string,direction:'in'|'out',id:string)=>JSON.stringify([path,direction,id]);
const literal=(quantity:Quantity):ValueExpr=>({kind:'literal',quantity});
/** Opt-in, selected-call capture before expressions are folded. Never serialized into results. */
export type InstantiatedStorageCapture={storage:StorageSpec;symbols:Record<string,Quantity>;asset:AssetRef;bindingFrame?:string};
export type InstantiatedCostCapture={nodeId:string;asset:AssetRef;cost:CostDefinition;symbols:Record<string,Quantity>;storageRefs:{localStorageId:string;storageId:string}[];storages:InstantiatedStorageCapture[];bindingContext?:{frameId?:string;trace:ParameterCaptureTrace}};
export type InstantiationObserver={nodeId:string;declaration?:NonNullable<LocalPlanObserver['declaration']>;cost?:(record:InstantiatedCostCapture)=>void;collective?:(record:BoundCollectiveObservation)=>void;bindings?:boolean;bindingNodes?:readonly string[];bindingTraceReady?:(trace:ParameterCaptureTrace)=>void;quantization?:QuantizationObserver;fusion?:FusionDeclarationObserver;layoutObject?:LayoutObjectObserver};

/** Expand the selected phase into the same graph semantics; containers never carry a second cost. */
export function instantiateModel(input:Scenario,library:AssetDocument[],limits={maxNodes:10000,maxDepth:64},stepInput?:DecodeStepContext,observer?:InstantiationObserver):InstantiationResult {
  const diagnostics:InstantiationResult['diagnostics']=[];let cursor='$model';
  try{
    const scenario=Scenario.parse(input),assets=library.map(a=>AssetDocument.parse(a)),phase=scenario.workload.kind,stepContext=stepInput?DecodeStepContext.parse(stepInput):undefined;
    if(scenario.parallelPlan.nativeBindings){const issues=nativeBindingIssues(scenario.parallelPlan.nativeBindings,scenario.deviceTopology);if(issues.length)throw new FormulaError('invalid_native_binding',issues.join('；'));}
    if(stepContext&&(phase!=='decode'||scenario.workload.kind!=='decode'||scenario.workload.steps!==1||stepContext.index===0&&stepContext.carriedStateIds.length))throw new FormulaError('invalid_decode_step','逐步状态上下文只能用于明确的一步 decode；第零步不能凭空声明 carry');
    if(!Number.isSafeInteger(limits.maxNodes)||limits.maxNodes<1||!Number.isSafeInteger(limits.maxDepth)||limits.maxDepth<1)throw new FormulaError('invalid_graph','展开预算必须为正安全整数');
    const byRef=new Map<string,AssetDocument>(),references=new Map<string,AssetRef>();
    let expansionUnits=0,wireCount=0;const spend=()=>{if(++expansionUnits>limits.maxNodes)throw new FormulaError('expansion_limit','节点/容器展开超过预算');};
    for(const asset of assets){const id=asset.assetId+'@'+asset.revision,prior=byRef.get(id);if(prior&&canonical(prior)!==canonical(asset))throw new FormulaError('duplicate_id',`资产修订冲突 ${id}`);byRef.set(id,asset);}
    function lookup(ref:AssetRef):AssetDocument{const asset=byRef.get(ref.assetId+'@'+ref.revision);if(!asset)throw new FormulaError('missing_reference',`缺少 ${ref.assetId}@${ref.revision}`);if(asset.definition.kind!==ref.kind)throw new FormulaError('reference_kind_mismatch',`资产类型不符 ${ref.assetId}`);references.set(ref.assetId+'@'+ref.revision,ref);return asset;}
    function track(value:unknown,stack:string[]=[]){if(stack.length>limits.maxDepth)throw new FormulaError('expansion_limit','引用深度超过预算');for(const ref of collectRefs(value)){const id=ref.assetId+'@'+ref.revision;if(stack.includes(id))throw new FormulaError('dependency_cycle',`资产引用环 ${[...stack,id].join(' → ')}`);const asset=lookup(ref);if(!tracked.has(id)){tracked.add(id);track(asset.definition,[...stack,id]);}}}
    const tracked=new Set<string>();
    track(scenario.quantizationOverrides);
    track(scenario.fusionGroups);
    const root=lookup(scenario.model);if(root.definition.kind!=='model')throw new FormulaError('reference_kind_mismatch','根资产必须为 model');track(root.definition,[root.assetId+'@'+root.revision]);
    const decodeContext=phase==='decode'?scenario.parallelPlan.decodeContext:undefined;
    const decodeModules=new Map<string,AssetRef>();
    if(decodeContext){
      const origin=scenario.parallelPlan.generatedFrom,preset=root.parallelPresets?.find(row=>row.presetId===origin?.presetId&&row.strategy==='decode_context_sharded'),declared=preset?.decodeContext;
      if(origin?.modelId!==root.assetId||origin.modelRevision!==root.revision||!declared||canonical(declared)!==canonical(decodeContext))throw new FormulaError('invalid_decode_context','Decode 上下文图须与当前固定模型预设匹配');
      if(origin.requestDp&&!preset?.requestBatchSharding)throw new FormulaError('invalid_decode_context','此固定 Decode 模块未声明逐请求组的局部方程');
      if(scenario.workload.queryTokensPerRequest!==1)throw new FormulaError('invalid_decode_context','DCP 每步需要一个查询 token');
      for(const {module,replacement} of decodeContextModules(decodeContext)){
        decodeModules.set(module.assetId+'@'+module.revision,replacement);
        track(replacement);
      }
    }
    const executionProfiles:AssetDocument[]=[],executionByModule=new Map<string,Map<NodeId,{ruleIndex:number;recipe:ModelWeightExecution}>>();
    for(const [ruleIndex,rule] of scenario.quantizationOverrides.entries()){
      if(!rule.preset)continue;
      const preset=lookup(rule.preset),profile=preset.definition.kind==='quantization'?preset.definition.modelWeights:undefined;
      if(!profile?.moduleRules.some(section=>section.execution?.length))continue;
      if(profile.model.assetId!==scenario.model.assetId||profile.model.revision!==scenario.model.revision)throw new FormulaError('incompatible_model_weight_profile','量化执行预设须使用对应的固定模型版本');
      executionProfiles.push(preset);
      for(const section of profile.moduleRules){
        const sourceKey=section.module.assetId+'@'+section.module.revision;
        const replacement=decodeModules.get(sourceKey);
        const keys=[sourceKey];
        if(replacement&&section.execution?.length){
          const before=lookup(section.module),after=lookup(replacement);
          for(const recipe of section.execution){
            const operands=executionOperands(before,recipe);
            if(!operands||operands!==executionOperands(after,recipe)){
              throw new FormulaError('incompatible_model_weight_profile','Decode 替代模块的量化执行算子发生变化 '+recipe.nodeId);
            }
          }
          keys.push(replacement.assetId+'@'+replacement.revision);
        }
        for(const key of new Set(keys)){
          const recipes=executionByModule.get(key)??new Map<NodeId,{ruleIndex:number;recipe:ModelWeightExecution}>();
          for(const recipe of section.execution??[]){
            if(recipes.has(recipe.nodeId))throw new FormulaError('ambiguous_quantized_execution','一个算子只可使用一个量化执行预设 '+recipe.nodeId);
            recipes.set(recipe.nodeId,{ruleIndex,recipe});
          }
          if(recipes.size)executionByModule.set(key,recipes);
        }
      }
    }
    const templateIssues=validateAssets([root,...[...decodeModules.values()].map(lookup),...executionProfiles],assets);if(templateIssues.some(d=>d.severity==='error'))return InstantiationResult.parse({status:'unavailable',diagnostics:templateIssues});
    const executionInputs:{nodeId:string;ruleIndex:number;weights:StorageId[];activation:StorageId}[]=[];
    const graph:GraphTemplate={inputs:[],outputs:[],nodes:[],edges:[],dependencies:[],tensors:[],storages:[],states:[]};
    const containers:ResolvedGraph['containers']=[],parameters:ResolvedParameter[]=[],objectBindings:ResolvedGraph['objectBindings']=[];
    const ports=new Map<string,WirePort>(),incoming=new Map<string,string[]>(),outgoing=new Map<string,string[]>();
    const tensorById=new Map<string,GraphTemplate['tensors'][number]>(),storageById=new Map<string,StorageSpec>(),stateById=new Map<string,GraphTemplate['states'][number]>();
    const nodeExpansions=new Map<string,Expansion>();
    const parameterCapture=observer?.bindings?new ParameterCapture(observer.nodeId,observer.bindingNodes):undefined;
    const storageInputs=observer?.cost?new Map<string,InstantiatedStorageCapture>():undefined;
    const layoutTrace=observer?.layoutObject,derived=layoutTrace?.derived;
    const tensorDeclarations=derived?new Map<TensorId,ShapeDeclaration>():undefined;
    const deferredStates:{state:GraphTemplate['states'][number];local:GraphTemplate['states'][number];path:string;bound:boolean}[]=[];
    const controlPairs:[NodeId,NodeId,GraphTemplate['dependencies'][number]['kind']][]=[];
    const collectivePlacements:{node:Node;parentPath:string;after:NodeId[];before:NodeId[]}[]=[];
    function canonicalStorage(id:StorageId):StorageId{const seen=new Set<StorageId>();let current=id;while(true){if(seen.has(current))throw new FormulaError('dependency_cycle','存储 alias 环');seen.add(current);const s=storageById.get(current);if(s?.allocation.kind!=='alias')return current;current=s.allocation.targetStorageId;}}
    function context(symbols:Record<string,Quantity>){return {symbols,assets};}
    function value(expr:ValueExpr,symbols:Record<string,Quantity>,unit?:Quantity['unit'],integer=false,minimum=0):ValueExpr{
      track(expr);const quantity=evaluateValue(expr,symbols,assets);if(unit!==undefined&&quantity.unit!==unit)throw new FormulaError('invalid_unit',`需要 ${unit}，收到 ${quantity.unit}`);
      if(!Number.isFinite(quantity.value)||quantity.value<minimum||(integer&&!Number.isSafeInteger(quantity.value)))throw new FormulaError('invalid_shape','表达式结果超出数值/整数范围');return literal(quantity);
    }
    function shape(source:GraphTemplate['tensors'][number]['shape'],symbols:Record<string,Quantity>){return source.map(axis=>({...axis,size:value(axis.size,symbols,'count',true)}));}
    function shapeValues(source:GraphTemplate['tensors'][number]['shape']){return source.map(axis=>axis.size.kind==='literal'?axis.size.quantity.value:NaN);}
    function compatible(a:GraphTemplate['tensors'][number],b:GraphTemplate['tensors'][number]){return canonical(a.dtype)===canonical(b.dtype)&&canonical(shapeValues(a.shape))===canonical(shapeValues(b.shape));}
    function addTensor(t:GraphTemplate['tensors'][number]){if(tensorById.has(t.tensorId))throw new FormulaError('duplicate_id',`张量 ID 重复 ${t.tensorId}`);tensorById.set(t.tensorId,t);graph.tensors.push(t);}
    function addStorage(s:StorageSpec){if(storageById.has(s.storageId))throw new FormulaError('duplicate_id',`存储 ID 重复 ${s.storageId}`);storageById.set(s.storageId,s);graph.storages.push(s);}
    function register(k:string,tensorId:TensorId,source?:Endpoint,consumer?:Endpoint){const prior=ports.get(k);if(prior&&prior.tensorId!==tensorId)throw new FormulaError('invalid_port','同一端口绑定不同张量');ports.set(k,{tensorId,...(source?{source}:{}),...(consumer?{consumer}:{})});}
    function wire(from:string,to:string){if(++wireCount>limits.maxNodes*32)throw new FormulaError('expansion_limit','端口连线展开超过预算');const a=ports.get(from),b=ports.get(to);if(!a||!b||a.tensorId!==b.tensorId)throw new FormulaError('invalid_port',`连线端口不存在或张量不一致 ${from} → ${to}`);incoming.set(to,[...(incoming.get(to)??[]),from]);outgoing.set(from,[...(outgoing.get(from)??[]),to]);}
    function endpoints(path:string,inputs:Port[],outputs:Port[],tensorMap:Map<string,TensorId>,leaf:boolean,rootFrame=false):Expansion{
      const expansion:Expansion={inputs:new Map(),outputs:new Map(),leaves:leaf?[NodeId.parse(path)]:[]};
      for(const [direction,list] of [['in',inputs],['out',outputs]] as const){const seen=new Set<string>();for(const p of list){if(seen.has(p.portId))throw new FormulaError('duplicate_id',`端口 ID 重复 ${p.portId}`);seen.add(p.portId);const tensorId=tensorMap.get(p.tensorId);if(!tensorId)throw new FormulaError('missing_reference',`端口张量缺失 ${p.tensorId}`);const k=key(path,direction,p.portId);
        const endpoint:Endpoint=rootFrame?{kind:direction==='in'?'graph_input':'graph_output',portId:p.portId}:{kind:'node',nodeId:NodeId.parse(path),portId:p.portId};
        register(k,tensorId,(leaf&&direction==='out')||(rootFrame&&direction==='in')?endpoint:undefined,(leaf&&direction==='in')||(rootFrame&&direction==='out')?endpoint:undefined);
        (direction==='in'?expansion.inputs:expansion.outputs).set(p.portId,k);
      }}return expansion;
    }
    function observeDeclaration(path:string,owner:AssetDocument,definition:CostDefinition,symbols:Record<string,Quantity>,kind:'local'|'global'){
      if(observer?.nodeId!==path||!observer.declaration)return;
      const frameId=parameterCapture?.frame(symbols);
      observer.declaration(structuredClone({
        asset:{assetId:owner.assetId,revision:owner.revision,kind:owner.definition.kind},cost:definition,
        symbols:parameterCapture?.symbolsSnapshot(symbols)??communicationSymbols(symbols),
        ...(parameterCapture?{bindingContext:{...(frameId?{frameId}:{}),trace:parameterCapture.snapshot()}}:{}),
      }),kind);
    }
    function localRule(rule:Parameters<typeof bindLocalCostRule>[0],symbols:Record<string,Quantity>,tensors:Parameters<typeof bindLocalCostRule>[2],tensorMap:Map<string,TensorId>,storageMap:Map<string,StorageId>,path:string,owner:AssetDocument){
      observeDeclaration(path,owner,rule.cost,symbols,'local');
      return bindLocalCostRule(rule,symbols,tensors,tensorMap,tensorById,storageMap);
    }
    function cost(source:CostDefinition,symbols:Record<string,Quantity>,storageMap:Map<string,StorageId>,path:string,owner:AssetDocument):CostDefinition{
      observeDeclaration(path,owner,source,symbols,'global');
      if(observer?.nodeId===path&&observer.cost){const frameId=parameterCapture?.frame(symbols);const refs=source.memoryAccess.map(a=>({localStorageId:String(a.storageId),storageId:String(storageMap.get(a.storageId)??'')})),selected=new Map<string,InstantiatedStorageCapture>();for(const ref of refs){let id=ref.storageId;const visited=new Set<string>();while(!visited.has(id)){visited.add(id);const record=storageInputs?.get(id);if(!record)break;selected.set(id,record);if(record.storage.allocation.kind!=='alias')break;id=record.storage.allocation.targetStorageId;}}observer.cost(structuredClone({nodeId:path,asset:{assetId:owner.assetId,revision:owner.revision,kind:owner.definition.kind},cost:source,symbols:parameterCapture?.symbolsSnapshot(symbols)??symbols,storageRefs:refs,storages:[...selected.values()],...(parameterCapture?{bindingContext:{...(frameId?{frameId}:{}),trace:parameterCapture.snapshot()}}:{})}));}
      const storage=(id:string)=>{const mapped=storageMap.get(id);if(!mapped)throw new FormulaError('missing_reference',`成本引用缺少存储 ${id}`);return mapped;};
      return {...source,compute:source.compute.map(c=>({...c,usefulOperations:value(c.usefulOperations,symbols,'operation'),executedOperations:value(c.executedOperations,symbols,'operation')})),memoryAccess:source.memoryAccess.map(a=>({...a,storageId:storage(a.storageId),logicalBytes:a.logicalBytes.kind==='storage_allocation'?{kind:'storage_allocation' as const,passes:bindAllocationAccess(a.logicalBytes.passes,{symbols,assets})}:value(a.logicalBytes,symbols,'byte'),...(a.hbmEstimate?.kind==='bytes'?{hbmEstimate:{kind:'bytes' as const,value:value(a.hbmEstimate.value,symbols,'byte')}}:{})})),temporaryStorageIds:source.temporaryStorageIds.map(storage),timing:source.timing.kind==='custom_formula'?{...source.timing,seconds:value(source.timing.seconds,symbols,'second')}:source.timing};
    }
    function boundStatePolicy(policy:GraphTemplate['states'][number]['updatePolicy'],symbols:Record<string,Quantity>){
      if(policy.kind==='windowed')return {...policy,window:value(policy.window,symbols,'count',true,1)};
      if(policy.kind==='append'&&policy.fixedCapacity)return {...policy,fixedCapacity:value(policy.fixedCapacity,symbols,'count',true,1)};
      return policy;
    }
    function materialize(source:Frame,path:string,symbols:Record<string,Quantity>,external:Map<string,TensorId>,stateBindings:Map<string,StateId>,owner:AssetDocument){
      const tensorMap=new Map<string,TensorId>(),storageMap=new Map<string,StorageId>(),stateMap=new Map<string,StateId>();
      function observeObject(object:LayoutDeclaration['object']){
        layoutTrace?.record?.(structuredClone({object,nodeId:NodeId.parse(path||'$model'),asset:{assetId:owner.assetId,revision:owner.revision,kind:owner.definition.kind},symbols:communicationSymbols(symbols)}));
      }
      const bindStorage=(local:string,target:StorageId)=>{const canonical=canonicalStorage(target),prior=storageMap.get(local);if(prior&&canonicalStorage(prior)!==canonical)throw new FormulaError('invalid_state_binding',`同一本地存储绑定不同对象 ${local}`);storageMap.set(local,canonical);};
      for(const local of source.states){const parentId=stateBindings.get(local.stateId);if(parentId){const parent=stateById.get(parentId);if(!parent||parent.stateKind!==local.stateKind||parent.storageIds.length!==local.storageIds.length)throw new FormulaError('invalid_state_binding','状态类型或存储数量不兼容');const policy=boundStatePolicy(local.updatePolicy,symbols);if(canonical(policy)!==canonical(parent.updatePolicy)||(local.allocationBasis??'context_boundary')!==(parent.allocationBasis??'context_boundary'))throw new FormulaError('invalid_state_binding','状态更新/分配时点约束不兼容');stateMap.set(local.stateId,parentId);local.storageIds.forEach((id,i)=>{const target=parent.storageIds[i];if(!target)throw new FormulaError('invalid_state_binding','状态存储缺失');bindStorage(id,target);});}else stateMap.set(local.stateId,StateId.parse(objectId(path,local.stateId)));}
      for(const id of stateBindings.keys())if(!source.states.some(s=>s.stateId===id))throw new FormulaError('missing_reference',`子定义未声明状态 ${id}`);
      const interfaces=[...source.inputs,...source.outputs];
      for(const [portId,targetId] of external){const port=interfaces.find(p=>p.portId===portId);if(!port)throw new FormulaError('invalid_port',`子接口缺少端口 ${portId}`);const local=source.tensors.find(t=>t.tensorId===port.tensorId),target=tensorById.get(targetId);if(!local||!target)throw new FormulaError('missing_reference','边界张量缺失');const evaluated={...local,shape:shape(local.shape,symbols)};if(!compatible(evaluated,target))throw new FormulaError('invalid_shape',`边界 shape/dtype 不兼容 ${path}:${portId}`);const prior=tensorMap.get(local.tensorId);if(prior&&prior!==targetId)throw new FormulaError('invalid_port','共享本地张量被映射到不同张量');tensorMap.set(local.tensorId,targetId);bindStorage(local.storageId,target.storageId);}
      for(const s of source.storages)if(!storageMap.has(s.storageId))storageMap.set(s.storageId,StorageId.parse(objectId(path,s.storageId)));
      const evaluatedStorages=source.storages.map(s=>{const allocation=s.allocation;
        return {...s,allocation:allocation.kind==='bytes'?{kind:'bytes' as const,value:value(allocation.value,symbols,'byte',true)}:allocation.kind==='alias'?allocation:{...allocation,shape:shape(allocation.shape,symbols),...(allocation.quantization?{quantization:{...allocation.quantization,auxiliaries:allocation.quantization.auxiliaries.map(a=>({...a,count:a.count.kind==='formula'?{kind:'formula' as const,value:value(a.count.value,symbols,'count',true)}:a.count}))}}:{})}};
      });
      for(const [index,s] of evaluatedStorages.entries()){const id=storageMap.get(s.storageId);if(!id)throw new FormulaError('missing_reference','存储映射缺失');if(storageById.has(id)){
          const parent=storageById.get(id);if(parent&&parent.sharingDomain!==s.sharingDomain)throw new FormulaError('invalid_state_binding','存储共享域不兼容');continue;
        }
        const target=s.allocation.kind==='alias'?storageMap.get(s.allocation.targetStorageId):undefined;if(s.allocation.kind==='alias'&&!target)throw new FormulaError('missing_reference','alias 目标缺失');addStorage({...s,storageId:id,allocation:target?{kind:'alias',targetStorageId:target}:s.allocation});const original=source.storages[index],bindingFrame=parameterCapture?.frame(symbols);if(storageInputs&&original)storageInputs.set(id,{storage:{...original,storageId:id,allocation:target?{kind:'alias',targetStorageId:target}:original.allocation},symbols:parameterCapture?.symbolsSnapshot(symbols)??symbols,asset:{assetId:owner.assetId,revision:owner.revision,kind:owner.definition.kind},...(bindingFrame?{bindingFrame}:{})});
        if(original&&layoutTrace?.target.kind==='storage'&&layoutTrace.target.storageId===id)observeObject({kind:'storage',storage:original});
      }
      for(const s of evaluatedStorages){const target=storageMap.get(s.storageId);if(!target)throw new FormulaError('missing_reference','存储映射缺失');const local=allocateStorage(s.storageId,evaluatedStorages,context({})),parent=allocateStorage(target,graph.storages,context({}));if(local.totalBytes.status!=='available'||parent.totalBytes.status!=='available')throw new FormulaError('invalid_shape','存储分配不可用');if(local.totalBytes.quantity.value>parent.totalBytes.quantity.value)throw new FormulaError('invalid_state_binding','绑定存储容量不足');}
      for(const t of source.tensors)if(!tensorMap.has(t.tensorId)){
        const id=TensorId.parse(objectId(path,t.tensorId)),storageId=storageMap.get(t.storageId);if(!storageId)throw new FormulaError('missing_reference',`张量存储缺失 ${t.storageId}`);
        tensorMap.set(t.tensorId,id);addTensor({...t,tensorId:id,storageId,shape:shape(t.shape,symbols)});
        if(tensorDeclarations)tensorDeclarations.set(id,{asset:{assetId:owner.assetId,revision:owner.revision,kind:owner.definition.kind},
          nodeId:NodeId.parse(path||'$model'),shape:t.shape,symbols});
        if(layoutTrace?.target.kind==='tensor'&&layoutTrace.target.tensorId===id)observeObject({kind:'tensor',tensor:t});
      }
      for(const local of source.states){const stateId=stateMap.get(local.stateId);if(!stateId)throw new FormulaError('missing_reference','状态映射缺失');const bound=stateBindings.has(local.stateId);let state=stateById.get(stateId);
        if(!state){const storageIds=local.storageIds.map(id=>{const mapped=storageMap.get(id);if(!mapped)throw new FormulaError('missing_reference','状态存储缺失');return mapped;});state={...local,stateId,storageIds,creator:{kind:'initialized'},readers:[],writers:[],updatePolicy:boundStatePolicy(local.updatePolicy,symbols)};stateById.set(stateId,state);graph.states.push(state);}
        deferredStates.push({state,local,path,bound});
      }
      objectBindings.push({nodeId:NodeId.parse(path||'$model'),tensors:source.tensors.map(t=>{const id=tensorMap.get(t.tensorId);if(!id)throw new FormulaError('missing_reference','张量绑定缺失');const global=tensorById.get(id);return {localTensorId:t.tensorId,tensorId:id,axes:t.shape.map((a,i)=>({localAxisId:a.axisId,axisId:global?.shape[i]?.axisId??a.axisId}))};}),storages:source.storages.map(s=>{const id=storageMap.get(s.storageId);if(!id)throw new FormulaError('missing_reference','存储绑定缺失');return {localStorageId:s.storageId,storageId:id};}),states:source.states.map(s=>{const id=stateMap.get(s.stateId);if(!id)throw new FormulaError('missing_reference','状态绑定缺失');return {localStateId:s.stateId,stateId:id};})});
      return {tensorMap,storageMap,stateMap};
    }
    function appendNode(node:Node){if(graph.nodes.length>=limits.maxNodes)throw new FormulaError('expansion_limit','节点展开超过预算');graph.nodes.push(node);}
    function expandFrame(source:GraphTemplate|Extract<AssetDocument['definition'],{kind:'operator'}>['operator'],asset:AssetDocument,path:string,symbols:Record<string,Quantity>,external:Map<string,TensorId>,states:Map<string,StateId>,stack:string[],leaf=false):Expansion{
      cursor=path||'$model';spend();if(stack.length>limits.maxDepth)throw new FormulaError('expansion_limit','模块展开深度超限');
      const mapped=materialize(source,path,symbols,external,states,asset),exp=endpoints(path,source.inputs,source.outputs,mapped.tensorMap,leaf,path==='');
      if(leaf){if(!('cost' in source))throw new FormulaError('invalid_graph','算子缺少成本');if(!source.phases.includes(phase))throw new FormulaError('invalid_phase','算子不适用于当前阶段');appendNode({nodeId:NodeId.parse(path),name:asset.name,phases:[phase],portBindings:[...source.inputs,...source.outputs].map(p=>{const tensorId=mapped.tensorMap.get(p.tensorId);if(!tensorId)throw new FormulaError('missing_reference','端口张量缺失');return {portId:p.portId,tensorId};}),stateBindings:[],body:{kind:'opaque',inputs:source.inputs.map(p=>({...p,tensorId:mapped.tensorMap.get(p.tensorId)??p.tensorId})),outputs:source.outputs.map(p=>({...p,tensorId:mapped.tensorMap.get(p.tensorId)??p.tensorId})),cost:cost(source.cost,symbols,mapped.storageMap,path,asset),...(source.localCost?{localCost:localRule(source.localCost,symbols,source.tensors,mapped.tensorMap,mapped.storageMap,path,asset)}:{})}});nodeExpansions.set(path,exp);return exp;}
      if(!('nodes' in source))throw new FormulaError('invalid_graph','模块缺少图');
      const template=source;
      const active=new Set(source.nodes.filter(n=>n.phases.includes(phase)).map(n=>n.nodeId));
      topologicalOrder({...source,nodes:source.nodes.filter(n=>active.has(n.nodeId)),edges:source.edges.filter(e=>(e.from.kind!=='node'||active.has(e.from.nodeId))&&(e.to.kind!=='node'||active.has(e.to.nodeId))),dependencies:source.dependencies.filter(d=>active.has(d.fromNodeId)&&active.has(d.toNodeId))});
      const children=new Map<string,Expansion>();if(new Set(source.nodes.map(n=>n.nodeId)).size!==source.nodes.length)throw new FormulaError('duplicate_id','模板节点 ID 重复');
      for(const node of source.nodes)if(node.phases.includes(phase)){const child=expandNode(node,asset,path,symbols,mapped.tensorMap,mapped.storageMap,mapped.stateMap,stack);children.set(node.nodeId,child);exp.leaves.push(...child.leaves);}
      function port(endpoint:Endpoint,from:boolean):string|undefined{
        if(endpoint.kind==='graph_input'){if(!from)throw new FormulaError('invalid_port','graph_input 只能作为起点');return exp.inputs.get(endpoint.portId);}
        if(endpoint.kind==='graph_output'){if(from)throw new FormulaError('invalid_port','graph_output 只能作为终点');return exp.outputs.get(endpoint.portId);}
        if(!template.nodes.some(n=>n.nodeId===endpoint.nodeId))throw new FormulaError('missing_reference',`边引用不存在节点 ${endpoint.nodeId}`);
        const child=children.get(endpoint.nodeId);if(!child)return undefined;const result=(from?child.outputs:child.inputs).get(endpoint.portId);if(!result)throw new FormulaError('invalid_port',`边引用不存在端口 ${endpoint.portId}`);return result;
      }
      for(const edge of source.edges){const from=port(edge.from,true),to=port(edge.to,false);if(!from||!to)continue;const tensorId=mapped.tensorMap.get(edge.tensorId);if(!tensorId||ports.get(from)?.tensorId!==tensorId||ports.get(to)?.tensorId!==tensorId)throw new FormulaError('invalid_port',`边 ${edge.edgeId} 的端口绑定不一致`);wire(from,to);}
      for(const d of source.dependencies){if(!source.nodes.some(n=>n.nodeId===d.fromNodeId)||!source.nodes.some(n=>n.nodeId===d.toNodeId))throw new FormulaError('missing_reference','控制依赖节点不存在');const a=children.get(d.fromNodeId),b=children.get(d.toNodeId);if(a&&b)for(const from of a.leaves)for(const to of b.leaves){if(controlPairs.length>=limits.maxNodes*16)throw new FormulaError('expansion_limit','容器依赖展开超过预算');controlPairs.push([from,to,d.kind]);}}
      containers.push({nodeId:NodeId.parse(path||'$model'),name:asset.name,asset:{assetId:asset.assetId,revision:asset.revision,kind:asset.definition.kind},leafNodeIds:exp.leaves});nodeExpansions.set(path,exp);return exp;
    }
    function expandNode(node:Node,owner:AssetDocument,parentPath:string,parentSymbols:Record<string,Quantity>,parentTensors:Map<string,TensorId>,parentStorages:Map<string,StorageId>,parentStates:Map<string,StateId>,stack:string[]):Expansion{
      const path=nodePath(parentPath,node.nodeId);cursor=path;
      const body=node.body,intrinsic=body.kind==='opaque'||body.kind==='collective';
      const replacement=body.kind==='module'&&owner.assetId===root.assetId&&owner.revision===root.revision
        ?decodeModules.get(body.asset.assetId+'@'+body.asset.revision):undefined;
      const target=intrinsic?owner:lookup(replacement??body.asset);
      if(body.kind==='collective'){const iface=collectivePorts(body.communication);if(node.portBindings.length!==2||[...iface.inputs,...iface.outputs].some(p=>!node.portBindings.some(b=>b.portId===p.portId&&b.tensorId===p.tensorId)))throw new FormulaError('invalid_port','collective 必须绑定 source/destination 固定端口到对应张量');}
      if(!intrinsic&&target.definition.kind!==body.kind)throw new FormulaError('reference_kind_mismatch','节点引用类型不符');
      const source=intrinsic?{...(body.kind==='opaque'?{inputs:body.inputs,outputs:body.outputs}:collectivePorts(body.communication)),tensors:[],storages:[],states:[]}:target.definition.kind==='operator'?target.definition.operator:target.definition.kind==='module'?target.definition.graph:undefined;
      if(!source)throw new FormulaError('reference_kind_mismatch','节点不能展开为模块/算子');
      const bindings=new Map<string,TensorId>();for(const p of node.portBindings){if(bindings.has(p.portId))throw new FormulaError('duplicate_id','端口绑定重复');const tensorId=parentTensors.get(p.tensorId);if(!tensorId)throw new FormulaError('missing_reference','节点绑定张量不存在');bindings.set(p.portId,tensorId);}
      for(const p of [...source.inputs,...source.outputs])if(!bindings.has(p.portId))throw new FormulaError('invalid_port',`接口端口缺少显式绑定 ${p.portId}`);
      const stateBindings=new Map<string,StateId>();for(const s of node.stateBindings){const parent=parentStates.get(s.parentStateId);if(!parent)throw new FormulaError('missing_reference','父状态不存在');if(stateBindings.has(s.localStateId))throw new FormulaError('duplicate_id','状态绑定重复');stateBindings.set(s.localStateId,parent);}
      if(intrinsic&&stateBindings.size)throw new FormulaError('invalid_state_binding','内联叶节点通过父图存储和实际端口引用状态，不能绑定未声明的子状态');
      const count=node.repeat?numericValue(node.repeat.count,'count',context(parentSymbols),true):1;
      const repeatCount:RepeatCountObservation|undefined=derived&&node.repeat?{axisId:node.repeat.axis,expression:node.repeat.count,nodeId:NodeId.parse(parentPath||'$model'),
        symbols:communicationSymbols(parentSymbols),value:count}:undefined;
      if(count<1||count>limits.maxNodes)throw new FormulaError('expansion_limit','repeat 次数必须为正且不超过节点预算');
      if(node.repeat?.wiring==='independent'&&node.repeat.carry.length)throw new FormulaError('invalid_repeat','independent 不允许 carry');
      if(node.repeat&&Object.hasOwn(parentSymbols,node.repeat.axis))throw new FormulaError('invalid_repeat','repeat 局部索引不能覆盖已有参数');
      const outer=node.repeat?endpoints(path,source.inputs,source.outputs,new Map([...source.inputs,...source.outputs].map(p=>{const tensorId=bindings.get(p.portId);if(!tensorId)throw new FormulaError('invalid_port','边界绑定缺失');return [p.tensorId,tensorId];})),false):undefined;
      if(node.repeat&&new Set(node.repeat.carry.map(c=>c.inputPortId)).size!==node.repeat.carry.length)throw new FormulaError('invalid_repeat','同一 carry 输入有多个来源');
      for(const c of node.repeat?.carry??[])if(!source.inputs.some(p=>p.portId===c.inputPortId)||!source.outputs.some(p=>p.portId===c.outputPortId))throw new FormulaError('invalid_repeat','carry 接口不存在');
      const instances:Expansion[]=[],allLeaves:NodeId[]=[];
      for(let i=0;i<count;i++){
        const instancePath=node.repeat?path+'['+i+']':path,scope=node.repeat?{...parentSymbols,[node.repeat.axis]:{value:i,unit:'count' as const}}:parentSymbols;
        if(node.repeat)parameterCapture?.repeat(scope,parentSymbols,instancePath,node.repeat.axis,i);
        const bound=intrinsic?{symbols:scope,parameters:[]}:parameterCapture?parameterCapture.bind(target,body.bindings,scope,assets,scenario,NodeId.parse(instancePath)):bindParameters(target,body.bindings,scope,assets,scenario,NodeId.parse(instancePath));parameters.push(...bound.parameters);
        const external=new Map(bindings);
        if(node.repeat){for(const c of node.repeat.carry){if(i>0){const previous=instances[i-1]?.outputs.get(c.outputPortId),tensorId=previous?ports.get(previous)?.tensorId:undefined;if(!tensorId)throw new FormulaError('invalid_repeat','上一实例 carry 输出缺失');external.set(c.inputPortId,tensorId);}}
          for(const output of source.outputs)if(node.repeat.wiring==='independent'||i<count-1){const originalId=bindings.get(output.portId),original=originalId?tensorById.get(originalId):undefined;if(!original)throw new FormulaError('missing_reference','repeat 输出张量不存在');
            const local=source.tensors.find(t=>t.tensorId===output.tensorId),localShape=local?shape(local.shape,bound.symbols):node.repeat.wiring==='independent'?original.shape.filter(a=>a.axisId!==node.repeat?.axis):original.shape;
            const id=TensorId.parse(objectId(instancePath,'$output:'+output.portId));let storageId=original.storageId;
            let disposition:'shared_stack'|'new_buffer'|'in_place'='shared_stack';
            if(node.repeat.wiring==='chain'){
              const carry=node.repeat.carry.find(c=>c.outputPortId===output.portId),inputId=carry?bindings.get(carry.inputPortId):undefined,input=inputId?tensorById.get(inputId):undefined;
              const inPlace=input&&canonicalStorage(input.storageId)===canonicalStorage(original.storageId);
              disposition=inPlace?'in_place':'new_buffer';
              if(!inPlace){storageId=StorageId.parse(objectId(instancePath,'$output:'+output.portId));const originalStorage=storageById.get(original.storageId);if(!originalStorage)throw new FormulaError('missing_reference','repeat 输出存储缺失');addStorage({...originalStorage,storageId,allocation:{kind:'tensor',shape:localShape,dtype:original.dtype}});}
            }
            else {const repeatAxis=original.shape.find(a=>a.axisId===node.repeat?.axis);if(!repeatAxis||repeatAxis.size.kind!=='literal'||repeatAxis.size.quantity.value!==count||canonical(shapeValues(original.shape.filter(a=>a.axisId!==node.repeat?.axis)))!==canonical(shapeValues(localShape)))throw new FormulaError('invalid_repeat','independent 输出必须显式包含 repeat 轴且其他维度匹配');}
            addTensor({...original,tensorId:id,storageId,shape:localShape});external.set(output.portId,id);
            if(derived&&layoutTrace&&repeatCount){
              const parentDeclaration=tensorDeclarations?.get(original.tensorId);
              const declaration:ShapeDeclaration|undefined=local?{asset:{assetId:target.assetId,revision:target.revision,kind:target.definition.kind},
                nodeId:NodeId.parse(instancePath),shape:local.shape,symbols:bound.symbols}
                :parentDeclaration?{...parentDeclaration,shape:node.repeat.wiring==='independent'?parentDeclaration.shape.filter(axis=>axis.axisId!==repeatCount.axisId):parentDeclaration.shape}:undefined;
              if(declaration)tensorDeclarations?.set(id,declaration);
              const wanted=layoutTrace.target.kind==='tensor'?layoutTrace.target.tensorId===id:disposition==='new_buffer'&&layoutTrace.target.storageId===storageId;
              if(wanted)derived(structuredClone({kind:'repeat_instance',wiring:node.repeat.wiring,repeatNodeId:NodeId.parse(path),instanceNodeId:NodeId.parse(instancePath),instanceIndex:i,
                tensorId:id,storageId,portId:output.portId,parentTensorId:original.tensorId,parentStorageId:original.storageId,disposition,count:repeatCount,shape:localShape,
                shapeMethod:local?'declared_port':node.repeat.wiring==='independent'?'parent_axis_projection':'parent_shape',
                ...(declaration?{declaration:{...declaration,symbols:communicationSymbols(declaration.symbols)}}:{})}));
            }
          }
        }
        let exp:Expansion;
        if(intrinsic){
          spend();
          const tensorMap=new Map<string,TensorId>();for(const p of [...source.inputs,...source.outputs]){const tensorId=external.get(p.portId);if(!tensorId)throw new FormulaError('invalid_port','内联叶端口缺失');const prior=tensorMap.get(p.tensorId);if(prior&&prior!==tensorId)throw new FormulaError('invalid_port','同一内联张量映射到不同 repeat 版本；请为输入/输出声明独立张量');tensorMap.set(p.tensorId,tensorId);}
          const storageOverrides=new Map<string,StorageId>();
          for(const p of [...source.inputs,...source.outputs]){
            const originalId=parentTensors.get(p.tensorId),original=originalId?tensorById.get(originalId):undefined,actualId=external.get(p.portId),actual=actualId?tensorById.get(actualId):undefined;
            if(!original||!actual)throw new FormulaError('missing_reference','opaque 边界张量缺失');
            const expected=node.repeat?.wiring==='independent'&&source.outputs.some(o=>o.portId===p.portId)?{...original,shape:original.shape.filter(a=>a.axisId!==node.repeat?.axis)}:original;
            if(!compatible(expected,actual))throw new FormulaError('invalid_shape','opaque repeat/端口形状不兼容');
            for(const [local,global] of parentStorages)if(canonicalStorage(global)===canonicalStorage(original.storageId)){
              const previous=storageOverrides.get(local),target=canonicalStorage(actual.storageId);if(previous&&previous!==target)throw new FormulaError('invalid_state_binding','opaque 的同一存储被绑定到不同底层对象');storageOverrides.set(local,target);
            }
          }
          const costStorages=new Map(parentStorages);for(const [local,global] of storageOverrides)costStorages.set(local,global);
          exp=endpoints(instancePath,source.inputs,source.outputs,tensorMap,true);const portsResolved=(items:Port[])=>items.map(p=>({...p,tensorId:tensorMap.get(p.tensorId)??p.tensorId}));
          const ruleTensors=new Map(parentTensors);for(const [id,target] of tensorMap)ruleTensors.set(id,target);const sourceTensors=owner.definition.kind==='model'||owner.definition.kind==='module'?owner.definition.graph.tensors:[];
          let resolvedBody:Node['body'];
          if(body.kind==='opaque'){
            const execution=executionByModule.get(owner.assetId+'@'+owner.revision)?.get(node.nodeId);
            const definition=execution?quantizedExecutionBody(body,execution.recipe):body;
            if(execution){
              const inputId=ruleTensors.get(execution.recipe.activation.tensorId),activation=inputId?tensorById.get(inputId):undefined;
              if(!activation)throw new FormulaError('invalid_quantized_execution','量化执行缺少激活输入 '+instancePath);
              const weights=execution.recipe.weights.map(id=>{
                const storage=costStorages.get(id);
                if(!storage)throw new FormulaError('invalid_quantized_execution','量化执行缺少权重 '+instancePath+'/'+id);
                return canonicalStorage(storage);
              });
              executionInputs.push({nodeId:instancePath,ruleIndex:execution.ruleIndex,weights,activation:canonicalStorage(activation.storageId)});
            }
            resolvedBody={kind:'opaque',inputs:portsResolved(definition.inputs),outputs:portsResolved(definition.outputs),cost:cost(definition.cost,scope,costStorages,instancePath,owner),...(definition.localCost?{localCost:localRule(definition.localCost,scope,sourceTensors,ruleTensors,costStorages,instancePath,owner)}:{})};
          }
          else {
            const c=scenario.parallelPlan.nativeBindings?bindNativeCommunication(body.communication,scenario.parallelPlan.nativeBindings):body.communication,endpoint=(e:typeof c.source)=>{const tensorId=ruleTensors.get(e.tensorId),original=sourceTensors.find(t=>t.tensorId===e.tensorId),actual=tensorId?tensorById.get(tensorId):undefined;if(!tensorId||!original||!actual)throw new FormulaError('missing_reference','collective 端点张量不存在');const axis=(id:string)=>{const index=original.shape.filter(a=>!(node.repeat?.wiring==='independent'&&c.destination.tensorId===e.tensorId&&a.axisId===node.repeat.axis)).findIndex(a=>a.axisId===id),mapped=actual.shape[index]?.axisId;if(index<0||!mapped)throw new FormulaError('missing_reference','collective 轴映射缺失 '+id);return mapped;},d=e.distribution;return {tensorId,distribution:d.kind==='sharded'?{...d,axes:d.axes.map(a=>({...a,tensorAxisId:axis(a.tensorAxisId)})),policy:d.policy.kind==='explicit'?{...d.policy,slices:d.policy.slices.map(s=>({...s,axisId:axis(s.axisId)}))}:d.policy}:d.kind==='partial'&&d.partition?{...d,partition:{...d.partition,tensorAxisId:axis(d.partition.tensorAxisId)}}:d.kind==='manual'?{...d,members:d.members.map(m=>({...m,localShape:shape(m.localShape,scope).map(a=>({...a,axisId:axis(a.axisId)}))}))}:d};};
            if(c.placement&&(c.placement.nodeId!==node.nodeId||!c.placement.phases.includes(phase)))throw new FormulaError('invalid_communication_placement','collective placement 必须匹配本地节点 ID 和当前阶段');
            if(observer?.nodeId===instancePath&&observer.collective){
              const parameterFrameId=parameterCapture?.frame(scope);
              observer.collective(structuredClone({nodeId:NodeId.parse(instancePath),asset:{assetId:owner.assetId,revision:owner.revision,kind:owner.definition.kind},
                authored:body.communication,roleBound:c,symbols:communicationSymbols(scope),...(parameterFrameId?{parameterFrameId}:{})}));
            }
            resolvedBody={kind:'collective',communication:{...c,source:endpoint(c.source),destination:endpoint(c.destination),sendBytesPerMember:value(c.sendBytesPerMember,scope,'byte'),receiveBytesPerMember:value(c.receiveBytesPerMember,scope,'byte'),...(c.perDevicePayloads?{perDevicePayloads:c.perDevicePayloads.map(p=>({...p,sendBytes:value(p.sendBytes,scope,'byte'),receiveBytes:value(p.receiveBytes,scope,'byte')}))}:{}),timing:c.timing.kind==='custom_formula'?{...c.timing,seconds:value(c.timing.seconds,scope,'second')}:c.timing,placement:{nodeId:NodeId.parse(instancePath),phases:[phase],afterNodeIds:[],beforeNodeIds:[]},...(c.temporaryStorageIds?{temporaryStorageIds:c.temporaryStorageIds.map(id=>{const target=costStorages.get(id);if(!target)throw new FormulaError('missing_reference','collective 临时存储不存在 '+id);return target;})}:{})}};
          }
          const expandedNode:Node={nodeId:NodeId.parse(instancePath),name:node.name,phases:[phase],portBindings:[...portsResolved(source.inputs),...portsResolved(source.outputs)],stateBindings:[],body:resolvedBody};appendNode(expandedNode);if(body.kind==='collective')collectivePlacements.push({node:expandedNode,parentPath,after:body.communication.placement?.afterNodeIds??[],before:body.communication.placement?.beforeNodeIds??[]});nodeExpansions.set(instancePath,exp);
        }else {const id=target.assetId+'@'+target.revision;if(stack.includes(id))throw new FormulaError('dependency_cycle',`模块引用环 ${[...stack,id].join(' → ')}`);const definition=target.definition;if(definition.kind!=='operator'&&definition.kind!=='module')throw new FormulaError('reference_kind_mismatch','节点引用必须为模块或算子');exp=expandFrame(definition.kind==='operator'?definition.operator:definition.graph,target,instancePath,bound.symbols,external,stateBindings,[...stack,id],definition.kind==='operator');const leaf=graph.nodes.find(n=>n.nodeId===instancePath);if(leaf)leaf.name=node.name;}
        instances.push(exp);allLeaves.push(...exp.leaves);
        if(outer){for(const p of source.inputs){const to=exp.inputs.get(p.portId),carry=node.repeat?.carry.find(c=>c.inputPortId===p.portId),from=i>0&&carry?instances[i-1]?.outputs.get(carry.outputPortId):outer.inputs.get(p.portId);if(!to||!from)throw new FormulaError('invalid_repeat','repeat 输入连线缺失');wire(from,to);}}
      }
      if(!outer){const exp=instances[0];if(!exp)throw new FormulaError('invalid_graph','展开结果为空');return exp;}
      for(const p of source.outputs){const to=outer.outputs.get(p.portId);if(!to)throw new FormulaError('invalid_repeat','repeat 输出缺失');
        if(node.repeat?.wiring==='independent'){
          spend();
          const id=NodeId.parse(path+'/$outputs:'+encode(p.portId)),outputId=bindings.get(p.portId);if(!outputId)throw new FormulaError('invalid_repeat','repeat 输出绑定缺失');
          const inputPorts=instances.map((exp,i)=>{const from=exp.outputs.get(p.portId),tensorId=from?ports.get(from)?.tensorId:undefined;if(!from||!tensorId)throw new FormulaError('invalid_repeat','独立输出切片缺失');return {portId:'i'+i,tensorId,from};});
          const view=endpoints(id,inputPorts,[{portId:'out',tensorId:outputId}],new Map([...inputPorts.map(p=>[p.tensorId,p.tensorId] as const),[outputId,outputId]]),true);
          appendNode({nodeId:id,name:'Repeat output view',phases:[phase],portBindings:[...inputPorts.map(({portId,tensorId})=>({portId,tensorId})),{portId:'out',tensorId:outputId}],stateBindings:[],body:{kind:'opaque',inputs:inputPorts.map(({portId,tensorId})=>({portId,tensorId})),outputs:[{portId:'out',tensorId:outputId}],cost:{compute:[],memoryAccess:[],temporaryStorageIds:[],timing:{kind:'fixed',seconds:0,description:'Metadata-only stacked view; no data copy or extra arithmetic'}}}});
          for(const p of inputPorts){const target=view.inputs.get(p.portId);if(!target)throw new FormulaError('invalid_repeat','view 输入缺失');wire(p.from,target);}const from=view.outputs.get('out');if(!from)throw new FormulaError('invalid_repeat','view 输出缺失');wire(from,to);allLeaves.push(id);
          if(derived&&layoutTrace&&repeatCount){
            const output=tensorById.get(outputId);
            const wanted=layoutTrace.target.kind==='tensor'?layoutTrace.target.tensorId===outputId:output&&canonicalStorage(output.storageId)===layoutTrace.target.storageId;
            if(output&&wanted){
              const inputs=inputPorts.map((port,instanceIndex)=>{
                const tensor=tensorById.get(port.tensorId);
                if(!tensor)throw new FormulaError('invalid_repeat','堆叠视图输入张量缺失');
                return {instanceIndex,tensorId:tensor.tensorId,storageId:tensor.storageId,shape:tensor.shape};
              });
              derived(structuredClone({kind:'repeat_stack',viewNodeId:id,repeatNodeId:NodeId.parse(path),tensorId:outputId,storageId:canonicalStorage(output.storageId),
                portId:p.portId,count:repeatCount,shape:output.shape,inputs}));
            }
          }
        }else {const from=instances.at(-1)?.outputs.get(p.portId);if(!from)throw new FormulaError('invalid_repeat','chain 输出缺失');wire(from,to);}
      }
      outer.leaves=allLeaves;containers.push({nodeId:NodeId.parse(path),name:node.name,asset:{assetId:target.assetId,revision:target.revision,kind:target.definition.kind},leafNodeIds:allLeaves});nodeExpansions.set(path,outer);return outer;
    }
    const workload:Record<string,Quantity>={};for(const [key,value] of Object.entries(scenario.workload))if(typeof value==='number')workload[key]={value,unit:'count'};
    parameterCapture?.workload(workload);
    const bound=parameterCapture?parameterCapture.bind(root,scenario.bindings,workload,assets,scenario,NodeId.parse('$model'),true):bindParameters(root,scenario.bindings,workload,assets,scenario,NodeId.parse('$model'),true);parameters.push(...bound.parameters);
    const expanded=expandFrame(root.definition.graph,root,'',bound.symbols,new Map(),new Map(),[root.assetId+'@'+root.revision]);void expanded;
    graph.inputs=root.definition.graph.inputs.map(p=>({...p,tensorId:ports.get(key('','in',p.portId))?.tensorId??p.tensorId}));graph.outputs=root.definition.graph.outputs.map(p=>({...p,tensorId:ports.get(key('','out',p.portId))?.tensorId??p.tensorId}));
    function sources(k:string):Endpoint[]{const seen=new Set<string>();let current=k;while(true){if(seen.has(current))throw new FormulaError('dependency_cycle','数据连线存在循环');seen.add(current);const p=ports.get(current);if(!p)throw new FormulaError('invalid_port','端口不存在');if(p.source)return [p.source];const links=incoming.get(current)??[];if(links.length>1)throw new FormulaError('invalid_port','输入端口存在多个来源');const next=links[0];if(!next)return [];current=next;}}
    for(const [k,p] of ports)if(p.consumer){const from=sources(k);if(from.length>1)throw new FormulaError('invalid_port','端口存在多个生产者');if(!from.length){const tensor=tensorById.get(p.tensorId),storage=tensor?storageById.get(canonicalStorage(tensor.storageId)):undefined;const declaredState=storage?.category==='state'&&graph.states.some(s=>s.storageIds.some(id=>canonicalStorage(id)===storage.storageId));if(p.consumer.kind==='graph_output'||(storage?.category!=='weight'&&!declaredState))throw new FormulaError('missing_reference','激活输入/图输出缺少来源，或状态未显式声明');continue;}for(const source of from)graph.edges.push({edgeId:'resolved-edge-'+graph.edges.length,from:source,to:p.consumer,tensorId:p.tensorId});}
    function readers(k:string,seen=new Set<string>()):Endpoint[]{if(seen.has(k))throw new FormulaError('dependency_cycle','状态端口连线存在环');const port=ports.get(k);if(port?.consumer?.kind==='node')return [port.consumer];return (outgoing.get(k)??[]).flatMap(next=>readers(next,new Set([...seen,k])));}
    const endpoint=(path:string,local:{nodeId:NodeId;portId:string},direction:'in'|'out')=>{const scope=local.nodeId==='$self'?path:nodePath(path,local.nodeId),exp=nodeExpansions.get(scope);const k=(direction==='in'?exp?.inputs:exp?.outputs)?.get(local.portId);if(!k)throw new FormulaError('invalid_state_binding','状态引用缺少实际节点端口');return direction==='in'?readers(k):sources(k);};
    for(const item of deferredStates){const {state,local,path,bound}=item;
      if(!bound&&local.creator.kind==='node'){const creator=endpoint(path,local.creator,'out');if(creator.length!==1||creator[0]?.kind!=='node')throw new FormulaError('invalid_state_binding','状态 creator 必须有唯一节点来源');state.creator=creator[0];}
      for(const [direction,items] of [['in',local.readers],['out',local.writers]] as const)for(const p of items)for(const resolved of endpoint(path,p,direction)){if(resolved.kind!=='node')throw new FormulaError('invalid_state_binding','状态访问必须指向实际节点');const target=direction==='in'?state.readers:state.writers;if(!target.some(p=>p.nodeId===resolved.nodeId&&p.portId===resolved.portId))target.push(resolved);}
    }
    if(stepContext){for(const id of stepContext.carriedStateIds)if(!graph.states.some(s=>s.stateId===id))throw new FormulaError('missing_reference','carry 状态缺失 '+id);for(const state of graph.states)if(stepContext.carriedStateIds.includes(state.stateId)){if(state.creator.kind==='node'&&!state.writers.some(p=>canonical(p)===canonical(state.creator)))state.writers.push(state.creator);state.creator={kind:'initialized'};}}
    for(const state of graph.states){
      if(state.updatePolicy.kind==='append'&&state.updatePolicy.fixedCapacity){
        const capacity=numericValue(state.updatePolicy.fixedCapacity,'count',context({}),true);
        const past=scenario.workload.kind==='decode'?scenario.workload.contextTokensPerRequest:scenario.workload.pastTokensPerRequest;
        const calls=scenario.workload.kind==='decode'&&scenario.workload.approximation!=='fixed_context'?scenario.workload.steps:1;
        if(past+calls*scenario.workload.queryTokensPerRequest>capacity)throw new FormulaError('fixed_cache_capacity','上下文和查询超过固定 KV 槽位 '+capacity);
        for(const id of state.storageIds){
          const allocation=storageById.get(canonicalStorage(id))?.allocation;
          const token=allocation?.kind==='tensor'?allocation.shape.filter(axis=>axis.semantic==='token'):[];
          if(token.length!==1||token[0]?.size.kind!=='literal'||token[0].size.quantity.value!==capacity)throw new FormulaError('invalid_state_binding','固定 KV 槽位与物理存储长度不一致 '+id);
        }
      }
      const allowed=new Set(state.storageIds.map(canonicalStorage));
      for(const [mode,accesses] of [['read',state.readers],['write',[...state.writers,...(state.creator.kind==='node'?[state.creator]:[])]]] as const)for(const access of accesses){
        const port=ports.get(key(access.nodeId,mode==='read'?'in':'out',access.portId)),tensor=port?tensorById.get(port.tensorId):undefined;
        const node=graph.nodes.find(n=>n.nodeId===access.nodeId),body=node?.body,endpoint=body?.kind==='collective'?(mode==='read'?body.communication.source:body.communication.destination):undefined,communicationTensor=endpoint?tensorById.get(endpoint.tensorId):undefined,declared=body?.kind==='opaque'?body.cost.memoryAccess.some(a=>a.mode===mode&&allowed.has(canonicalStorage(a.storageId))):body?.kind==='collective'&&communicationTensor!==undefined&&allowed.has(canonicalStorage(communicationTensor.storageId));if(!tensor||!allowed.has(canonicalStorage(tensor.storageId))||!declared)throw new FormulaError('invalid_state_binding','状态端口、底层存储与节点读写声明不一致');
      }
    }
    for(const item of collectivePlacements){const b=item.node.body;if(b.kind!=='collective'||!b.communication.placement)throw new FormulaError('invalid_graph','collective 展开类型丢失');const expand=(id:NodeId)=>{const exp=nodeExpansions.get(nodePath(item.parentPath,id));if(!exp)throw new FormulaError('missing_reference','collective 依赖缺少当前阶段节点 '+id);return exp.leaves;};const refs=(ids:NodeId[],after:boolean)=>{const selected=new Set<NodeId>();for(const id of ids)for(const target of expand(id)){if(selected.has(target))continue;if(controlPairs.length>=limits.maxNodes*16)throw new FormulaError('expansion_limit','collective 依赖展开超过预算');selected.add(target);controlPairs.push(after?[target,item.node.nodeId,'synchronization']:[item.node.nodeId,target,'synchronization']);}return [...selected];};b.communication.placement.afterNodeIds=refs(item.after,true);b.communication.placement.beforeNodeIds=refs(item.before,false);}
    for(const [fromNodeId,toNodeId,kind] of controlPairs)graph.dependencies.push({edgeId:'resolved-control-'+graph.dependencies.length,fromNodeId,toNodeId,kind});
    for(const override of scenario.numericOverrides)if(override.field==='parameter'){
      const nodeId=override.target.kind==='node'?override.target.nodeId:'$model';if((override.target.kind==='node'||override.target.kind==='project'||override.target.kind==='scenario')&&!parameters.some(p=>p.nodeId===nodeId&&p.parameterKey===override.parameterKey))throw new FormulaError('missing_reference',`参数覆盖没有匹配目标 ${nodeId}:${override.parameterKey}`);
    }
    const {configMapping,configImport,fusionPresets,...validatedTemplate}=root;void configMapping;void configImport;void fusionPresets;const resolvedRoot={...validatedTemplate,parameters:[],definition:{...root.definition,workloadBindings:[],graph}},checked=validateAssets([resolvedRoot],[...assets.filter(a=>a.assetId!==root.assetId||a.revision!==root.revision),resolvedRoot]),errors=checked.filter(d=>d.severity==='error');if(errors.length)return InstantiationResult.parse({status:'unavailable',diagnostics:errors});diagnostics.push(...checked.filter(d=>d.severity!=='error'));
    topologicalOrder(graph);
    const resolved=ResolvedGraph.parse({phase,graph,containers,parameters,assetRefs:[...references.values()],objectBindings,quantizationApplications:[],fusionApplications:[]});
    applyQuantization(resolved,scenario,assets,diagnostics,observer?.quantization,executionInputs.length>0);
    if(executionInputs.length){
      const applications=new Map(resolved.quantizationApplications.map(application=>[application.storageId,application]));
      const storages=new Map(resolved.graph.storages.map(storage=>[storage.storageId,storage]));
      for(const input of executionInputs){
        const activation=storages.get(input.activation)?.allocation;
        if(activation?.kind!=='tensor'||activation.quantization||input.weights.some(id=>!applications.get(id)?.assignmentIndices.includes(input.ruleIndex))){
          throw new FormulaError('incompatible_quantized_execution','算子的发布权重或动态量化输入已被覆盖 '+input.nodeId);
        }
      }
    }
    applyFusion(resolved,scenario,assets,diagnostics,observer?.fusion);
    if(parameterCapture)observer?.bindingTraceReady?.(parameterCapture.snapshot());
    return InstantiationResult.parse({status:'available',resolved,diagnostics});
  }catch(e){diagnostics.push({diagnosticId:'instantiation-error',severity:'error',code:e instanceof FormulaError?e.code:'invalid_graph',message:e instanceof Error?e.message:'模型实例化失败',location:{kind:'node',nodeId:NodeId.parse(cursor)}});return InstantiationResult.parse({status:'unavailable',diagnostics});}
}



