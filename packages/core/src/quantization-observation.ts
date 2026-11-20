import type {ResolvedGraph,StorageSpec,Scenario,NodeId,StorageId} from '@model-analyser/contracts';
import type {SymbolAssignment} from './evaluation-scope.js';import type {AllocationObservation,allocateStorage} from './storage.js';
import {jsonBytes} from '../../contracts/src/json-size.js';
type Specification=ResolvedGraph['quantizationApplications'][number]['specification'];
export type QuantizationObservation=
 |{kind:'scope_assignment';storageId:StorageId;nodeId:NodeId;ruleIndex:number;assignment:SymbolAssignment}
 |{kind:'specification_bound';storageId:StorageId;nodeId:NodeId;ruleIndex:number;raw:Specification;specification:Specification}
 |{kind:'rule_decision';storageId:StorageId;nodeId:NodeId;winners:{ruleIndex:number;priority:number}[];losers:{ruleIndex:number;priority:number}[];specification?:Specification}
 |{kind:'allocation_operation';storageId:StorageId;phase:'before'|'after';event:AllocationObservation}
 |{kind:'storage_before';storageId:StorageId;storage:StorageSpec;allocation:ReturnType<typeof allocateStorage>}
 |{kind:'storage_applied';storageId:StorageId;storage:StorageSpec;application:ResolvedGraph['quantizationApplications'][number];allocation:ReturnType<typeof allocateStorage>};
export type QuantizationObserver={storageIds:ReadonlySet<string>;record:(event:QuantizationObservation)=>void|boolean;truncated?:()=>void};
/** Budget before cloning; callers receive detached data and cannot mutate execution. */
export function quantizationEmitter(observer:QuantizationObserver|undefined){
 if(!observer)return undefined;let count=0,bytes=0,active=true;
 return(event:QuantizationObservation)=>{if(!active)return;try{if(count>=1024)throw Error('budget');bytes+=jsonBytes(event,16*1024*1024-bytes);}catch{active=false;observer.truncated?.();return;}count++;if(observer.record(structuredClone(event))===false){active=false;observer.truncated?.();}};
}
export type StorageOverrideObservation={storageId:StorageId;overrideIndex:number;override:Scenario['numericOverrides'][number];before:StorageSpec['allocation'];after:StorageSpec['allocation']};
