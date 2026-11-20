import { MemoryPeak,type MemoryPeakOverride,type ResolvedGraph,type Scenario,type AssetDocument,type Diagnostic } from '@model-analyser/contracts';
import { fusionSymbols } from './fusion.js';
import { numericValue } from './storage.js';
import { MetricFactory } from './metrics.js';
import { FormulaError } from './formula.js';
import { collectRefs } from '../../contracts/src/validation.js';

/** Total overrides never change allocations, traffic, cost equations or the theoretical estimate. */
export function applyTotalPeakOverrides(memory:MemoryPeak[],resolved:ResolvedGraph,scenario:Scenario,assets:AssetDocument[],diagnostics:Diagnostic[]):MemoryPeak[]{
  const rules:MemoryPeakOverride[]=[...(scenario.memoryPeakOverrides??[])];
  for(const o of scenario.numericOverrides)if(o.target.kind==='device'&&o.field==='memory_bytes')rules.push({overrideId:'legacy-device:'+o.target.deviceId,phases:['prefill','decode'],target:o.target,peakBytes:{kind:'literal',quantity:o.value},description:o.description?.trim()||'Explicit legacy device memory_bytes override'});
  const active=rules.filter(r=>r.phases.includes(scenario.workload.kind));if(!active.length)return memory;
  if(new Set(active.map(r=>r.overrideId)).size!==active.length)throw new FormulaError('invalid_peak_override','显存峰值覆盖 ID 重复');
  const symbols=fusionSymbols(resolved,scenario,'$model' as ResolvedGraph['containers'][number]['nodeId']);
  const evaluated=active.map(rule=>{const t=rule.target,deviceIds=t.kind==='device'?[t.deviceId]:scenario.deviceTopology.groups.find(g=>g.groupId===t.groupId)?.members;
    if(!deviceIds?.length||deviceIds.some(id=>!scenario.deviceTopology.devices.some(d=>d.deviceId===id)))throw new FormulaError('missing_reference','峰值覆盖目标设备/组不存在');
    return {rule,deviceIds,evaluatedBytes:numericValue(rule.peakBytes,'byte',{symbols,assets},true)};
  });
  return memory.map(row=>{
    if(row.deviceScope.kind!=='per_device')throw new FormulaError('invalid_scope','总峰值覆盖要求逐物理设备结果');const id=row.deviceScope.deviceId,matching=evaluated.filter(e=>e.deviceIds.includes(id));if(!matching.length)return row;
    const specific=matching.filter(e=>e.rule.target.kind==='device'),choices=specific.length?specific:matching;if(choices.length!==1)throw new FormulaError('conflicting_peak_override','同一物理设备存在同优先级峰值覆盖；请移除重叠规则');const chosen=choices[0];if(!chosen)throw Error('Missing peak override');
    const metrics=new MetricFactory(diagnostics,{assetRefs:assets.map(a=>({assetId:a.assetId,revision:a.revision,kind:a.definition.kind})),formulaRefs:collectRefs(chosen.rule.peakBytes),parameterSources:resolved.parameters.filter(p=>p.nodeId==='$model').map(p=>({parameterKey:p.parameterKey,source:p.source.kind})),assumptions:[
      'User total-peak override per physical device. This replaces the entire peak, including weights, state and shared objects; it does not change their theoretical allocations.',
      'Category decomposition and peak location are unknown. A group value is per member, never the group sum. A device rule takes priority over group rules.',chosen.rule.description,
    ]},scenario.scenarioId,'peak-override-'+id);
    if(chosen.evaluatedBytes>row.capacityBytes)metrics.unavailable('override_capacity_exceeded','用户总峰值覆盖超过物理设备容量');
    const theoretical=row.totalOverride?.theoretical??row;if(theoretical.peakPoint.kind==='unlocated')throw new FormulaError('invalid_peak_override','覆盖不能覆盖另一份缺失理论值的覆盖');
    return MemoryPeak.parse({...row,categoryBreakdown:[],peakBytes:metrics.available(chosen.evaluatedBytes,'byte','estimated'),peakPoint:{kind:'unlocated',overrideId:chosen.rule.overrideId},capacityStatus:{kind:'point_only',description:'User total-peak override; decomposition and location unknown. Capacity search reevaluates this value at every candidate.'},totalOverride:{...chosen,shadowedOverrideIds:matching.filter(e=>e!==chosen).map(e=>e.rule.overrideId),classification:'unknown',theoretical}});
  });
}
