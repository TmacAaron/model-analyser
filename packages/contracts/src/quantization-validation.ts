import type { Scenario,AssetDocument,ValueExpr,Quantity } from './index.js';
import { canonical } from './validation.js';

export function modelWeightProfileIssues(asset:AssetDocument,library:AssetDocument[]):string[]{
  if(asset.definition.kind!=='quantization'||!asset.definition.modelWeights)return [];
  const {model,moduleRules}=asset.definition.modelWeights,rule=asset.definition.quantization,issues:string[]=[];
  if(model.kind!=='model'||!rule.weight||rule.activation||rule.state||rule.preset||rule.storageIds||rule.importOrigin||
    rule.selector.kind!=='subtree'||rule.selector.rootNodeId!=='$model')issues.push('发布权重预设须绑定固定模型和整个模型的 weight 规则');
  const modules=new Set<string>();
  for(const section of moduleRules){
    const key=section.module.assetId+'@'+section.module.revision;
    if(section.module.kind!=='module'||modules.has(key))issues.push('发布权重模块来源重复或类型错误 '+key);
    modules.add(key);
    const module=library.find(value=>value.assetId===section.module.assetId&&value.revision===section.module.revision);
    if(module?.definition.kind!=='module')continue;
    const graph=module.definition.graph,ids=new Set<string>();
    for(const target of section.targets){
      const storage=graph.storages.find(value=>value.storageId===target.storageId),spec=target.specification??rule.weight;
      if(ids.has(target.storageId)||storage?.category!=='weight'||storage.allocation.kind!=='tensor'||!spec){
        issues.push('发布权重目标须为模块内唯一的实际权重 '+key+'/'+target.storageId);continue;
      }
      ids.add(target.storageId);
      if(target.specification)issues.push(...quantizationRuleIssues({...rule,weight:target.specification},library).map(issue=>issue.message));
      const shape=new Set(storage.allocation.shape.map(axis=>axis.axisId));
      for(const {count} of spec.auxiliaries){
        const axes=count.kind==='block'?count.axes.map(axis=>axis.axisId):count.kind==='channel'?[count.axisId]:[];
        const mapped=axes.map(axis=>target.axes&&Object.hasOwn(target.axes,axis)?target.axes[axis]??axis:axis);
        if(new Set(mapped).size!==mapped.length||mapped.some(axis=>!shape.has(axis)))issues.push('发布权重的缩放轴与物理矩阵不符 '+key+'/'+target.storageId);
      }
    }
  }
  return issues;
}

export function quantizationRuleIssues(rule:Scenario['quantizationOverrides'][number],assets:AssetDocument[],model?:Scenario['model']):{code:string;message:string;path:string}[]{
  const issues:{code:string;message:string;path:string}[]=[],report=(code:string,message:string,path:string)=>issues.push({code,message,path});
  if(!rule.weight&&!rule.activation&&!rule.state)report('empty_quantization','至少声明 weight/activation/state 一项','');
  if(rule.selector.kind==='nodes'&&new Set(rule.selector.nodeIds).size!==rule.selector.nodeIds.length)report('duplicate_id','量化选择器节点重复','selector');
  if(rule.storageIds&&new Set(rule.storageIds).size!==rule.storageIds.length)report('duplicate_id','精确量化规范存储目标重复','storageIds');
  if(rule.importOrigin&&(!rule.storageIds||rule.storageIds.length!==1))report('invalid_quantization_import','导入规则必须绑定一个明确的规范存储','importOrigin');
  if(rule.importOrigin){const o=rule.importOrigin;if(o.sourceId!=='ascend:'+o.sourceHash||!o.note.trim()||['weight','activation','state'].filter(k=>rule[k as 'weight'|'activation'|'state']).length!==1)report('invalid_quantization_import','导入来源身份、说明或单一存储类别无效','importOrigin');}
  if(rule.preset){
    const ref=rule.preset,preset=assets.find(a=>a.assetId===ref.assetId&&a.revision===ref.revision);
    if(ref.kind!=='quantization'||preset?.definition.kind!=='quantization')report('reference_kind_mismatch','量化预设必须引用固定 quantization 修订','preset');
    else {
      const profile=preset.definition.modelWeights;
      if(profile&&(rule.selector.kind!=='subtree'||rule.selector.rootNodeId!=='$model'||rule.storageIds||rule.importOrigin))report('invalid_model_weight_profile','发布权重预设须应用到整个模型','selector');
      if(profile&&model&&(model.assetId!==profile.model.assetId||model.revision!==profile.model.revision))report('incompatible_model_weight_profile','发布权重预设只适用于 '+profile.model.assetId+' r'+profile.model.revision,'preset');
      for(const category of ['weight','activation','state'] as const)if(canonical(rule[category]??null)!==canonical(preset.definition.quantization[category]??null))report('quantization_preset_mismatch','量化数据与预设修订不同；自定义编辑需移除 preset 来源',category);
    }
  }
  function expression(value:ValueExpr,unit:Quantity['unit'],path:string,integer:boolean){if(value.kind==='symbol')return;if(value.kind==='literal'){if(value.quantity.unit!==unit)report('invalid_unit','量化数量表达式单位不符',path);if(value.quantity.value<0||(integer&&!Number.isSafeInteger(value.quantity.value)))report('invalid_shape','量化数量必须为非负安全整数',path);return;}const ref=value.call.formula,target=assets.find(a=>a.assetId===ref.assetId&&a.revision===ref.revision);if(ref.kind!=='formula'||target?.definition.kind!=='formula'){report('reference_kind_mismatch','量化数量必须引用公式修订',path);return;}const f=target.definition.formula;if(f.output.unit!==unit)report('invalid_unit','量化数量公式输出单位不符',path);for(const key of Object.keys(value.call.bindings))if(!Object.hasOwn(f.inputs,key))report('unbound_symbol','公式未声明输入 '+key,path);for(const [key,input] of Object.entries(f.inputs)){const binding=value.call.bindings[key];if(!binding)report('unbound_symbol','公式缺少输入 '+key,path);else expression(binding,input.unit,path+'.'+key,input.integerRequired);}}
  for(const category of ['weight','activation','state'] as const){const spec=rule[category];if(!spec)continue;if(spec.payloadDtype&&spec.payloadDtype.bits!==spec.payloadBits)report('invalid_quantization','存储格式位宽与 payloadBits 不一致',category+'.payloadDtype');if(new Set(spec.auxiliaries.map(a=>a.name)).size!==spec.auxiliaries.length)report('duplicate_id','量化辅助项名称重复',category+'.auxiliaries');for(const [index,a] of spec.auxiliaries.entries()){if(a.count.kind==='formula')expression(a.count.value,'count',category+'.auxiliaries.'+index+'.count',true);if(a.count.kind==='block'&&new Set(a.count.axes.map(v=>v.axisId)).size!==a.count.axes.length)report('duplicate_id','量化 block 轴重复',category+'.auxiliaries.'+index+'.count');}}
  return issues;
}
