import type {CostDefinition,HardwareDefinition,MetricScope} from '@model-analyser/contracts';
import type {EvaluationContext} from './storage.js';
import {evaluateCost} from './cost.js';
import type {CostObservation,CostObserver} from './cost-observation.js';
import {timingDag} from './timing-dag.js';
import type {LocalCostTerms} from './local-cost-observation.js';
/** Observation budgets affect evidence only; the evaluator always finishes. */
export function observeCostTiming(cost:CostDefinition,scope:MetricScope,context:EvaluationContext,hardware:HardwareDefinition,maxNodes=256,terms?:LocalCostTerms){
 return observeTiming(emit=>evaluateCost(cost,scope,context,hardware,emit,terms),maxNodes);
}

export function observeTiming<T>(evaluate:(emit:CostObserver)=>T,maxNodes=256){
 if(!Number.isSafeInteger(maxNodes)||maxNodes<1||maxNodes>256)throw Error('耗时来源节点预算须为1至256');
 const events:CostObservation[]=[];let overflow=false;
 const evaluation=evaluate(event=>{if(events.length<512)events.push(event);else overflow=true;});
 const dag=timingDag(events,maxNodes);if(overflow){dag.completeTiming=false;dag.truncated=true;}
 return {evaluation,dag};
}
