import type {AssetDocument,AssetRef,ResolvedParameter,Scenario,Quantity} from '@model-analyser/contracts';
export type ParameterBindingValue=Scenario['bindings'][number]['value'];
type Base={nodeId:ResolvedParameter['nodeId'];parameterKey:string};
export type ParameterObservation=
 |Base&{kind:'default';value:ResolvedParameter['value']|undefined;source:ResolvedParameter['source']}
 |Base&{kind:'binding';origin:'explicit'|'asset_workload';expression:ParameterBindingValue;value:ResolvedParameter['value'];source:ResolvedParameter['source']}
 |Base&{kind:'override';overrideIndex:number;override:Scenario['numericOverrides'][number];action:'skipped_existing_default_or_binding'}
 |Base&{kind:'override';overrideIndex:number;override:Scenario['numericOverrides'][number];action:'applied';value:ResolvedParameter['value'];source:ResolvedParameter['source']}
 |Base&{kind:'final';value:ResolvedParameter['value'];unit:Quantity['unit'];source:ResolvedParameter['source']};
/** Return false to stop recording this frame; ordinary binding still finishes. */
export type ParameterObserver=(event:ParameterObservation)=>void|boolean;
export type ParameterFrame={id:string;nodeId:string;kind:'workload'|'asset'|'repeat';parent?:string;asset?:AssetRef;name?:string;axis?:string;index?:number;symbols:Record<string,Quantity>;events:ParameterObservation[]};
export type ParameterCaptureTrace={frames:ParameterFrame[];truncated:boolean};
export const assetParameterFrameId=(nodeId:string)=>JSON.stringify(['asset',nodeId]);
export const workloadParameterFrameId=()=>JSON.stringify(['workload']);
