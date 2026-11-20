import type { Scenario,AssetDocument,ResolvedGraph } from '@model-analyser/contracts';

export function modelAssumptions(scenario:Scenario,assets:AssetDocument[]):string[]{const model=assets.find(a=>a.assetId===scenario.model.assetId&&a.revision===scenario.model.revision);return model?.definition.kind==='model'?model.definition.assumptions??[]:[];}
/** Parameter provenance follows lexical ancestors; aggregates also include descendants. */
export function targetParameterSources(resolved:ResolvedGraph,target:string,aggregate=false){
  const inside=(parent:string,child:string)=>parent===child||child.startsWith(parent+'/')||child.startsWith(parent+'[');
  return resolved.parameters.filter(p=>p.nodeId==='$model'||inside(p.nodeId,target)||aggregate&&inside(target,p.nodeId)).map(p=>({parameterKey:p.nodeId+':'+p.parameterKey,source:p.source.kind}));
}
