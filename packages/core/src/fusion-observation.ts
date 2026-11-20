import type {CostDefinition,DeviceId,NodeId,Quantity,StorageId} from '@model-analyser/contracts';
import type {LocalPlanObserver} from './local-cost-observation.js';
import type {TimingDag} from './timing-dag.js';
import type {LogicalExtraOperand} from './logical-work-observation.js';

type RemovedResource={nodeId:NodeId;definition:'global'|'local';storageId:StorageId;canonicalStorageId:StorageId}&(
 {kind:'access';accessId:string;mode:CostDefinition['memoryAccess'][number]['mode']}
 |{kind:'temporary'}
);

export type FusionDeclaration={symbols:Record<string,Quantity>;extraLocalSymbols?:Record<string,Quantity>;removed:RemovedResource[]};
export type FusionDeclarationObserver={nodeId:NodeId;record:(evidence:FusionDeclaration)=>void};

export type FusionPlanObserver={fusion:{
 nodeId:NodeId;
 declaration?:(evidence:FusionDeclaration)=>void;
 timing?:{deviceId:DeviceId;record:(dag:TimingDag)=>void};
 extra?:LocalPlanObserver['localCost'];
 logicalExtra?:(term:LogicalExtraOperand)=>void;
}};
