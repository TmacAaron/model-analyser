import type {AssetRef,CostDefinition,DeviceId,LocalCostRule,LocalDeviceCost,MetricValue,NodeId,Quantity,Scenario} from '@model-analyser/contracts';
import type {TimingDag} from './timing-dag.js';

export type LocalCostDeclaration={asset:AssetRef;cost:CostDefinition;symbols:Record<string,Quantity>};
export type LocalCostTerms={
 access?:(index:number,logical:MetricValue,hbm:MetricValue)=>void;
};
export type LocalAccessTerm={logical:MetricValue;hbm:MetricValue};
type TrafficOperand={index:number;originalBytes:number;replacementBytes:number};
export type LocalCostOverride={
 index:number;override:Scenario['numericOverrides'][number];
 change:{kind:'timing';before:CostDefinition['timing'];after:CostDefinition['timing']}
 |{kind:'traffic';originalTotal:number;operands:TrafficOperand[]};
};
export type LocalCostObservation={
 rule:LocalCostRule|undefined;singleDeviceBaseline:boolean;devices:DeviceId[];
 outcome:Extract<LocalDeviceCost['outcome'],{status:'available'}>;effective:CostDefinition;
 symbols:Record<string,Quantity>;hardware:AssetRef;
 accesses:LocalAccessTerm[];overrides:LocalCostOverride[];timing?:TimingDag;
};
export type LocalPlanObserver={
 localCost:{nodeId:NodeId;deviceId:DeviceId;timing:boolean;record:(observation:LocalCostObservation)=>void};
 declaration?:(observation:LocalCostDeclaration,kind:'local'|'global')=>void;
};
