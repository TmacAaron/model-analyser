import type {CostDefinition,HardwareDefinition,MetricValue} from '@model-analyser/contracts';
type ComputeClass=CostDefinition['compute'][number]['computeClass'];
/** Internal evaluator observations carry semantic roles, never value-based joins. */
export type CostDurationOrigin=
 |{kind:'compute';evaluationIndex:number;segmentId:string|undefined;computeClass:ComputeClass;capabilityIndex:number|undefined;capabilityKind:'peak'|'effective'}
 |{kind:'memory';capabilityIndex:number|undefined;capabilityKind:'peak'|'effective'};
export type CostObservation=
 |{kind:'error';code:string;message:string}
 |{kind:'compute_capability';segmentId:string|undefined;computeClass:ComputeClass;matchingCount:number;matches:HardwareDefinition['computeCapabilities'];declaredEfficiency:number}
 |{kind:'memory_capability';key:'hbm';matchingCount:number;matches:HardwareDefinition['memoryCapabilities'];declaredEfficiency:number}
 |{kind:'duration';origin:CostDurationOrigin|undefined;work:number;peak:number;efficiency:number;method:'zero'|'division'|'log_fallback';seconds:number;denominator?:number;direct?:number}
 |{kind:'log_fallback';origin:CostDurationOrigin|undefined;logWork:number;logPeak:number;logEfficiency:number;firstDifference:number;logSeconds:number;seconds:number}
 |{kind:'sum_step';field:'compute_seconds';index:number;left:number;right:number;value:number}
 |{kind:'sum_complete';field:'compute_seconds';value:number;count:number}
 |{kind:'overlap';operation:'max'|'sum';computeSeconds:number;memorySeconds:number;value:number}
 |{kind:'launch';operation:'add';combined:number;launchSeconds:number;seconds:number};
export type CostObserver=(event:CostObservation)=>void;
export type CostTermObserver={
 access?:(index:number,logical:MetricValue,hbm:MetricValue)=>void;
 compute?:(index:number,useful:MetricValue,executed:MetricValue)=>void;
};
