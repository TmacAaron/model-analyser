import type {ParameterObserver,ParameterObservation} from './parameter-observation.js';
import { type AssetDocument,type Scenario,type Quantity,type ResolvedParameter,type GraphTemplate } from '@model-analyser/contracts';
import { FormulaError,evaluateValue } from './formula.js';

type Bindings=Extract<GraphTemplate['nodes'][number]['body'],{kind:'operator'}>['bindings'];
export function bindParameters(asset:AssetDocument,bindings:Bindings,parent:Record<string,Quantity>,assets:AssetDocument[],scenario:Scenario,nodeId:ResolvedParameter['nodeId'],root=false,observe?:ParameterObserver):{symbols:Record<string,Quantity>;parameters:ResolvedParameter[]} {
  if(new Set(bindings.map(b=>b.parameterKey)).size!==bindings.length)throw new FormulaError('duplicate_id','参数绑定重复');
  for(const b of bindings)if(!asset.parameters.some(p=>p.key===b.parameterKey))throw new FormulaError('unbound_symbol',`目标未声明参数 ${b.parameterKey}`);
  let emit:((event:ParameterObservation)=>void)|undefined=observe?event=>{if(observe(structuredClone(event))===false)emit=undefined;}:undefined;
  const symbols:Record<string,Quantity>={},parameters:ResolvedParameter[]=[];
  for(const p of asset.parameters){
    let value=p.default;
    let source:ResolvedParameter['source']={kind:'asset_default',asset:{assetId:asset.assetId,revision:asset.revision,kind:asset.definition.kind}};
    const imported=asset.configImport?.status==='confirmed'?asset.configImport.resolutions.find(r=>r.parameterKey===p.key):undefined,rule=asset.configImport?.profile.parameters.find(r=>r.parameterKey===p.key);
    if(imported&&rule&&asset.configImport)source={kind:'config_import',asset:{assetId:asset.assetId,revision:asset.revision,kind:asset.definition.kind},sourceName:asset.configImport.sourceName,field:rule.field,origin:imported.origin};
    emit?.({kind:'default',nodeId,parameterKey:p.key,value,source});
    const workloadBinding=root&&asset.definition.kind==='model'?asset.definition.workloadBindings?.filter(b=>b.phase===scenario.workload.kind&&b.parameterKey===p.key):undefined;if(workloadBinding&&workloadBinding.length>1)throw new FormulaError('duplicate_id','模型工作负载绑定重复 '+p.key);
    const explicitBinding=bindings.find(b=>b.parameterKey===p.key),binding=explicitBinding??workloadBinding?.[0];
    if(binding){
      if(['literal','symbol','formula'].includes(binding.value.kind)){
        if(p.type!=='integer'&&p.type!=='number')throw new FormulaError('invalid_parameter',`${p.key} 不接受数值表达式`);
        const expression=binding.value;if(expression.kind!=='literal'&&expression.kind!=='symbol'&&expression.kind!=='formula')throw new FormulaError('invalid_parameter','绑定类型错误');
        const quantity=evaluateValue(expression,parent,assets);if(quantity.unit!==p.unit)throw new FormulaError('invalid_unit',`${p.key} 需要 ${p.unit}，收到 ${quantity.unit}`);
        value=p.type==='integer'?{kind:'integer',value:quantity.value}:{kind:'number',value:quantity.value};
      }else {const literal=binding.value;if(literal.kind==='literal'||literal.kind==='symbol'||literal.kind==='formula')throw new FormulaError('invalid_parameter','绑定类型错误');value=literal;}
      source=root&&!explicitBinding?{kind:'asset_workload_binding',asset:{assetId:asset.assetId,revision:asset.revision,kind:asset.definition.kind},phase:scenario.workload.kind}:root?{kind:'scenario_override',scenarioId:scenario.scenarioId}:{kind:'node_override',nodeId};
      emit?.({kind:'binding',nodeId,parameterKey:p.key,origin:explicitBinding?'explicit':'asset_workload',expression:binding.value,value,source});
    }
    const overrides=scenario.numericOverrides.filter(o=>o.field==='parameter'&&o.parameterKey===p.key&&((root&&(o.target.kind==='project'||(o.target.kind==='scenario'&&o.target.scenarioId===scenario.scenarioId)))||(o.target.kind==='node'&&o.target.nodeId===nodeId)));
    const priorities={project:0,scenario:1,node:2,storage:3,device:4};overrides.sort((a,b)=>priorities[a.target.kind]-priorities[b.target.kind]);
    const seen=new Set<string>();
    for(const o of overrides){if(seen.has(o.target.kind))throw new FormulaError('invalid_override',`同一参数同优先级覆盖冲突 ${p.key}`);seen.add(o.target.kind);
      if((p.type!=='integer'&&p.type!=='number')||o.value.unit!==p.unit)throw new FormulaError('invalid_unit',`${p.key} 覆盖类型/单位不符`);
      if(o.target.kind==='project'&&(p.default!==undefined||binding!==undefined)){emit?.({kind:'override',nodeId,parameterKey:p.key,overrideIndex:scenario.numericOverrides.indexOf(o),override:o,action:'skipped_existing_default_or_binding'});continue;}
      value=p.type==='integer'?{kind:'integer',value:o.value.value}:{kind:'number',value:o.value.value};
      source=o.target.kind==='project'?{kind:'project_default',scenarioId:scenario.scenarioId}:o.target.kind==='node'?{kind:'node_override',nodeId}:{kind:'scenario_override',scenarioId:scenario.scenarioId};
      emit?.({kind:'override',nodeId,parameterKey:p.key,overrideIndex:scenario.numericOverrides.indexOf(o),override:o,action:'applied',value,source});
    }
    if(!value)throw new FormulaError('unbound_symbol',`缺少必需参数 ${p.key}`);
    if(value.kind!==p.type)throw new FormulaError('invalid_parameter',`${p.key} 参数类型不一致`);
    if(p.type==='integer'||p.type==='number'){
      if(value.kind!=='integer'&&value.kind!=='number')throw new FormulaError('invalid_parameter','数值参数类型错误');
      if(!Number.isFinite(value.value)||(p.type==='integer'&&!Number.isSafeInteger(value.value))||(p.min!==undefined&&value.value<p.min)||(p.max!==undefined&&value.value>p.max))throw new FormulaError('invalid_parameter',`${p.key} 数值超出范围`);
      symbols[p.key]={value:value.value,unit:p.unit};
    }else if(p.type==='enum'&&(value.kind!=='enum'||!p.choices.includes(value.value)))throw new FormulaError('invalid_parameter',`${p.key} 不在枚举选项中`);
    emit?.({kind:'final',nodeId,parameterKey:p.key,value,unit:p.unit,source});
    parameters.push({nodeId,parameterKey:p.key,value,unit:p.unit,source});
  }
  return {symbols,parameters};
}
