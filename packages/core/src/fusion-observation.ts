import type {CostDefinition,DeviceId,NodeId,Quantity,StorageId} from '@model-analyser/contracts';
import type {LocalPlanObserver} from './local-cost-observation.js';
import type {TimingDag} from './timing-dag.js';
import type {LogicalExtraOperand} from './logical-work-observation.js';
import type {ParameterCaptureTrace} from './parameter-observation.js';

type RemovedResource={nodeId:NodeId;definition:'global'|'local';storageId:StorageId;canonicalStorageId:StorageId}&(
 {kind:'access';accessId:string;mode:CostDefinition['memoryAccess'][number]['mode']}
 |{kind:'temporary'}
);

export type FusionDeclaration={symbols:Record<string,Quantity>;extraLocalSymbols?:Record<string,Quantity>;removed:RemovedResource[];
 parameterFrames?:{root:Record<string,string>;extraLocal?:Record<string,string>}};
export type FusionDeclarationObserver={nodeId:NodeId;record:(evidence:FusionDeclaration)=>void;bindings?:true};

export type FusionPlanObserver={fusion:{
 nodeId:NodeId;
 declaration?:(evidence:FusionDeclaration)=>void;
 bindings?:(trace:ParameterCaptureTrace)=>void;
 timing?:{deviceId:DeviceId;record:(dag:TimingDag)=>void};
 extra?:LocalPlanObserver['localCost'];
 logicalExtra?:(term:LogicalExtraOperand)=>void;
}};
