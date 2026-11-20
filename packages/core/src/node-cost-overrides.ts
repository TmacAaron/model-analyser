import type {CostDefinition, Scenario} from '@model-analyser/contracts';
import {memoryAccessBytes} from './cost.js';
import {FormulaError} from './formula.js';
import type {EvaluationContext} from './storage.js';

type Override = Scenario['numericOverrides'][number];
type Timing = CostDefinition['timing'];
export type NodeCostOverrideObservation = { overrideIndex:number; override:Override } & (
  | { kind:'timing'; before:Timing; after:Timing }
  | { kind:'traffic'; previousTotal:number }
);

/** Shared by serial analysis and fixed-input source replay. */
export function applyNodeCostOverride(cost:CostDefinition, override:Override, overrideIndex:number, context:EvaluationContext, observe?:(record:NodeCostOverrideObservation)=>void) {
  const before = observe ? structuredClone(cost.timing) : undefined;
  switch (override.field) {
    case 'fixed_seconds':
      cost.timing = {kind:'fixed',seconds:override.value.value,description:override.description??'Explicit scenario timing override'};
      break;
    case 'compute_efficiency':
    case 'memory_efficiency':
      if (cost.timing.kind !== 'roofline_bound') throw new FormulaError('invalid_override','效率覆盖需要 roofline_bound 耗时策略');
      if (override.field === 'compute_efficiency') cost.timing.computeEfficiency = override.value.value;
      else cost.timing.memoryEfficiency = override.value.value;
      break;
    case 'traffic_bytes': {
      const values = cost.memoryAccess.map(access => memoryAccessBytes(access,context));
      const previousTotal = values.reduce((sum,value) => sum+value,0);
      if (!Number.isFinite(previousTotal)||previousTotal<=0) throw new FormulaError('invalid_override','不能在未声明读写比例时拆分总流量覆盖');
      for (const [index,access] of cost.memoryAccess.entries()) {
        access.logicalBytes = {kind:'literal',quantity:{value:(values[index]??0)/previousTotal*override.value.value,unit:'byte'}};
      }
      observe?.(structuredClone({kind:'traffic',overrideIndex,override,previousTotal}));
      return;
    }
    default:
      throw new FormulaError('unsupported_override',`当前基线不支持 ${override.field} 成本覆盖`);
  }
  if (before) observe?.(structuredClone({kind:'timing',overrideIndex,override,before,after:cost.timing}));
}
