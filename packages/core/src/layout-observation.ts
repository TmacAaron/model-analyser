import type {AssetRef,DeviceId,DeviceTopology,NodeId,ParallelResolution,Quantity,ResolvedGraph,Scenario,StorageId,StorageSpec,TensorDistribution,TensorId,TensorSpec} from '@model-analyser/contracts';
import type {QuantizationObserver,StorageOverrideObservation} from './quantization-observation.js';

export type PartitionOperation=
 |{kind:'axis';axisId:string;method:'whole'|'manual'|'explicit'|'even'|'padded';logical:number;allocated:number;extent?:number;start?:number;end?:number;mesh?:{axisId:string;width:number;rank:number}}
 |{kind:'elements';scope:'global'|'logical'|'allocated';dimensions:number[];value:number;emptyAxis?:number;products?:number[]}
 |{kind:'explicit_coverage';rectangles:number;covered:number;globalElements:number};
export type PartitionObserver={deviceId:DeviceId;record:(operation:PartitionOperation)=>void};

export type LayoutTarget={kind:'tensor';nodeId:NodeId;tensorId:TensorId;deviceId:DeviceId}|{kind:'storage';storageId:StorageId;deviceId:DeviceId};
export type LayoutDeclaration={
 asset:AssetRef;nodeId:NodeId;symbols:Record<string,Quantity>;
 object:{kind:'tensor';tensor:TensorSpec}|{kind:'storage';storage:StorageSpec};
};
export type LayoutObjectObserver={target:LayoutTarget;record:(declaration:LayoutDeclaration)=>void};

export type LayoutRuleEvidence={
 kind:'tensor'|'storage';nodeId:NodeId;objectId:string;ownerNodeId:NodeId;
 index:number;entryIndex:number;priority:number;originalId:string;selector:Scenario['parallelPlan']['assignments'][number]['selector'];
 declared:TensorDistribution;effective:TensorDistribution;axisMap:Record<string,string>;status:'selected'|'equivalent'|'overridden';
};
export type StorageLayoutOrigin={
 kind:'explicit_storage'|'inferred_from_tensor'|'verified_backing';nodeId:NodeId;objectId:string;distribution:TensorDistribution;indices:number[];
 capacity?:{requiredBytes:number;backingBytes:number};
};
type RecipeBase={topology:DeviceTopology;symbols:Record<string,Quantity>;rules:LayoutRuleEvidence[];syntheticBaseline:boolean};
export type LayoutRecipe=RecipeBase&(
 {kind:'tensor';tensor:TensorSpec;row:ParallelResolution['tensorLayouts'][number]}
 |{kind:'storage';storage:StorageSpec;row:ParallelResolution['storageAllocations'][number];namespace:string;origins:StorageLayoutOrigin[];override?:StorageOverrideObservation;elidedBy?:NodeId;quantization?:ResolvedGraph['quantizationApplications'][number]}
);
export type LayoutPlanObserver={layout:{
 target:LayoutTarget;record:(recipe:LayoutRecipe)=>void;
 declaration?:(declaration:LayoutDeclaration)=>void;quantization?:QuantizationObserver;
}};
