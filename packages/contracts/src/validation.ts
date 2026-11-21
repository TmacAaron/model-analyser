import { ascendProjectProblems } from './ascend-quantization.js';
import { declaredRecipeIssues } from './parallel-bindings.js';
import { sendRecvIssue } from './communication-peers.js';
import { AssetDocument, type AssetRef, type GraphTemplate, type Diagnostic, ProjectDocument, type ValueExpr, type Quantity, type CostDefinition,type LocalCostRule } from './index.js';
import { validateScenario } from './scenario-validation.js';
import { parseExpression, expressionSymbols } from './expression.js';
import { modelWeightProfileIssues,quantizationRuleIssues } from './quantization-validation.js';
import { quantizedExecutionBody } from './quantized-execution.js';
import { collectivePorts } from './collective.js';
import { configProfileProblems,reviewConfigImport } from './config-import.js';
import { measurementProblems } from './measurement-file.js';

export function canonical(value:unknown):string {
  if(value===null||typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
}
export function collectRefs(value:unknown):AssetRef[] {
  if(value===null||typeof value!=='object') return [];
  if(!Array.isArray(value)&&Object.keys(value).length===3&&'assetId' in value&&'revision' in value&&'kind' in value) {
    const ref=AssetRefSchema.safeParse(value);if(ref.success) return [ref.data];
  }
  return Object.values(value).flatMap(collectRefs);
}
export const assetDependencies=(asset:AssetDocument):AssetRef[]=>collectRefs({definition:asset.definition,...(asset.parallelPresets?{parallelPresets:asset.parallelPresets}:{}),...(asset.fusionPresets?{fusionPresets:asset.fusionPresets}:{})});
/** Reproducible data closure, including inactive authoring recipes; distinct from mathematical identity. */
export function completeAssetSnapshots(roots:AssetDocument[],library:AssetDocument[]=roots):AssetDocument[]{
  const pool=new Map<string,AssetDocument[]>(),found=new Map<string,AssetDocument>();
  for(const a of [...library,...roots]){const key=a.assetId+'@'+a.revision;pool.set(key,[...(pool.get(key)??[]),a]);}
  function visit(ref:AssetRef,stack:string[]){const key=ref.assetId+'@'+ref.revision;if(stack.includes(key)||stack.length>64)throw Error('固定快照依赖环或深度超过64');if(found.has(key))return;if(found.size>=10000)throw Error('固定快照超过10000个资产');const matches=pool.get(key),asset=matches?.[0];if(!matches||!asset||asset.definition.kind!==ref.kind)throw Error('固定快照依赖缺失或类型不符 '+key);if(matches.some(a=>a!==asset&&(a.definition.kind!==ref.kind||canonical(a)!==canonical(asset))))throw Error('固定快照同修订内容冲突 '+key);found.set(key,asset);for(const child of assetDependencies(asset))visit(child,[...stack,key]);}
  for(const a of roots)visit({assetId:a.assetId,revision:a.revision,kind:a.definition.kind},[]);return [...found.values()].sort((a,b)=>{const x=a.assetId+'@'+a.revision,y=b.assetId+'@'+b.revision;return x<y?-1:x>y?1:0;});
}
import { AssetRef as AssetRefSchema,NodeId as NodeIdSchema } from './index.js';
export function validateAssets(roots:AssetDocument[],library:AssetDocument[]=roots):Diagnostic[] {
  const diagnostics:Diagnostic[]=[];
  const report=(asset:AssetDocument,code:string,message:string,fieldPath?:string)=>diagnostics.push({diagnosticId:`d${diagnostics.length+1}`,severity:'error',code,message,
    location:{kind:'asset',assetId:asset.assetId,...(fieldPath===undefined?{}:{fieldPath})}});
  const unique=(asset:AssetDocument,items:string[],field:string)=>{if(new Set(items).size!==items.length) report(asset,'duplicate_id',`${field} 含重复 ID`,field);};
  const byKey=new Map(library.map(a=>[`${a.assetId}@${a.revision}`,a]));
  const visited=new Set<string>();
  function expression(asset:AssetDocument,value:ValueExpr,unit:Quantity['unit'],path:string,integer=false,minimum=0):void {
    if(value.kind==='literal'){
      if(value.quantity.unit!==unit)report(asset,'invalid_unit',`需要 ${unit}，收到 ${value.quantity.unit}`,path);
      if(value.quantity.value<minimum||(integer&&!Number.isSafeInteger(value.quantity.value)))report(asset,'invalid_shape','数值超出范围或不是安全整数',path);
      if(!integer&&value.quantity.value>Number.MAX_SAFE_INTEGER)diagnostics.push({diagnosticId:`d${diagnostics.length+1}`,severity:'warning',code:'precision_estimate',message:'超过安全整数，按浮点估计值处理',location:{kind:'asset',assetId:asset.assetId,fieldPath:path}});
      return;
    }
    if(value.kind==='symbol'){
      const parameter=asset.parameters.find(p=>p.key===value.name);
      if(!parameter)report(asset,'unbound_symbol',`未声明参数 ${value.name}`,path);
      else if((parameter.type!=='integer'&&parameter.type!=='number')||parameter.unit!==unit)report(asset,'invalid_unit',`参数 ${value.name} 的类型/单位与 ${unit} 不符`,path);
      return;
    }
    const target=byKey.get(`${value.call.formula.assetId}@${value.call.formula.revision}`);
    if(target?.definition.kind!=='formula')return; // Missing/kind/cycle diagnostics are emitted by reference traversal.
    const formula=target.definition.formula;
    if(formula.output.unit!==unit)report(asset,'invalid_unit',`公式输出 ${formula.output.unit} 与 ${unit} 不符`,path);
    for(const key of Object.keys(value.call.bindings))if(!Object.hasOwn(formula.inputs,key))report(asset,'unbound_symbol',`公式未声明输入 ${key}`,path+'.bindings.'+key);
    for(const [key,input] of Object.entries(formula.inputs)){
      const binding=value.call.bindings[key];if(!binding)report(asset,'unbound_symbol',`公式缺少绑定 ${key}`,path+'.bindings');
      else {expression(asset,binding,input.unit,path+'.bindings.'+key,input.integerRequired,input.min??-Number.MAX_VALUE);if(binding.kind==='literal'&&input.max!==undefined&&binding.quantity.value>input.max)report(asset,'invalid_shape','公式绑定超出 max',path+'.bindings.'+key);}
    }
  }
  function cost(asset:AssetDocument,value:CostDefinition,storages:GraphTemplate['storages'],path:string){
    unique(asset,value.compute.map(c=>c.segmentId),path+'.compute');unique(asset,value.memoryAccess.map(a=>a.accessId),path+'.memoryAccess');
    for(const [i,c] of value.compute.entries()){
      expression(asset,c.usefulOperations,'operation',path+`.compute.${i}.usefulOperations`);expression(asset,c.executedOperations,'operation',path+`.compute.${i}.executedOperations`);
      if(c.usefulOperations.kind==='literal'&&c.executedOperations.kind==='literal'&&c.executedOperations.quantity.value<c.usefulOperations.quantity.value)report(asset,'invalid_cost','执行工作量不得小于有效工作量',path+`.compute.${i}`);
      if((c.computeClass.resource==='custom')!==Boolean(c.computeClass.resourceKey))report(asset,'invalid_compute_class','custom 资源必须且仅能提供 resourceKey',path+`.compute.${i}`);
    }
    for(const [i,a] of value.memoryAccess.entries()){
      if(!storages.some(s=>s.storageId===a.storageId))report(asset,'missing_reference',`访问存储不存在 ${a.storageId}`,path+`.memoryAccess.${i}`);
      if(a.logicalBytes.kind==='storage_allocation'){
        const passes=a.logicalBytes.passes;
        const target=passes.kind==='formula'?byKey.get(`${passes.call.formula.assetId}@${passes.call.formula.revision}`):undefined;
        const ratio=passes.kind==='literal'?passes.quantity.unit==='ratio':passes.kind==='symbol'
          ?asset.parameters.some(p=>p.key===passes.name&&p.unit==='ratio'):target?.definition.kind==='formula'&&target.definition.formula.output.unit==='ratio';
        const field=path+`.memoryAccess.${i}.logicalBytes.passes`;
        expression(asset,passes,ratio?'ratio':'count',field,!ratio);
        if(ratio&&passes.kind==='literal'&&passes.quantity.value>1)report(asset,'invalid_storage_access','存储份额不得超过 1',field);
      }else expression(asset,a.logicalBytes,'byte',path+`.memoryAccess.${i}.logicalBytes`);
      if(a.hbmEstimate?.kind==='bytes')expression(asset,a.hbmEstimate.value,'byte',path+`.memoryAccess.${i}.hbmEstimate`);
    }
    for(const id of value.temporaryStorageIds)if(!storages.some(s=>s.storageId===id))report(asset,'missing_reference',`临时存储不存在 ${id}`,path+'.temporaryStorageIds');
    if(value.timing.kind==='custom_formula')expression(asset,value.timing.seconds,'second',path+'.timing.seconds');
  }
  function localCost(asset:AssetDocument,rule:LocalCostRule,tensors:GraphTemplate['tensors'],storages:GraphTemplate['storages'],path:string){
    unique(asset,rule.bindings.map(b=>b.symbol),path+'.bindings');
    const check=(source:LocalCostRule['bindings'][number]['source']|LocalCostRule['participation'])=>{
      if('tensorId' in source){const tensor=tensors.find(t=>t.tensorId===source.tensorId);if(!tensor)report(asset,'missing_reference','局部成本引用缺少张量 '+source.tensorId,path);else if((source.kind==='tensor_axis'||source.kind==='tensor_slice')&&!tensor.shape.some(a=>a.axisId===source.axisId))report(asset,'missing_reference','局部成本引用缺少张量轴 '+source.axisId,path);}
      else if(!storages.some(s=>s.storageId===source.storageId))report(asset,'missing_reference','局部成本引用缺少存储 '+source.storageId,path);
    };
    check(rule.participation);rule.bindings.forEach(b=>check(b.source));
    const scoped:AssetDocument={...asset,parameters:[...asset.parameters.filter(p=>!rule.bindings.some(b=>b.symbol===p.key)),...rule.bindings.map(b=>({key:b.symbol,name:b.symbol,type:'integer' as const,unit:b.source.kind==='storage_bytes'?'byte' as const:'count' as const,min:0}))]};
    cost(scoped,rule.cost,storages,path+'.cost');
  }
  function visit(asset:AssetDocument,stack:string[]) {
    const key=`${asset.assetId}@${asset.revision}`;
    if(stack.includes(key)){report(asset,'dependency_cycle',[...stack,key].join(' → '));return;}
    if(visited.has(key)) return;visited.add(key);
    for(const ref of assetDependencies(asset)) {
      const target=byKey.get(`${ref.assetId}@${ref.revision}`);
      if(!target) report(asset,'missing_reference',`缺少 ${ref.assetId}@${ref.revision}`);
      else if(target.definition.kind!==ref.kind) report(asset,'reference_kind_mismatch',`${ref.assetId} 类型不符`);
      else visit(target,[...stack,key]);
    }
    unique(asset,asset.parameters.map(p=>p.key),'parameters');
    if(asset.parallelPresets){if(asset.definition.kind!=='model')report(asset,'invalid_parallel_preset','仅模型可声明并行快捷预设','parallelPresets');unique(asset,asset.parallelPresets.map(p=>p.presetId),'parallelPresets');for(const p of asset.parallelPresets){for(const message of declaredRecipeIssues(p))report(asset,'invalid_parallel_preset',message,'parallelPresets.'+p.presetId);unique(asset,p.tensorShards.map(r=>r.tensorId),'parallelPresets.tensorShards');unique(asset,p.reductions.map(r=>r.tensorId),'parallelPresets.reductions');if(p.strategy!=='tensor_sharded'&&p.strategy!=='decode_context_sharded'&&(p.tensorShards.length||p.reductions.length))report(asset,'invalid_parallel_preset','复制/DP 预设不能夹带 TP 分片或归约','parallelPresets.'+p.presetId);}}
    if(asset.fusionPresets){const d=asset.definition;if(d.kind!=='model'&&d.kind!=='module')report(asset,'invalid_fusion_preset','融合预设必须属于模型或模块','fusionPresets');else{const graph=d.graph;unique(asset,asset.fusionPresets.map(p=>p.presetId),'fusionPresets');for(const p of asset.fusionPresets){const path='fusionPresets.'+p.presetId;unique(asset,p.group.memberNodeIds,path+'.members');unique(asset,p.group.eliminatedTensorIds,path+'.tensors');for(const id of p.group.memberNodeIds)if(!graph.nodes.some(n=>n.nodeId===id&&p.phases.every(phase=>n.phases.includes(phase))))report(asset,'invalid_fusion_preset','成员必须是声明阶段的直接图节点 '+id,path);for(const id of p.group.eliminatedTensorIds)if(!graph.tensors.some(t=>t.tensorId===id))report(asset,'invalid_fusion_preset','缺少本地张量 '+id,path);cost(asset,p.group.extraCost,graph.storages,path+'.extraCost');if(p.group.timeStrategy.kind==='override'&&p.group.timeStrategy.timing.kind==='custom_formula')expression(asset,p.group.timeStrategy.timing.seconds,'second',path+'.timing');}}}
    for(const message of configProfileProblems(asset))report(asset,'invalid_config_profile',message,'configMapping');
    if(asset.configImport){if(asset.configImport.status!=='confirmed')report(asset,'config_review_required','config 导入尚待逐项核对，仅保存草稿','configImport.status');for(const issue of reviewConfigImport(asset).filter(i=>!i.resolved))report(asset,issue.code,issue.message,'configImport.'+issue.field);}
    if(asset.definition.kind==='model'&&asset.definition.workloadBindings){unique(asset,asset.definition.workloadBindings.map(b=>b.phase+':'+b.parameterKey),'workloadBindings');for(const b of asset.definition.workloadBindings){const p=asset.parameters.find(p=>p.key===b.parameterKey);if(!p||p.type!=='integer'&&p.type!=='number'){report(asset,'invalid_workload_binding','工作负载绑定必须指向数值参数','workloadBindings');continue;}const fields=b.phase==='decode'?['batchSize','contextTokensPerRequest','queryTokensPerRequest','steps']:['batchSize','queryTokensPerRequest','pastTokensPerRequest','chunkTokens'],scoped:AssetDocument={...asset,parameters:fields.map(key=>({key,name:key,type:'integer',unit:'count',min:['batchSize','queryTokensPerRequest','steps','chunkTokens'].includes(key)?1:0}))};expression(scoped,b.value,p.unit,'workloadBindings.'+b.phase+'.'+b.parameterKey,p.type==='integer');}}
    if(asset.definition.kind==='hardware'){const h=asset.definition.hardware;unique(asset,h.computeCapabilities.map(c=>canonical(c.computeClass)),'definition.hardware.computeCapabilities');unique(asset,h.memoryCapabilities.map(c=>c.key),'definition.hardware.memoryCapabilities');unique(asset,h.communicationDefaults.map(c=>c.scope),'definition.hardware.communicationDefaults');}
    if(asset.definition.kind==='quantization'){
      for(const issue of quantizationRuleIssues(asset.definition.quantization,library))report(asset,issue.code,issue.message,'definition.quantization'+(issue.path?'.'+issue.path:''));
      for(const message of modelWeightProfileIssues(asset,library))report(asset,'invalid_model_weight_profile',message,'definition.modelWeights');
      for(const section of asset.definition.modelWeights?.moduleRules??[]){
        const module=byKey.get(section.module.assetId+'@'+section.module.revision);
        if(module?.definition.kind!=='module')continue;
        const graph=module.definition.graph;
        for(const execution of section.execution??[]){
          const source=graph.nodes.find(node=>node.nodeId===execution.nodeId)?.body;
          if(source?.kind!=='opaque')continue;
          const path='definition.modelWeights.execution.'+execution.nodeId;
          try{
            const body=quantizedExecutionBody(source,execution);
            cost(module,body.cost,graph.storages,path);
            if(body.localCost)localCost(module,body.localCost,graph.tensors,graph.storages,path+'.local');
          }catch(error){report(asset,'invalid_quantized_execution',error instanceof Error?error.message:'量化计算声明无效',path);}
        }
      }
    }
    if(asset.definition.kind==='formula') {
      try {const symbols=expressionSymbols(parseExpression(asset.definition.formula.expression));for(const symbol of symbols)if(!Object.hasOwn(asset.definition.formula.inputs,symbol))report(asset,'unbound_symbol',`未声明输入 ${symbol}`);}
      catch(e){report(asset,'invalid_formula',e instanceof Error?e.message:'公式非法');}
    }
    for(const p of asset.parameters){
      if(p.type==='enum') {unique(asset,p.choices,`parameters.${p.key}.choices`);if(p.default&&!p.choices.includes(p.default.value)) report(asset,'invalid_parameter','枚举默认值不在 choices');}
      if(p.type==='number'||p.type==='integer') {
        if(p.min!==undefined&&p.max!==undefined&&p.min>p.max) report(asset,'invalid_parameter','min 大于 max');
        if(p.default&&((p.min!==undefined&&p.default.value<p.min)||(p.max!==undefined&&p.default.value>p.max))) report(asset,'invalid_parameter','默认值超出范围');
      }
    }
    if(asset.definition.kind==='model'||asset.definition.kind==='module') graph(asset,asset.definition.graph);
    if(asset.definition.kind==='operator') {
      const op=asset.definition.operator;storage(asset,op.storages);cost(asset,op.cost,op.storages,'operator.cost');if(op.localCost)localCost(asset,op.localCost,op.tensors,op.storages,'operator.localCost');
      for(const t of op.tensors){if(!op.storages.some(s=>s.storageId===t.storageId))report(asset,'missing_reference','张量存储不存在','operator.tensors');for(const axis of t.shape)expression(asset,axis.size,'count','operator.tensors.shape',true);}
    }
  }
  function storage(asset:AssetDocument,storages:GraphTemplate['storages']) {
    const map=new Map(storages.map(s=>[s.storageId,s]));unique(asset,storages.map(s=>s.storageId),'storages');
    for(const s of storages){const seen=new Set<string>();let current=s;
      if(s.allocation.kind==='bytes')expression(asset,s.allocation.value,'byte',`storages.${s.storageId}.allocation`,true);
      if(s.allocation.kind==='tensor')for(const axis of s.allocation.shape)expression(asset,axis.size,'count',`storages.${s.storageId}.shape.${axis.axisId}`,true);
      while(current.allocation.kind==='alias') {
        if(seen.has(current.storageId)){report(asset,'dependency_cycle',`存储 alias 循环 ${s.storageId}`);break;}seen.add(current.storageId);
        const next=map.get(current.allocation.targetStorageId);if(!next){report(asset,'missing_reference',`缺少 storage ${current.allocation.targetStorageId}`);break;}current=next;
      }
    }
  }
  function graph(asset:AssetDocument,g:GraphTemplate) {
    unique(asset,g.nodes.map(n=>n.nodeId),'nodes');unique(asset,g.tensors.map(t=>t.tensorId),'tensors');unique(asset,g.states.map(s=>s.stateId),'states');
    unique(asset,[...g.edges,...g.dependencies].map(e=>e.edgeId),'edges');storage(asset,g.storages);
    const tensors=new Set(g.tensors.map(t=>t.tensorId)),storages=new Set(g.storages.map(s=>s.storageId));
    const nodes=new Map<string,GraphTemplate['nodes'][number]>(g.nodes.map(n=>[n.nodeId,n]));
    for(const tensor of g.tensors){if(!storages.has(tensor.storageId)) report(asset,'missing_reference',`张量 ${tensor.tensorId} 的存储缺失`);unique(asset,tensor.shape.map(a=>a.axisId),'shape');for(const axis of tensor.shape)expression(asset,axis.size,'count',`tensors.${tensor.tensorId}.shape.${axis.axisId}`,true);}
    for(const [label,ports] of [['inputs',g.inputs],['outputs',g.outputs]] as const){unique(asset,ports.map(p=>p.portId),label);for(const p of ports) if(!tensors.has(p.tensorId)) report(asset,'missing_reference',`端口 ${p.portId} 的张量缺失`);}
    const links=new Map<string,string[]>();
    const link=(from:string,to:string)=>{if(!nodes.has(from)||!nodes.has(to))report(asset,'missing_reference',`依赖节点缺失 ${from} → ${to}`);else links.set(from,[...(links.get(from)??[]),to]);};
    const destinations=new Set<string>(),producers=new Map<string,string>();
    function endpoint(e:GraphTemplate['edges'][number]['from'],source:boolean):string|undefined {
      if((e.kind==='graph_output'&&source)||(e.kind==='graph_input'&&!source)){report(asset,'invalid_port','图边界方向错误');return;}
      if(e.kind!=='node') return (e.kind==='graph_input'?g.inputs:g.outputs).find(p=>p.portId===e.portId)?.tensorId;
      const node=nodes.get(e.nodeId);if(!node)return;
      let ports:typeof g.inputs=[];
      if(node.body.kind==='opaque') ports=source?node.body.outputs:node.body.inputs;
      else if(node.body.kind==='collective'){const iface=collectivePorts(node.body.communication);ports=source?iface.outputs:iface.inputs;}
      else if(node.body.kind==='operator'||node.body.kind==='module') {
        const target=byKey.get(`${node.body.asset.assetId}@${node.body.asset.revision}`);
        const definition=target?.definition;
        if(definition?.kind==='operator') ports=source?definition.operator.outputs:definition.operator.inputs;
        else if(definition?.kind==='module') ports=source?definition.graph.outputs:definition.graph.inputs;
      }
      if(!ports.some(p=>p.portId===e.portId))return;
      return node.portBindings.find(p=>p.portId===e.portId)?.tensorId;
    }
    for(const e of g.edges){
      if(endpoint(e.from,true)!==e.tensorId||endpoint(e.to,false)!==e.tensorId||!tensors.has(e.tensorId)) report(asset,'invalid_port',`边 ${e.edgeId} 的端口/张量不一致`);
      const destination=canonical(e.to),producer=canonical(e.from);
      if(destinations.has(destination))report(asset,'invalid_port',`输入多来源 ${destination}`);destinations.add(destination);
      if(producers.has(e.tensorId)&&producers.get(e.tensorId)!==producer)report(asset,'invalid_port',`张量生产者冲突 ${e.tensorId}`);producers.set(e.tensorId,producer);
      if(e.from.kind==='node'&&e.to.kind==='node')link(e.from.nodeId,e.to.nodeId);
    }
    for(const e of g.dependencies)link(e.fromNodeId,e.toNodeId);
    const done=new Set<string>(),active=new Set<string>();
    function walk(id:string){
      if(done.has(id))return;
      // Graph depth is independent of module-reference depth. Keep the same DFS
      // order and cycle path without consuming one JavaScript frame per edge.
      const frames=[{id,cursor:0}];active.add(id);
      while(frames.length){const frame=frames.at(-1);if(!frame)throw Error('依赖遍历栈损坏');const targets=links.get(frame.id)??[],next=targets[frame.cursor++];
        if(next===undefined){active.delete(frame.id);done.add(frame.id);frames.pop();}
        else if(active.has(next))report(asset,'dependency_cycle',`单步依赖环 ${[...active,next].join(' → ')}`);
        else if(!done.has(next)){active.add(next);frames.push({id:next,cursor:0});}
      }
    }
    for(const node of g.nodes){unique(asset,node.portBindings.map(p=>p.portId),'portBindings');if(node.repeat?.wiring==='independent'&&node.repeat.carry.length)report(asset,'invalid_repeat','independent 不允许 carry');if(node.repeat)expression(asset,node.repeat.count,'count',`nodes.${node.nodeId}.repeat.count`,true,1);if(node.body.kind==='opaque'){cost(asset,node.body.cost,g.storages,`nodes.${node.nodeId}.cost`);if(node.body.localCost)localCost(asset,node.body.localCost,g.tensors,g.storages,`nodes.${node.nodeId}.localCost`);}}
    for(const node of g.nodes){
      for(const p of node.portBindings)if(!tensors.has(p.tensorId))report(asset,'missing_reference',`节点 ${node.nodeId} 端口 ${p.portId} 的张量缺失`, `nodes.${node.nodeId}.portBindings`);
      if(node.body.kind!=='module'&&node.body.kind!=='operator')continue;
      const body=node.body,target=byKey.get(`${body.asset.assetId}@${body.asset.revision}`);if(!target)continue;
      const iface=target.definition.kind==='module'?target.definition.graph:target.definition.kind==='operator'?target.definition.operator:undefined;
      if(iface){const ports=new Set([...iface.inputs,...iface.outputs].map(p=>p.portId));for(const id of ports)if(!node.portBindings.some(p=>p.portId===id))report(asset,'invalid_port',`节点 ${node.nodeId} 缺少端口映射 ${id}`,`nodes.${node.nodeId}.portBindings`);for(const p of node.portBindings)if(!ports.has(p.portId))report(asset,'invalid_port',`节点 ${node.nodeId} 引用了未知端口 ${p.portId}`,`nodes.${node.nodeId}.portBindings`);}
      unique(asset,body.bindings.map(b=>b.parameterKey),`nodes.${node.nodeId}.bindings`);
      const scoped:AssetDocument=node.repeat?{...asset,parameters:[...asset.parameters.filter(p=>p.key!==node.repeat?.axis),{key:node.repeat.axis,name:node.repeat.axis,type:'integer',unit:'count',min:0}]}:asset;
      for(const b of body.bindings){const p=target.parameters.find(p=>p.key===b.parameterKey),path=`nodes.${node.nodeId}.bindings.${b.parameterKey}`,v=b.value;
        if(!p){report(asset,'unbound_symbol',`目标未声明参数 ${b.parameterKey}`,path);continue;}
        if(v.kind==='literal'||v.kind==='symbol'||v.kind==='formula'){
          if(p.type!=='integer'&&p.type!=='number')report(asset,'invalid_parameter',`${p.key} 不接受数值表达式`,path);
          else {expression(scoped,v,p.unit,path,p.type==='integer',p.min??-Number.MAX_VALUE);if(v.kind==='literal'&&p.max!==undefined&&v.quantity.value>p.max)report(asset,'invalid_parameter',`${p.key} 超过参数上限`,path);}
        }else if(v.kind!==p.type)report(asset,'invalid_parameter',`${p.key} 参数类型不一致`,path);
        else if(p.type==='enum'&&v.kind==='enum'&&!p.choices.includes(v.value))report(asset,'invalid_parameter',`${p.key} 不在枚举选项中`,path);
        else if((p.type==='integer'||p.type==='number')&&(v.kind==='integer'||v.kind==='number')&&((p.min!==undefined&&v.value<p.min)||(p.max!==undefined&&v.value>p.max)))report(asset,'invalid_parameter',`${p.key} 超出参数范围`,path);
      }
      unique(asset,node.stateBindings.map(b=>b.localStateId),`nodes.${node.nodeId}.stateBindings`);
      for(const b of node.stateBindings)if(!iface?.states.some(s=>s.stateId===b.localStateId)||!g.states.some(s=>s.stateId===b.parentStateId))report(asset,'invalid_state_binding',`节点 ${node.nodeId} 的共享状态映射缺失`, `nodes.${node.nodeId}.stateBindings`);
    }
    for(const node of g.nodes)if(node.body.kind==='collective'){
      const c=node.body.communication,path=`nodes.${node.nodeId}.communication`,iface=collectivePorts(c);
      if(node.stateBindings.length)report(asset,'invalid_state_binding','collective 通过显式图张量引用状态，不绑定子状态',path);
      if(node.portBindings.length!==2||[...iface.inputs,...iface.outputs].some(p=>!node.portBindings.some(b=>b.portId===p.portId&&b.tensorId===p.tensorId)))report(asset,'invalid_port','collective 必须显式绑定 source/destination 两个固定端口到通信端点',path);
      if(!tensors.has(c.source.tensorId)||!tensors.has(c.destination.tensorId))report(asset,'missing_reference','collective 通信端点张量缺失',path);
      unique(asset,c.temporaryStorageIds??[],path+'.temporaryStorageIds');for(const id of c.temporaryStorageIds??[])if(!storages.has(id))report(asset,'missing_reference','collective 临时存储缺失 '+id,path);
      const scoped=node.repeat?{...asset,parameters:[...asset.parameters.filter(p=>p.key!==node.repeat?.axis),{key:node.repeat.axis,name:node.repeat.axis,type:'integer' as const,unit:'count' as const,min:0}]}:asset;
      const peerIssue=sendRecvIssue(c);if(peerIssue)report(asset,'invalid_distribution',peerIssue,path);
      if(c.perDevicePayloads){unique(asset,c.perDevicePayloads.map(p=>p.deviceId),path+'.perDevicePayloads');if(c.operation==='send_recv')report(asset,'invalid_member_payloads','send_recv不能声明集体通信的逐rank覆盖',path);for(const [i,p] of c.perDevicePayloads.entries()){expression(scoped,p.sendBytes,'byte',path+'.perDevicePayloads.'+i+'.sendBytes');expression(scoped,p.receiveBytes,'byte',path+'.perDevicePayloads.'+i+'.receiveBytes');}}
      expression(scoped,c.sendBytesPerMember,'byte',path+'.sendBytesPerMember');expression(scoped,c.receiveBytesPerMember,'byte',path+'.receiveBytesPerMember');if(c.timing.kind==='custom_formula')expression(scoped,c.timing.seconds,'second',path+'.timing.seconds');
      for(const endpoint of [c.source,c.destination]){const tensor=g.tensors.find(t=>t.tensorId===endpoint.tensorId),d=endpoint.distribution;if(d.kind==='sharded')for(const a of d.axes)if(!tensor?.shape.some(axis=>axis.axisId===a.tensorAxisId))report(asset,'missing_reference','collective 分片张量轴缺失 '+a.tensorAxisId,path);if(d.kind==='manual')for(const member of d.members)for(const axis of member.localShape)expression(scoped,axis.size,'count',path+'.distribution.localShape',true);}
      if(c.placement){if(c.placement.nodeId!==node.nodeId||node.phases.some(p=>!c.placement?.phases.includes(p)))report(asset,'invalid_communication_placement','图内通信 placement 必须匹配节点本地 ID 和所有适用阶段',path);unique(asset,c.placement.afterNodeIds,path+'.afterNodeIds');unique(asset,c.placement.beforeNodeIds,path+'.beforeNodeIds');for(const id of c.placement.afterNodeIds)link(id,node.nodeId);for(const id of c.placement.beforeNodeIds)link(node.nodeId,id);}
    }
    // Placement dependencies are graph dependencies too; validate after collecting them.
    done.clear();active.clear();for(const id of nodes.keys())walk(id);
    for(const state of g.states){
      for(const id of state.storageIds)if(!storages.has(id))report(asset,'missing_reference',`状态 ${state.stateId} 的存储缺失`);
      const statePort=(p:{nodeId:string;portId:string},source:boolean)=>{
        const tensor=p.nodeId==='$self'?(source?g.outputs:g.inputs).find(port=>port.portId===p.portId)?.tensorId:endpoint({kind:'node',nodeId:NodeIdSchema.parse(p.nodeId),portId:p.portId},source);
        if(tensor===undefined)report(asset,'invalid_state_binding',`状态 ${state.stateId} 的${source?'写入/创建':'读取'}端口缺失 ${p.nodeId}.${p.portId}`,`states.${state.stateId}`);
      };
      if(state.creator.kind==='node')statePort(state.creator,true);
      for(const p of state.readers)statePort(p,false);for(const p of state.writers)statePort(p,true);
    }
  }
  for(const asset of roots)visit(asset,[]);return diagnostics;
}
export function validateProject(project:ProjectDocument):Diagnostic[] {
  const diagnostics=validateAssets(project.assetSnapshots);
  const add=(code:string,message:string)=>diagnostics.push({diagnosticId:`p${diagnostics.length}`,severity:'error',code,message,location:{kind:'file',name:project.projectId}});
  for(const message of ascendProjectProblems(project))add('invalid_quantization_import',message);
  const keys=project.assetSnapshots.map(a=>`${a.assetId}@${a.revision}`);
  if(new Set(keys).size!==keys.length)add('duplicate_id','项目快照存在重复修订');
  for(const [label,ids] of [['scenarios',project.scenarios.map(s=>s.scenarioId)],['measurements',project.measurements.map(m=>m.measurementId)]] as const)if(new Set(ids).size!==ids.length)add('duplicate_id',`${label} ID 重复`);
  const draftIds=project.configurationDrafts?.map(d=>d.scenarioId)??[];if(new Set(draftIds).size!==draftIds.length)add('duplicate_id','配置编辑草稿重复');for(const id of draftIds)if(!project.scenarios.some(s=>s.scenarioId===id))add('missing_reference','配置编辑草稿缺少所属配置 '+id);
  for(const ref of project.scenarios.flatMap(s=>{const {ascendQuantizationImports,...base}=s;void ascendQuantizationImports;return collectRefs(base);})) {
    const asset=project.assetSnapshots.find(a=>a.assetId===ref.assetId&&a.revision===ref.revision);
    if(!asset)add('missing_reference',`项目缺少快照 ${ref.assetId}@${ref.revision}`);else if(asset.definition.kind!==ref.kind)add('reference_kind_mismatch','项目引用类型不符');
  }
  for(const m of project.measurements){
    for(const issue of measurementProblems(m))add(issue.code,issue.message);
    if(m.inputHash!==undefined&&m.target.kind!=='unmapped'){
      const scenario=project.scenarios.find(s=>s.scenarioId===m.scenarioId);
      if(!scenario||m.phase!==scenario.workload.kind||m.deviceIds.some(id=>!scenario.deviceTopology.devices.some(d=>d.deviceId===id)))diagnostics.push({diagnosticId:`measurement-scope-${m.measurementId}`,severity:'warning',code:'unknown_measurement_scope',message:'测量保留原输入版本，与当前方案阶段/设备不匹配，不能直接用于当前指标',location:{kind:'file',name:project.projectId}});
    }
  }
  for(const scenario of project.scenarios)diagnostics.push(...validateScenario(scenario,project.assetSnapshots));
  return diagnostics;
}
