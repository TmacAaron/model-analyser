import type {AssetRef,CommunicationDefinition,NodeId,Quantity,Scenario} from '@model-analyser/contracts';
import type {ParameterCaptureTrace} from './parameter-observation.js';

export type BoundCollectiveObservation={
 nodeId:NodeId;asset:AssetRef;authored:CommunicationDefinition;roleBound:CommunicationDefinition;symbols:Record<string,Quantity>;parameterFrameId?:string;
};

type Timing=CommunicationDefinition['timing'];
export type CommunicationTimingOverride={index:number;override:Scenario['numericOverrides'][number];before:Timing;after:Timing};

export type CommunicationTimingArithmetic=
 | {kind:'fixed'|'custom_formula';seconds:number}
 | {kind:'bandwidth_latency';maxTraffic:number;bytePerSecond:number;rounds:number;latencySeconds:number;transfer:number;startup:number;seconds:number};

export type CommunicationPlanObservation={
 index:number;nodeId?:NodeId;collective?:BoundCollectiveObservation;symbols:Record<string,Quantity>;planParameterKeys?:string[];
 overrides:CommunicationTimingOverride[];timing?:CommunicationTimingArithmetic;
};

export type CommunicationPlanObserver={
 index:number;nativeNodeId?:NodeId;record:(observation:CommunicationPlanObservation)=>void;
 bindings?:(trace:ParameterCaptureTrace)=>void;
};

/** Preserve actual evaluated values, including a declared prototype-like parameter key. */
export function communicationSymbols(symbols:Record<string,Quantity>){
 const entries=Object.entries(symbols),prototypeValue=symbols['__proto__'];
 if(!Object.hasOwn(symbols,'__proto__')&&typeof prototypeValue?.value==='number')entries.push(['__proto__',prototypeValue]);
 return Object.fromEntries(entries);
}
