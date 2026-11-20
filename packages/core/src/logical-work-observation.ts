import type {CostDefinition,CostResult,MetricValue,NodeId} from '@model-analyser/contracts';
import type {LocalCostDeclaration} from './local-cost-observation.js';
import type {FusionPlanObserver} from './fusion-observation.js';

export type LogicalTerm={index:number;segmentId:string;computeClass:CostResult['compute'][number]['computeClass'];usefulOperations:MetricValue;executedOperations:MetricValue};
export type LogicalLeafObserver={nodeId:NodeId;declaration:(record:LocalCostDeclaration)=>void;term:(record:LogicalTerm)=>void};
export type AnalysisObserver=FusionPlanObserver|{logicalLeaf:LogicalLeafObserver};

export function logicalDeclarationObserver(observer?:LogicalLeafObserver){
 if(!observer)return;
 return {nodeId:observer.nodeId,bindings:true,declaration:(record:LocalCostDeclaration,kind:'global'|'local')=>{
  if(kind==='global')observer.declaration(record);
 }};
}

export type LogicalExtraOperand={
 segmentId:string;
 field:'usefulOperations'|'executedOperations';
 computeClass:CostDefinition['compute'][number]['computeClass'];
 metric:MetricValue;
};
