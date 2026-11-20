import {PROJECT_TEXT_BYTES} from './project-limits.js';
import { z } from 'zod';

export const Id = z.string().min(1);
export const AssetId = Id.brand<'AssetId'>();
export const NodeId = Id.brand<'NodeId'>();
export const TensorId = Id.brand<'TensorId'>();
export const StorageId = Id.brand<'StorageId'>();
export const StateId = Id.brand<'StateId'>();
export const DeviceId = Id.brand<'DeviceId'>();
export const Natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const PositiveInt = Natural.min(1);
export const NonNegative = z.number().nonnegative();
export const Unit = z.enum(['scalar','count','ratio','byte','second','operation','operation_per_second','byte_per_second']);
export const Quantity = z.strictObject({ value: z.number(), unit: Unit });
export const AssetKind = z.enum(['model','module','operator','formula','parallel','quantization','hardware']);
export const Phase = z.enum(['prefill','decode']);
export const Phases = z.array(Phase).min(1);
export const AssetRef = z.strictObject({assetId: AssetId, revision: PositiveInt, kind: AssetKind});
export const ValueExpr = z.discriminatedUnion('kind', [
  z.strictObject({kind:z.literal('literal'), quantity:Quantity}),
  z.strictObject({kind:z.literal('symbol'), name:Id}),
  z.strictObject({kind:z.literal('formula'), get call() { return z.strictObject({formula:AssetRef, bindings:z.record(Id, ValueExpr)}); }}),
]);
export const ParameterValue = z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('integer'),value:z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)}),
  z.strictObject({kind:z.literal('number'),value:z.number()}),
  z.strictObject({kind:z.literal('boolean'),value:z.boolean()}),
  z.strictObject({kind:z.literal('enum'),value:Id}),
]);
const param = {key:Id,name:Id,description:z.string().optional()};
export const ParameterDef = z.discriminatedUnion('type',[
  z.strictObject({...param,type:z.literal('integer'),unit:Unit,min:z.number().int().optional(),max:z.number().int().optional(),default:ParameterValue.options[0].optional()}),
  z.strictObject({...param,type:z.literal('number'),unit:Unit,min:z.number().optional(),max:z.number().optional(),default:ParameterValue.options[1].optional()}),
  z.strictObject({...param,type:z.literal('boolean'),unit:z.literal('scalar'),default:ParameterValue.options[2].optional()}),
  z.strictObject({...param,type:z.literal('enum'),unit:z.literal('scalar'),choices:z.array(Id).min(1),default:ParameterValue.options[3].optional()}),
]);
export const ParameterBinding = z.strictObject({parameterKey:Id,value:z.union([ParameterValue,ValueExpr])});
export const ConfigMappingProfile = z.strictObject({profileId:Id,modelTypes:z.array(Id),description:Id,
  parameters:z.array(z.strictObject({field:Id,parameterKey:Id,offset:z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),required:z.boolean()})),
  constraints:z.array(z.strictObject({field:Id,expected:z.json(),required:z.boolean(),description:Id})),
  ignoredFields:z.array(z.strictObject({field:Id,reason:Id})),assumptions:z.array(Id).min(1)});
export const ConfigSource = z.strictObject({sourceName:Id,format:z.enum(['json','yaml']),rawConfig:z.record(Id,z.json())});
export const DecodeConfigRequest = ConfigSource.pick({sourceName:true,format:true}).extend({text:z.string()});
export const ConfigImportSeed = ConfigSource.extend({documentType:z.literal('config_import_seed'),version:z.literal('config-import.1'),assetId:AssetId,name:z.string()});
export const ConfigImportMetadata = ConfigSource.extend({version:z.literal('config-import.1'),template:AssetRef,profile:ConfigMappingProfile,
  resolutions:z.array(z.strictObject({parameterKey:Id,value:ParameterValue,origin:z.enum(['config','manual'])})),
  decisions:z.array(z.strictObject({key:Id,note:Id})),status:z.enum(['review','confirmed'])});
export const ConfigImportIssue = z.strictObject({key:Id,field:Id,code:Id,message:Id,severity:z.enum(['error','review']),resolved:z.boolean()});
export const FormulaDefinition = z.strictObject({
  inputs:z.record(Id,z.strictObject({unit:Unit,integerRequired:z.boolean(),min:z.number().optional(),max:z.number().optional()})),
  expression:Id, output:z.strictObject({unit:Unit,integerRequired:z.boolean(),nonNegative:z.boolean()}),description:Id,
});
export const DTypeSpec = z.strictObject({category:z.enum(['float','int','uint','custom']),bits:PositiveInt,format:Id});
export const Shape = z.array(z.strictObject({axisId:Id,semantic:z.enum(['batch','token','head','hidden','expert','vocab','custom']),size:ValueExpr}));
export const QuantizedStorageSpec = z.strictObject({
  payloadBits:PositiveInt,packingUnitElements:PositiveInt,alignmentBytes:PositiveInt,
  auxiliaries:z.array(z.strictObject({name:Id,dtype:DTypeSpec,count:z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('formula'),value:ValueExpr}),
    z.strictObject({kind:z.literal('group'),groupSize:PositiveInt}),
    z.strictObject({kind:z.literal('tensor')}),
    z.strictObject({kind:z.literal('channel'),axisId:Id}),
    z.strictObject({kind:z.literal('block'),axes:z.array(z.strictObject({axisId:Id,blockSize:PositiveInt})).min(1)}),
  ])})),
});
export const StorageSpec = z.strictObject({storageId:StorageId,name:Id,
  category:z.enum(['weight','state','activation','workspace','communication','graph','runtime','reserve']),
  sharingDomain:z.enum(['request','instance','device_group']),allocation:z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('tensor'),shape:Shape,dtype:DTypeSpec,quantization:QuantizedStorageSpec.optional()}),
    z.strictObject({kind:z.literal('bytes'),value:ValueExpr}),
    z.strictObject({kind:z.literal('alias'),targetStorageId:StorageId}),
  ]),
});
export const TensorSpec = z.strictObject({tensorId:TensorId,name:Id,shape:Shape,dtype:DTypeSpec,storageId:StorageId});
export const PortSpec = z.strictObject({portId:Id,tensorId:TensorId});
export const NodePort = z.strictObject({kind:z.literal('node'),nodeId:NodeId,portId:Id});
export const Endpoint = z.discriminatedUnion('kind',[
  NodePort,z.strictObject({kind:z.literal('graph_input'),portId:Id}),z.strictObject({kind:z.literal('graph_output'),portId:Id}),
]);
export const StateSpec = z.strictObject({stateId:StateId,name:Id,stateKind:z.enum(['kv','latent','indexer','indices','recurrent','window','custom']),
  allocationBasis:z.enum(['context_boundary','step_end']).optional(),
  storageIds:z.array(StorageId).min(1),creator:z.union([NodePort,z.strictObject({kind:z.literal('initialized')})]),readers:z.array(NodePort),writers:z.array(NodePort),
  updatePolicy:z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('append')}),z.strictObject({kind:z.literal('windowed'),window:ValueExpr}),
    z.strictObject({kind:z.literal('replace')}),z.strictObject({kind:z.literal('static')}),
  ]),
});
export const ComputeClass = z.strictObject({arithmetic:z.enum(['float','integer']),inputDtypes:z.array(DTypeSpec).min(1),multiplyDtype:DTypeSpec,accumulateDtype:DTypeSpec,
  resource:z.enum(['matrix','vector','custom']),resourceKey:Id.optional()});
export const Efficiency = z.number().gt(0).max(1);
export const TimingDefinition = z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('roofline_bound'),computeEfficiency:Efficiency,memoryEfficiency:Efficiency,computeMemoryOverlap:z.enum(['ideal','serial']),launchSeconds:NonNegative}),
  z.strictObject({kind:z.literal('custom_formula'),seconds:ValueExpr,description:Id}),
  z.strictObject({kind:z.literal('fixed'),seconds:NonNegative,description:Id}),
]);
export const CostDefinition = z.strictObject({
  compute:z.array(z.strictObject({segmentId:Id,computeClass:ComputeClass,usefulOperations:ValueExpr,executedOperations:ValueExpr})),
  memoryAccess:z.array(z.strictObject({accessId:Id,storageId:StorageId,mode:z.enum(['read','write']),logicalBytes:z.union([ValueExpr,z.strictObject({kind:z.literal('storage_allocation'),passes:ValueExpr})]),
    hbmEstimate:z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('factor'),value:NonNegative}),z.strictObject({kind:z.literal('bytes'),value:ValueExpr})]).optional()})),
  temporaryStorageIds:z.array(StorageId),timing:TimingDefinition,
});
export const LocalCostSource = z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('tensor_axis'),tensorId:TensorId,axisId:Id,basis:z.enum(['logical','allocated'])}),
  z.strictObject({kind:z.literal('tensor_slice'),tensorId:TensorId,axisId:Id,edge:z.enum(['start','end'])}),
  z.strictObject({kind:z.literal('tensor_elements'),tensorId:TensorId,basis:z.enum(['logical','allocated'])}),
  z.strictObject({kind:z.literal('tensor_copies'),tensorId:TensorId}),
  z.strictObject({kind:z.literal('storage_bytes'),storageId:StorageId,basis:z.enum(['per_copy','all_copies'])}),
]);
export const LocalCostRule = z.strictObject({participation:z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('tensor_layout'),tensorId:TensorId}),z.strictObject({kind:z.literal('storage_layout'),storageId:StorageId}),
]),bindings:z.array(z.strictObject({symbol:z.string().regex(/^[A-Za-z_][A-Za-z_0-9]*$/),source:LocalCostSource})),cost:CostDefinition,description:Id});
export const TensorDistribution = z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('replicated'),groupId:Id}),
  z.strictObject({kind:z.literal('partial'),groupId:Id,reduceOperation:z.enum(['sum','max','min'])}),
  z.strictObject({kind:z.literal('sharded'),groupId:Id,axes:z.array(z.strictObject({tensorAxisId:Id,meshAxisId:Id})).min(1),
    policy:z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('even')}),z.strictObject({kind:z.literal('padded')}),
      z.strictObject({kind:z.literal('explicit'),slices:z.array(z.strictObject({deviceId:DeviceId,axisId:Id,start:Natural,end:Natural}))})])}),
  z.strictObject({kind:z.literal('manual'),groupId:Id,members:z.array(z.strictObject({deviceId:DeviceId,localShape:Shape,copies:PositiveInt})),description:Id}),
]);
export const CommunicationMemberPayload = z.strictObject({deviceId:DeviceId,sendBytes:ValueExpr,receiveBytes:ValueExpr,trafficFactor:NonNegative});
export const CommunicationDefinition = z.strictObject({operation:z.enum(['all_reduce','all_gather','reduce_scatter','all_to_all','send_recv']),groupId:Id,
  source:z.strictObject({tensorId:TensorId,distribution:TensorDistribution}),destination:z.strictObject({tensorId:TensorId,distribution:TensorDistribution}),
  sourceDeviceId:DeviceId.optional(),destinationDeviceId:DeviceId.optional(),payloadDtype:DTypeSpec,sendBytesPerMember:ValueExpr,receiveBytesPerMember:ValueExpr,
  algorithm:z.strictObject({name:Id,trafficFactor:NonNegative,startupRounds:Natural}),
  perDevicePayloads:z.array(CommunicationMemberPayload).min(1).optional(),
  timing:z.union([TimingDefinition.options[1],TimingDefinition.options[2],z.strictObject({kind:z.literal('bandwidth_latency'),bytePerSecond:z.number().positive(),latencySeconds:NonNegative})]),
  placement:z.strictObject({nodeId:NodeId,phases:Phases,afterNodeIds:z.array(NodeId),beforeNodeIds:z.array(NodeId)}).optional(),temporaryStorageIds:z.array(StorageId).optional(),
});
export const DependencyEdge = z.strictObject({edgeId:Id,fromNodeId:NodeId,toNodeId:NodeId,kind:z.enum(['control','synchronization'])});
export const NodeSelector = z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('nodes'),nodeIds:z.array(NodeId).min(1)}),z.strictObject({kind:z.literal('subtree'),rootNodeId:NodeId})]);
export const ParallelPresetOrigin = z.strictObject({version:z.literal('parallel-preset.1'),presetId:Id,modelId:AssetId,modelRevision:PositiveInt,groupId:Id,meshAxisId:Id});
export const NativeCollectiveBindings = z.strictObject({groups:z.array(z.strictObject({logicalGroupId:Id,physicalGroupId:Id,
  meshAxes:z.array(z.strictObject({logicalAxisId:Id,physicalAxisId:Id}))})),devices:z.array(z.strictObject({logicalDeviceId:DeviceId,physicalDeviceId:DeviceId})),
  network:z.strictObject({bytesPerSecond:z.number().positive(),latencySeconds:NonNegative}).optional()});
export const ParallelPlan = z.strictObject({assignments:z.array(z.strictObject({selector:NodeSelector,phases:Phases,
  tensorDistributions:z.array(z.strictObject({tensorId:TensorId,distribution:TensorDistribution})),storageDistributions:z.array(z.strictObject({storageId:StorageId,distribution:TensorDistribution}))})),
  communications:z.array(CommunicationDefinition),assumptions:z.array(z.string()),generatedFrom:ParallelPresetOrigin.optional(),nativeBindings:NativeCollectiveBindings.optional()});
export const GraphTemplate = z.strictObject({inputs:z.array(PortSpec),outputs:z.array(PortSpec),
  nodes:z.array(z.strictObject({nodeId:NodeId,name:Id,phases:Phases,portBindings:z.array(PortSpec),stateBindings:z.array(z.strictObject({localStateId:StateId,parentStateId:StateId})),
    repeat:z.strictObject({axis:Id,count:ValueExpr,wiring:z.enum(['chain','independent']),carry:z.array(z.strictObject({outputPortId:Id,inputPortId:Id}))}).optional(),
    body:z.discriminatedUnion('kind',[
      z.strictObject({kind:z.literal('module'),asset:AssetRef,bindings:z.array(ParameterBinding)}),z.strictObject({kind:z.literal('operator'),asset:AssetRef,bindings:z.array(ParameterBinding)}),
      z.strictObject({kind:z.literal('opaque'),cost:CostDefinition,localCost:LocalCostRule.optional(),inputs:z.array(PortSpec),outputs:z.array(PortSpec)}),z.strictObject({kind:z.literal('collective'),communication:CommunicationDefinition}),
    ])})),
  edges:z.array(z.strictObject({edgeId:Id,from:Endpoint,to:Endpoint,tensorId:TensorId})),dependencies:z.array(DependencyEdge),tensors:z.array(TensorSpec),storages:z.array(StorageSpec),states:z.array(StateSpec),
});
export const OperatorDefinition = z.strictObject({category:z.enum(['linear','norm','position','activation','attention','router','expert','elementwise','custom']),
  inputs:z.array(PortSpec),outputs:z.array(PortSpec),tensors:z.array(TensorSpec),storages:z.array(StorageSpec),states:z.array(StateSpec),phases:Phases,cost:CostDefinition,localCost:LocalCostRule.optional()});
export const HardwareDefinition = z.strictObject({capacityBytes:Natural,
  computeCapabilities:z.array(z.strictObject({computeClass:ComputeClass,kind:z.enum(['peak','effective']),operationsPerSecond:z.number().positive()})),
  memoryCapabilities:z.array(z.strictObject({key:Id,kind:z.enum(['peak','effective']),bytesPerSecond:z.number().positive()})),
  communicationDefaults:z.array(z.strictObject({scope:z.enum(['intra_group','inter_group']),bytesPerSecond:z.number().positive(),latencySeconds:NonNegative,description:Id})),
});
export const AscendQuantizationSource = z.strictObject({sourceId:Id,sourceName:Id,format:z.literal('ascend-description.1'),text:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
export const AscendQuantizationOrigin = z.strictObject({importId:Id,sourceId:Id,sourceName:Id,sourceHash:z.string().regex(/^[a-f0-9]{64}$/),sourceKey:Id,sourceLabel:Id,auxiliaryKeys:z.array(Id),note:Id});
export const AscendQuantizationMapping = z.strictObject({sourceKey:Id,storageId:StorageId,category:z.enum(['weight','activation','state']),specification:QuantizedStorageSpec,note:Id});
export const AscendQuantizationReview = z.strictObject({importId:Id,sourceId:Id,draft:z.strictObject({sourceKey:z.string(),storageId:z.string(),specificationText:z.string(),note:z.string()}),
  mappings:z.array(AscendQuantizationMapping),appliedMappings:z.array(AscendQuantizationMapping),appliedNote:z.string().optional(),confirmationNote:z.string()});
export const QuantizationDefinition = z.strictObject({selector:NodeSelector,storageIds:z.array(StorageId).min(1).optional(),weight:QuantizedStorageSpec.optional(),activation:QuantizedStorageSpec.optional(),state:QuantizedStorageSpec.optional(),preset:AssetRef.optional(),importOrigin:AscendQuantizationOrigin.optional()});
export const QuantizationApplication = z.strictObject({storageId:StorageId,category:z.enum(['weight','activation','state']),nodeIds:z.array(NodeId),
  assignmentIndices:z.array(Natural).min(1),overriddenIndices:z.array(Natural),shape:Shape,dtype:DTypeSpec,beforeBytes:Natural,afterBytes:Natural,
  specification:QuantizedStorageSpec,previousSpecification:QuantizedStorageSpec.optional(),allocationOverridden:z.boolean(),allocationOverrideBytes:Natural.optional(),importOrigins:z.array(AscendQuantizationOrigin).min(1).optional()});
export const ParallelPresetRecipe = z.strictObject({deviceSlots:z.array(DeviceId).min(1).max(64),groups:z.array(z.strictObject({groupId:Id,members:z.array(DeviceId).min(1),
  mesh:z.strictObject({axes:z.array(z.strictObject({axisId:Id,size:PositiveInt})),coordinates:z.array(z.strictObject({deviceId:DeviceId,coordinates:z.array(Natural)}))}).optional()})).min(1),
  plan:ParallelPlan.pick({assignments:true,communications:true,assumptions:true})});
export const ParallelPresetTemplate = z.strictObject({presetId:Id,name:Id,description:Id,strategy:z.enum(['replicated','batch_sharded','tensor_sharded','declared_plan']),phases:Phases,
  tensorShards:z.array(z.strictObject({tensorId:TensorId,axisId:Id})),
  networkDefaults:z.strictObject({scope:z.enum(['intra_group','inter_group']),bytesPerSecond:z.number().positive(),latencySeconds:NonNegative,description:Id}).optional(),
  reductions:z.array(z.strictObject({tensorId:TensorId,producerNodeId:NodeId,consumerNodeIds:z.array(NodeId).min(1),payloadBytes:ValueExpr,payloadDtype:DTypeSpec})),assumptions:z.array(Id).min(1),declaredPlan:ParallelPresetRecipe.optional()});
export const FusionGroup = z.strictObject({groupId:Id,memberNodeIds:z.array(NodeId).min(1),eliminatedTensorIds:z.array(TensorId),
  origin:z.strictObject({asset:AssetRef,presetId:Id,scopeNodeId:NodeId}).optional(),extraCost:CostDefinition,extraLocalCost:z.strictObject({contextNodeId:NodeId,rule:LocalCostRule}).optional(),timeStrategy:z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('sum_members')}),
    z.strictObject({kind:z.literal('override'),timing:TimingDefinition,description:Id}),
  ])});
export const FusionPresetTemplate = z.strictObject({presetId:Id,name:Id,description:Id,phases:Phases,assumptions:z.array(Id).min(1),group:FusionGroup.omit({origin:true,extraLocalCost:true})});
export const AssetDocument = z.strictObject({documentType:z.literal('asset'),schemaVersion:z.literal(1),assetId:AssetId,revision:PositiveInt,name:Id,description:z.string().optional(),
  tags:z.array(z.string()),parameters:z.array(ParameterDef),sources:z.array(z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('url'),url:z.url(),checkedOn:z.iso.date().optional()}),z.strictObject({kind:z.literal('note'),text:Id})])),
  definition:z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('model'),family:Id,variant:Id,graph:GraphTemplate,assumptions:z.array(Id).optional(),workloadBindings:z.array(z.strictObject({phase:Phase,parameterKey:Id,value:ValueExpr})).optional()}),z.strictObject({kind:z.literal('module'),graph:GraphTemplate}),
    z.strictObject({kind:z.literal('operator'),operator:OperatorDefinition}),z.strictObject({kind:z.literal('formula'),formula:FormulaDefinition}),
    z.strictObject({kind:z.literal('parallel'),plan:ParallelPlan}),z.strictObject({kind:z.literal('quantization'),quantization:QuantizationDefinition}),z.strictObject({kind:z.literal('hardware'),hardware:HardwareDefinition}),
  ]),extensions:z.record(z.string(),z.json()).optional(),configMapping:ConfigMappingProfile.optional(),configImport:ConfigImportMetadata.optional(),parallelPresets:z.array(ParallelPresetTemplate).optional(),fusionPresets:z.array(FusionPresetTemplate).optional(),
});
export const AssetDraft = z.strictObject({documentType:z.literal('asset_draft'),schemaVersion:z.literal(1),draftId:Id,assetId:AssetId,assetKind:AssetKind,
  baseRevision:PositiveInt.nullable(),draftGeneration:Natural,updatedAt:z.iso.datetime(),candidate:z.json(),storageFormat:z.enum(['json','yaml']).optional(),importIntent:z.strictObject({source:AssetRef,mode:z.enum(['preserve','next'])}).optional()});
export const DeviceTopology = z.strictObject({devices:z.array(z.strictObject({deviceId:DeviceId,hardware:AssetRef})).min(1),
  groups:z.array(z.strictObject({groupId:Id,members:z.array(DeviceId).min(1),mesh:z.strictObject({axes:z.array(z.strictObject({axisId:Id,size:PositiveInt})),
    coordinates:z.array(z.strictObject({deviceId:DeviceId,coordinates:z.array(Natural)}))}).optional()}))});
export const ExecutionPlan = z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('serial')}),z.strictObject({kind:z.literal('streams'),assignments:z.array(z.strictObject({nodeId:NodeId,groupId:Id,streamId:Id})),extraDependencies:z.array(DependencyEdge),
    resourcePolicy:z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('ideal')}),z.strictObject({kind:z.literal('shared_bandwidth')}),z.strictObject({kind:z.literal('user_efficiency'),efficiency:Efficiency})])}),
]);
export const NumericOverride = z.strictObject({target:z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('project')}),z.strictObject({kind:z.literal('scenario'),scenarioId:Id}),z.strictObject({kind:z.literal('node'),nodeId:NodeId}),
  z.strictObject({kind:z.literal('storage'),storageId:StorageId}),z.strictObject({kind:z.literal('device'),deviceId:DeviceId})]),
  field:z.enum(['parameter','fixed_seconds','compute_efficiency','memory_efficiency','memory_bytes','traffic_bytes','communication_bandwidth','communication_latency']),
  parameterKey:Id.optional(),value:Quantity,description:z.string().optional()});
export const MemoryPeakOverride = z.strictObject({overrideId:Id,phases:Phases,
  target:z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('device'),deviceId:DeviceId}),
    z.strictObject({kind:z.literal('group'),groupId:Id}),
  ]),peakBytes:ValueExpr,description:Id});
export const ModulePeakOverride = z.strictObject({overrideId:Id,nodeId:NodeId,phases:Phases,peakBytes:ValueExpr,description:Id});
export const FusionApplication = FusionGroup.extend({nodeId:NodeId,extraNodeId:NodeId,ownerNodeId:NodeId,eliminatedStorageIds:z.array(StorageId)});
export const Scenario = z.strictObject({scenarioId:Id,name:Id,model:AssetRef,bindings:z.array(ParameterBinding),
  workload:z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('prefill'),batchSize:PositiveInt,queryTokensPerRequest:PositiveInt,pastTokensPerRequest:Natural,chunkTokens:PositiveInt.optional()}),
    z.strictObject({kind:z.literal('decode'),batchSize:PositiveInt,contextTokensPerRequest:Natural,queryTokensPerRequest:PositiveInt,steps:PositiveInt,approximation:z.literal('fixed_context').optional()}),
  ]),deviceTopology:DeviceTopology,parallelPlan:ParallelPlan,executionPlan:ExecutionPlan,quantizationOverrides:z.array(QuantizationDefinition),numericOverrides:z.array(NumericOverride),memoryPeakOverrides:z.array(MemoryPeakOverride).optional(),modulePeakOverrides:z.array(ModulePeakOverride).optional(),ascendQuantizationImports:z.array(AscendQuantizationReview).optional(),fusionGroups:z.array(FusionGroup)});
export const ParallelPresetRequest = z.strictObject({scenario:Scenario,assets:z.array(AssetDocument),presetId:Id,groupId:Id,meshAxisId:Id,
  network:z.strictObject({bytesPerSecond:z.number().positive(),latencySeconds:NonNegative}).optional()});
export const ParallelPresetPreview = z.strictObject({version:z.literal('parallel-preset.1'),presetId:Id,presetName:Id,sourceModel:AssetRef,sourceInputHash:Id,scenario:Scenario,assets:z.array(AssetDocument),
  deviceIds:z.array(DeviceId),assignmentCount:Natural,communicationCount:Natural,communications:z.array(CommunicationDefinition).optional(),allocations:z.array(z.strictObject({deviceId:DeviceId,totalBytes:Natural,weightBytes:Natural,stateBytes:Natural})),warnings:z.array(Id)});
export const ParallelPresetAttempt = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),preview:ParallelPresetPreview}),
  z.strictObject({status:z.literal('unavailable'),message:Id}),
]);
export const MeasurementRecord = z.strictObject({measurementId:Id,scenarioId:Id,inputHash:Id.optional(),target:z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('model')}),z.strictObject({kind:z.literal('module'),nodeId:NodeId}),z.strictObject({kind:z.literal('node'),nodeId:NodeId}),z.strictObject({kind:z.literal('unmapped'),eventName:Id,source:Id})]),
  phase:Phase,deviceIds:z.array(DeviceId).min(1),interval:Id,count:PositiveInt,
  time:z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('single'),seconds:z.number().positive()}),z.strictObject({kind:z.literal('mean'),seconds:z.number().positive()}),z.strictObject({kind:z.literal('sum'),seconds:z.number().positive()}),
    z.strictObject({kind:z.literal('span'),startSeconds:NonNegative,endSeconds:NonNegative})]),
  actualBytes:z.strictObject({readBytes:NonNegative,writeBytes:NonNegative,basis:z.enum(['per_call','interval_total'])}).optional(),
  source:z.strictObject({kind:z.enum(['manual','import','agent']),file:Id.optional(),eventId:Id.optional(),mappingBasis:z.string().optional(),importedFrom:Id.optional()}),
});
export const MeasurementFile = z.strictObject({documentType:z.literal('measurements'),schemaVersion:z.literal(1),records:z.array(MeasurementRecord).min(1).max(1000)});
export const ConfigurationFields = Scenario.omit({scenarioId:true,model:true,ascendQuantizationImports:true});
export const ConfigurationDraft = z.strictObject({scenarioId:Id,model:AssetRef,base:ConfigurationFields,assetKey:Id,text:z.string(),inputs:z.record(Id,z.string())});
export const DecodeMeasurementsRequest = z.strictObject({sourceName:Id,format:z.enum(['csv','json']),text:z.string().max(2*1024*1024)});
export const ProjectDocument = z.strictObject({documentType:z.literal('project'),schemaVersion:z.literal(1),projectId:Id,projectRevision:PositiveInt,name:Id,
  scenarios:z.array(Scenario),assetSnapshots:z.array(AssetDocument),configurationDrafts:z.array(ConfigurationDraft).optional(),quantizationSources:z.array(AscendQuantizationSource).optional(),measurements:z.array(MeasurementRecord),
  viewState:z.strictObject({nodes:z.array(z.strictObject({nodeId:NodeId,x:z.number(),y:z.number(),collapsed:z.boolean(),color:z.string().optional()}))})});
export const ProjectDraft = z.strictObject({documentType:z.literal('project_draft'),schemaVersion:z.literal(1),draftId:Id,projectId:Id,
  baseProjectRevision:PositiveInt.nullable(),draftGeneration:Natural,updatedAt:z.iso.datetime(),candidate:z.json(),editorFormat:z.enum(['json','yaml']).optional()});
export const ConfigurationEditRequest = z.strictObject({project:ProjectDocument,scenarioId:Id});
export const ConfigurationEditAttempt = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),project:ProjectDocument}),z.strictObject({status:z.literal('unavailable'),message:Id}),
]);
export const ProjectRecoveryDocument = z.strictObject({documentType:z.literal('project_recovery'),schemaVersion:z.literal(1),status:z.literal('draft'),projectId:Id,
  baseProjectRevision:PositiveInt.nullable(),formalProject:ProjectDocument.nullable(),editorText:z.string(),editorFormat:z.enum(['json','yaml']).optional()});
export const ProjectImportDocument = z.discriminatedUnion('documentType',[ProjectDocument,ProjectRecoveryDocument]);
export const Diagnostic = z.strictObject({diagnosticId:Id,severity:z.enum(['error','warning','info']),code:Id,message:Id,
  location:z.discriminatedUnion('kind',[
    z.strictObject({kind:z.literal('asset'),assetId:AssetId,fieldPath:z.string().optional()}),z.strictObject({kind:z.literal('node'),nodeId:NodeId,fieldPath:z.string().optional()}),
    z.strictObject({kind:z.literal('scenario'),scenarioId:Id,fieldPath:z.string().optional()}),z.strictObject({kind:z.literal('file'),name:Id,line:PositiveInt.optional(),column:PositiveInt.optional(),fieldPath:z.string().optional()})])});
export const Provenance = z.strictObject({assetRefs:z.array(AssetRef),formulaRefs:z.array(AssetRef),parameterSources:z.array(z.strictObject({parameterKey:Id,source:Id})),assumptions:z.array(z.string())});
export const MetricValue = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),quantity:Quantity,basis:z.enum(['theoretical','estimated','measured']),provenance:Provenance,diagnosticIds:z.array(Id)}),
  z.strictObject({status:z.literal('unavailable'),diagnosticIds:z.array(Id).min(1)}),
]);
// A result field's declared unit is checked structurally as well as at evaluation boundaries.
export const metricFor = <U extends z.infer<typeof Unit>>(unit:U) => z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),quantity:z.strictObject({value:NonNegative,unit:z.literal(unit)}),basis:z.enum(['theoretical','estimated','measured']),provenance:Provenance,diagnosticIds:z.array(Id)}),
  MetricValue.options[1],
]);
export const MetricTarget = z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('model')}),z.strictObject({kind:z.literal('module'),nodeId:NodeId}),z.strictObject({kind:z.literal('node'),nodeId:NodeId}),
]);
export const DeviceScope = z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('per_device'),deviceId:DeviceId}),
  z.strictObject({kind:z.literal('equivalence_class'),classId:Id,deviceIds:z.array(DeviceId).min(1)}),
]);
export const MetricScope = z.strictObject({phase:Phase,target:MetricTarget,deviceIds:z.array(DeviceId).min(1),aggregation:z.enum(['per_device','group_total','model_useful'])});
export type MetricTarget = z.infer<typeof MetricTarget>;
export const ComputeCostResult = z.strictObject({computeClass:ComputeClass,usefulOperations:metricFor('operation'),executedOperations:metricFor('operation')});
export const CommunicationCostResult = z.strictObject({groupId:Id,operation:CommunicationDefinition.shape.operation,
  sendBytesPerMember:metricFor('byte'),receiveBytesPerMember:metricFor('byte'),algorithmTrafficBytesPerMember:metricFor('byte'),
  groupSendBytes:metricFor('byte'),groupReceiveBytes:metricFor('byte')});
export const CostResult = z.strictObject({scope:MetricScope,compute:z.array(ComputeCostResult),logicalReadBytes:metricFor('byte'),logicalWriteBytes:metricFor('byte'),
  hbmBytes:metricFor('byte'),communications:z.array(CommunicationCostResult),seconds:metricFor('second')});
export const NodeCostResult = z.strictObject({nodeId:NodeId,cost:CostResult});
export const ModuleCostResult = z.strictObject({nodeId:NodeId,leafNodeIds:z.array(NodeId),cost:CostResult});
export const ScheduleEntry = z.strictObject({nodeId:NodeId,deviceScope:DeviceScope,streamId:Id,startSeconds:NonNegative,endSeconds:NonNegative,decodeStepIndex:Natural.optional()});
const MemoryEvidenceBytes=z.discriminatedUnion('status',[metricFor('byte').options[0].omit({provenance:true}).extend({provenanceIndex:Natural}),MetricValue.options[1]]);
/** Evaluated canonical allocations, not an attribution or decomposition of a peak. */
export const MemoryEvidence = z.strictObject({version:z.literal('canonical-memory.1'),deviceId:DeviceId,axis:z.enum(['order','second']),provenancePool:z.array(Provenance),
  interfaces:z.array(z.strictObject({nodeId:NodeId,storageIds:z.array(StorageId)})).optional(),
  initialStorageIds:z.array(StorageId),outputStorageIds:z.array(StorageId),carriedStorageIds:z.array(StorageId),
  allocations:z.array(z.strictObject({storageId:StorageId,name:Id.optional(),allocationKind:z.enum(['tensor','bytes']).optional(),category:StorageSpec.shape.category,sharingDomain:StorageSpec.shape.sharingDomain.optional(),aliasIds:z.array(StorageId),eliminatedBy:z.array(Id),resident:z.boolean(),bytes:MemoryEvidenceBytes,perCopyAllocation:z.strictObject({copies:PositiveInt,payloadBytes:MemoryEvidenceBytes,totalBytes:MemoryEvidenceBytes,auxiliaryBytes:z.array(z.strictObject({name:Id,bytes:MemoryEvidenceBytes}))}).optional(),
    intervals:z.array(z.strictObject({start:NonNegative,end:NonNegative})).optional()})),
  uses:z.array(z.strictObject({nodeId:NodeId,executionNodeId:NodeId,reads:z.array(StorageId),writes:z.array(StorageId),temporary:z.array(StorageId)}))});
export const CapacityStatus = z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('solved'),fixedVariables:z.array(ParameterBinding),solveVariable:Id,maximum:Natural,searchRange:z.strictObject({min:Natural,max:Natural}),limitingDeviceIds:z.array(DeviceId).min(1)}),
  z.strictObject({kind:z.literal('point_only'),description:Id}),
  z.strictObject({kind:z.literal('unavailable'),diagnosticIds:z.array(Id).min(1)}),
]);
const RawMemoryPeakEstimate = z.strictObject({deviceScope:DeviceScope,
  categoryBreakdown:z.array(z.strictObject({category:StorageSpec.shape.category,bytes:metricFor('byte')})),peakBytes:metricFor('byte'),
  peakPoint:z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('time'),seconds:NonNegative,nodeId:NodeId.optional()}),z.strictObject({kind:z.literal('order'),index:Natural,nodeId:NodeId.optional()})]),capacityBytes:Natural,capacityStatus:CapacityStatus});
export const MemoryPeakEstimate = RawMemoryPeakEstimate.extend({moduleOverrides:z.strictObject({
  policy:z.literal('private_budget_reserved_for_call_span'),axis:z.enum(['order','second']),theoretical:RawMemoryPeakEstimate,
  applications:z.array(z.strictObject({rule:ModulePeakOverride,evaluatedBytes:Natural,memberNodeIds:z.array(NodeId).min(1),extraNodeIds:z.array(NodeId),executionNodeIds:z.array(NodeId).min(1),
    privateStorageIds:z.array(StorageId),retainedStorageIds:z.array(StorageId),boundaryStorageIds:z.array(StorageId),start:NonNegative,end:NonNegative})).min(1),
  allocations:z.array(z.strictObject({storageId:StorageId,category:StorageSpec.shape.category,bytes:metricFor('byte'),
    intervals:z.array(z.strictObject({start:NonNegative,end:NonNegative}))})),
  uses:z.array(z.strictObject({nodeId:NodeId,executionNodeId:NodeId,reads:z.array(StorageId),writes:z.array(StorageId),temporary:z.array(StorageId)})),
  initialStorageIds:z.array(StorageId),outputStorageIds:z.array(StorageId),carriedStorageIds:z.array(StorageId),
  peakCoordinate:NonNegative,
}).optional()});
export const MemoryPeak = MemoryPeakEstimate.extend({
  peakPoint:z.discriminatedUnion('kind',[...MemoryPeakEstimate.shape.peakPoint.options,
    z.strictObject({kind:z.literal('unlocated'),overrideId:Id,decodeStepIndex:Natural.optional()})]),
  totalOverride:z.strictObject({rule:MemoryPeakOverride,evaluatedBytes:Natural,deviceIds:z.array(DeviceId).min(1),shadowedOverrideIds:z.array(Id),
    classification:z.literal('unknown'),theoretical:MemoryPeakEstimate}).optional(),
  sequenceTheoretical:RawMemoryPeakEstimate.optional(),
});
export const RooflinePoint = z.strictObject({scope:MetricScope,computeClass:ComputeClass,operations:metricFor('operation'),trafficBytes:metricFor('byte'),
  arithmeticIntensity:z.discriminatedUnion('status',[
    z.strictObject({status:z.literal('available'),operationsPerByte:NonNegative}),MetricValue.options[1],
  ]),computeCeiling:metricFor('operation_per_second'),memoryBandwidth:metricFor('byte_per_second'),roofPerformance:metricFor('operation_per_second'),actualOrPredictedPerformance:metricFor('operation_per_second'),trafficBasis:z.enum(['logical','estimated_hbm','measured_hbm'])});
export const StorageAllocationResult = z.strictObject({storageId:StorageId,canonicalStorageId:StorageId,payloadBytes:metricFor('byte'),auxiliaryBytes:z.array(z.strictObject({name:Id,bytes:metricFor('byte')})),totalBytes:metricFor('byte'),diagnostics:z.array(Diagnostic)});
export const ResolvedParameter = z.strictObject({nodeId:NodeId,parameterKey:Id,value:ParameterValue,unit:Unit,source:z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('asset_default'),asset:AssetRef}),
  z.strictObject({kind:z.literal('asset_workload_binding'),asset:AssetRef,phase:Phase}),
  z.strictObject({kind:z.literal('config_import'),asset:AssetRef,sourceName:Id,field:Id,origin:z.enum(['config','manual'])}),
  z.strictObject({kind:z.literal('scenario_override'),scenarioId:Id}),
  z.strictObject({kind:z.literal('node_override'),nodeId:NodeId}),
  z.strictObject({kind:z.literal('project_default'),scenarioId:Id}),
])});
export const ResolvedGraph = z.strictObject({phase:Phase,graph:GraphTemplate,
  quantizationApplications:z.array(QuantizationApplication),
  fusionApplications:z.array(FusionApplication),
  containers:z.array(z.strictObject({nodeId:NodeId,name:Id,asset:AssetRef,leafNodeIds:z.array(NodeId)})),
  parameters:z.array(ResolvedParameter),assetRefs:z.array(AssetRef),
  objectBindings:z.array(z.strictObject({nodeId:NodeId,tensors:z.array(z.strictObject({localTensorId:TensorId,tensorId:TensorId,axes:z.array(z.strictObject({localAxisId:Id,axisId:Id}))})),
    storages:z.array(z.strictObject({localStorageId:StorageId,storageId:StorageId})),states:z.array(z.strictObject({localStateId:StateId,stateId:StateId}))})),
});
export const InstantiationResult = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),resolved:ResolvedGraph,diagnostics:z.array(Diagnostic)}),
  z.strictObject({status:z.literal('unavailable'),diagnostics:z.array(Diagnostic).min(1)}),
]);
export const TensorPartitionResult = z.strictObject({tensorId:TensorId,dtype:DTypeSpec,groupId:Id,distribution:TensorDistribution,globalShape:Shape,
  coverage:z.enum(['exact','padded','manual','partial']),placements:z.array(z.strictObject({deviceId:DeviceId,logicalShape:Shape,allocatedShape:Shape,
    copies:PositiveInt,logicalElements:Natural,allocatedElements:Natural,slices:z.array(z.strictObject({axisId:Id,start:Natural,end:Natural,paddedExtent:Natural}))})).min(1),diagnostics:z.array(Diagnostic)});
export const TensorPartitionAttempt = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),result:TensorPartitionResult}),z.strictObject({status:z.literal('unavailable'),diagnostics:z.array(Diagnostic).min(1)}),
]);
export const CommunicationEvaluation = z.strictObject({definition:CommunicationDefinition,cost:CostResult,source:TensorPartitionResult,destination:TensorPartitionResult,
  perDevice:z.array(z.strictObject({deviceId:DeviceId,sendBytes:metricFor('byte'),receiveBytes:metricFor('byte'),algorithmTrafficBytes:metricFor('byte')})).min(1),diagnostics:z.array(Diagnostic)});
export const CommunicationAttempt = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),result:CommunicationEvaluation}),z.strictObject({status:z.literal('unavailable'),diagnostics:z.array(Diagnostic).min(1)}),
]);
export const StoragePartitionResult = z.strictObject({storageId:StorageId,canonicalStorageId:StorageId,distribution:TensorDistribution,
  materialization:z.enum(['materialized','elided']).optional(),
  perDevice:z.array(z.strictObject({deviceId:DeviceId,copies:PositiveInt,allocatedShape:Shape,allocation:StorageAllocationResult,totalBytes:metricFor('byte')})).min(1),diagnostics:z.array(Diagnostic)});
export const StoragePartitionAttempt = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),result:StoragePartitionResult}),z.strictObject({status:z.literal('unavailable'),diagnostics:z.array(Diagnostic).min(1)}),
]);
export const LocalDeviceCost = z.strictObject({deviceId:DeviceId,outcome:z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),bindings:z.array(z.strictObject({symbol:Id,source:LocalCostSource,quantity:Quantity})),cost:CostResult}),
  z.strictObject({status:z.literal('unavailable'),diagnosticIds:z.array(Id).min(1)}),
])});
export const LocalNodeEvaluation = z.strictObject({nodeId:NodeId,placement:z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('placed'),perDevice:z.array(LocalDeviceCost).min(1)}),
  z.strictObject({kind:z.literal('unplaced'),diagnosticIds:z.array(Id).min(1)}),
  z.strictObject({kind:z.literal('no_work'),description:Id}),
])});
export const DistributedCosts = z.strictObject({version:Id,nodes:z.array(LocalNodeEvaluation),logicalModelCompute:z.array(ComputeCostResult),
  deviceSubtotals:z.array(z.strictObject({deviceId:DeviceId,knownNodeIds:z.array(NodeId).min(1),missingNodeIds:z.array(NodeId),knownLeafCost:CostResult}))});
export const FusionEvaluation = z.strictObject({application:FusionApplication,participation:z.enum(['known','unknown']),perDevice:z.array(LocalDeviceCost),extraPerDevice:z.array(LocalDeviceCost),logicalExtraCompute:z.array(ComputeCostResult)});
export const StreamExecutionDetails = z.strictObject({resourcePolicy:ExecutionPlan.options[1].shape.resourcePolicy,
  assignments:z.array(z.strictObject({nodeId:NodeId,streamId:Id,deviceIds:z.array(DeviceId),groupId:Id.optional()})),
  isolated:z.array(z.strictObject({nodeId:NodeId,deviceId:DeviceId,seconds:metricFor('second'),hbmBytes:metricFor('byte'),hbmBandwidth:metricFor('byte_per_second').optional()})),
  slices:z.array(z.strictObject({startSeconds:NonNegative,endSeconds:NonNegative,progress:z.array(z.strictObject({nodeId:NodeId,deviceId:DeviceId,speed:Efficiency,workSeconds:NonNegative}))})),
  serialMakespan:metricFor('second'),timeSavedSeconds:z.number().optional(),assumptions:z.array(z.string())});
export const SerialExecution = z.strictObject({version:Id,policy:z.enum(['serial_barrier','streams']),completeness:z.enum(['complete','partial']),orderedNodeIds:z.array(NodeId),
  dependencies:z.array(z.strictObject({fromNodeId:NodeId,toNodeId:NodeId,kind:z.enum(['data','control','synchronization','communication','stream','memory'])})),
  steps:z.array(z.strictObject({nodeId:NodeId,kind:z.enum(['compute','communication','metadata']),deviceIds:z.array(DeviceId),duration:metricFor('second'),startSeconds:NonNegative.optional(),endSeconds:NonNegative.optional(),streamId:Id.optional()})),
  intervals:z.array(z.strictObject({nodeId:NodeId,kind:z.enum(['compute','communication','metadata']),deviceId:DeviceId,startSeconds:NonNegative,endSeconds:NonNegative,streamId:Id.optional()})),
  makespan:metricFor('second'),unplacedCommunicationIndices:z.array(Natural),blockedNodeIds:z.array(NodeId),
  memoryOrder:z.array(z.strictObject({nodeId:NodeId,executionNodeId:NodeId,startSeconds:NonNegative.optional()})).optional(),streams:StreamExecutionDetails.optional()});
export const SerialExecutionAttempt = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),result:SerialExecution}),z.strictObject({status:z.literal('unavailable'),diagnosticIds:z.array(Id).min(1)}),
]);
export const ParallelResolution = z.strictObject({engineVersion:Id,inputHash:Id,scenarioId:Id,phase:Phase,
  memoryEvidence:z.array(MemoryEvidence).optional(),
  quantizationApplications:z.array(QuantizationApplication),
  fusions:z.array(FusionEvaluation),singleDeviceBaseline:z.boolean().optional(),
  tensorLayouts:z.array(z.strictObject({nodeId:NodeId,tensorId:TensorId,assignmentIndices:z.array(Natural),overriddenIndices:z.array(Natural),partition:TensorPartitionResult})),
  storageLayouts:z.array(z.strictObject({nodeId:NodeId,storageId:StorageId,assignmentIndices:z.array(Natural),overriddenIndices:z.array(Natural),distribution:TensorDistribution})),
  storageAllocations:z.array(z.strictObject({storageId:StorageId,category:StorageSpec.shape.category,aliasIds:z.array(StorageId),nodeIds:z.array(NodeId),assignmentIndices:z.array(Natural),allocation:StoragePartitionResult})),
  communications:z.array(z.strictObject({index:Natural,origin:z.strictObject({kind:z.literal('graph'),nodeId:NodeId}).optional(),evaluation:CommunicationEvaluation})),
  deviceAllocations:z.array(z.strictObject({deviceId:DeviceId,categoryBreakdown:z.array(z.strictObject({category:StorageSpec.shape.category,bytes:metricFor('byte')})),knownBytes:metricFor('byte')})),
  localCosts:DistributedCosts,execution:SerialExecutionAttempt,memory:z.array(MemoryPeak),
  serialBaseline:z.strictObject({execution:SerialExecutionAttempt,memory:z.array(MemoryPeak)}).optional(),
  temporalMemory:z.strictObject({initialStorageIds:z.array(StorageId),outputStorageIds:z.array(StorageId),carriedStorageIds:z.array(StorageId),uses:z.array(z.strictObject({nodeId:NodeId,executionNodeId:NodeId,deviceId:DeviceId,reads:z.array(StorageId),writes:z.array(StorageId),temporary:z.array(StorageId)})),
    lifetimes:z.array(z.strictObject({storageId:StorageId,deviceId:DeviceId,category:StorageSpec.shape.category,intervals:z.array(z.strictObject({startSeconds:NonNegative,endSeconds:NonNegative}))}))}).optional(),
  unassignedTensorIds:z.array(TensorId),unassignedTensorUses:z.array(z.strictObject({nodeId:NodeId,tensorId:TensorId})),unassignedStorageIds:z.array(StorageId),diagnostics:z.array(Diagnostic)});
export const ParallelResolutionAttempt = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),result:ParallelResolution}),z.strictObject({status:z.literal('unavailable'),diagnostics:z.array(Diagnostic).min(1)}),
]);
export const LogicalComputeResult = z.strictObject({scope:MetricScope,compute:z.array(ComputeCostResult)});
export const DecodeStepContext = z.strictObject({index:Natural,parentInputHash:Id,carriedStateIds:z.array(StateId)});
export const SingleStepAnalysisResult = z.strictObject({engineVersion:Id,inputHash:Id,scenarioId:Id,phase:Phase,scope:MetricScope,stepContext:DecodeStepContext.optional(),
  memoryEvidence:z.array(MemoryEvidence).optional(),
  parameterTrace:z.array(ResolvedParameter).optional(),
  quantizationApplications:z.array(QuantizationApplication).optional(),
  fusions:z.array(z.strictObject({evaluation:FusionEvaluation,cost:CostResult})).optional(),
  nodes:z.array(NodeCostResult),modules:z.array(ModuleCostResult),total:CostResult,memory:z.array(MemoryPeak),schedule:z.array(ScheduleEntry),roofline:z.array(RooflinePoint),
  distributed:z.strictObject({layout:ParallelResolution,logicalCompute:z.array(LogicalComputeResult)}).optional(),diagnostics:z.array(Diagnostic)});
export const DecodeStateTransition = z.strictObject({stateId:StateId,allocationBasis:z.enum(['context_boundary','step_end']).optional(),policy:StateSpec.shape.updatePolicy,afterPolicy:StateSpec.shape.updatePolicy,beforeVersion:Natural,afterVersion:Natural,
  beforeInitialized:z.boolean(),beforeTokenRange:z.strictObject({start:Natural,end:Natural}).optional(),afterTokenRange:z.strictObject({start:Natural,end:Natural}).optional(),
  storages:z.array(z.strictObject({storageId:StorageId,deviceId:DeviceId,beforeBytes:metricFor('byte'),afterBytes:metricFor('byte'),reservedBytes:metricFor('byte'),
    beforeStorage:StorageSpec,afterStorage:StorageSpec,beforeCopies:Natural,afterCopies:Natural,beforeAllocatedShape:Shape.optional(),afterAllocatedShape:Shape.optional(),carriedBytes:metricFor('byte').optional()}))});
export const DecodeSequence = z.strictObject({baseScenario:Scenario,mode:z.enum(['growing_context','fixed_context']),allocationStrategy:z.literal('in_place_reserve_max'),
  logicalCompute:z.array(LogicalComputeResult),unmeasurableTargetIds:z.array(Id),fusedMemberNodeIds:z.array(NodeId),
  steps:z.array(z.strictObject({index:Natural,contextBefore:Natural,contextAfter:Natural,evaluatedContext:Natural,
    scenario:Scenario,result:SingleStepAnalysisResult,stateTransitions:z.array(DecodeStateTransition),memory:z.array(MemoryPeak),startSeconds:NonNegative.optional(),endSeconds:NonNegative.optional()})).min(2)});
export const AnalysisResult = SingleStepAnalysisResult.extend({decode:DecodeSequence.optional()});
export const AnalysisAttempt = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),result:AnalysisResult}),
  z.strictObject({status:z.literal('unavailable'),diagnostics:z.array(Diagnostic).min(1)}),
]);
export const CapacityVariable = z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('workload'),field:z.enum(['batchSize','queryTokensPerRequest','pastTokensPerRequest','contextTokensPerRequest'])}),
  z.strictObject({kind:z.literal('parameter'),parameterKey:Id}),
]);
export const CapacitySearchRequest = z.strictObject({variable:CapacityVariable,searchRange:z.strictObject({min:Natural,max:Natural})});
export const CapacitySearchPoint = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),value:Natural,inputHash:Id,fit:z.enum(['fits','exceeds','unknown']),
    memory:z.array(z.strictObject({deviceId:DeviceId,peakBytes:metricFor('byte'),capacityBytes:Natural})).min(1),
    compute:z.array(ComputeCostResult),scope:MetricScope.optional(),modelUsefulCompute:z.array(ComputeCostResult).optional(),hbmBytes:metricFor('byte'),seconds:metricFor('second'),diagnostics:z.array(Diagnostic)}),
  z.strictObject({status:z.literal('unavailable'),value:Natural,diagnostics:z.array(Diagnostic).min(1)}),
]);
export const CapacitySearchResult = z.strictObject({engineVersion:Id,baseInputHash:Id,baseScenario:Scenario,request:CapacitySearchRequest,
  method:z.literal('exhaustive_integer'),completion:z.enum(['complete','cancelled']),points:z.array(CapacitySearchPoint),capacityStatus:CapacityStatus,diagnostics:z.array(Diagnostic)});
export const CapacitySearchAttempt = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),result:CapacitySearchResult}),
  z.strictObject({status:z.literal('unavailable'),diagnostics:z.array(Diagnostic).min(1)}),
]);
export const ScenarioComparisonRequest = z.strictObject({scenarioIds:z.array(Id).min(2).max(4),scan:CapacitySearchRequest.optional()});
export const ScenarioInputChange = z.strictObject({path:Id,before:z.json().optional(),after:z.json().optional()});
export const ScenarioCrossing = z.strictObject({kind:z.enum(['equal_samples','ordering_change']),lower:Natural,upper:Natural});
export const ScenarioComparisonResult = z.strictObject({version:z.literal('scenario-comparison.1'),engineVersion:Id,request:ScenarioComparisonRequest,
  completion:z.enum(['complete','cancelled']),assets:z.array(AssetDocument),
  entries:z.array(z.strictObject({scenario:Scenario,analysis:AnalysisAttempt,changes:z.array(ScenarioInputChange),scan:CapacitySearchAttempt.optional()})).min(1).max(4),
  pairs:z.array(z.strictObject({leftScenarioId:Id,rightScenarioId:Id,knownPoints:Natural,expectedPoints:PositiveInt,crossings:z.array(ScenarioCrossing)})),assumptions:z.array(Id)});
export const ScenarioComparisonAttempt = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),result:ScenarioComparisonResult}),z.strictObject({status:z.literal('unavailable'),diagnostics:z.array(Diagnostic).min(1)}),
]);
export const RooflineBalance = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),ridgeOperationsPerByte:z.number().positive(),computeSeconds:NonNegative,memorySeconds:NonNegative,side:z.enum(['compute','memory','balanced'])}),MetricValue.options[1],
]);
export const RooflineStudyRequest = z.strictObject({target:MetricTarget,decodeStep:Natural.optional(),scan:CapacitySearchRequest.optional()});
export const RooflineObservation = z.strictObject({seriesId:Id,point:RooflinePoint,sourceNodeIds:z.array(NodeId),aggregation:z.enum(['leaf','pooled']),
  hardwareComputeCeiling:metricFor('operation_per_second'),hardwareMemoryBandwidth:metricFor('byte_per_second'),
  hardwareComputeKind:z.enum(['peak','effective','mixed','unavailable']),hardwareMemoryKind:z.enum(['peak','effective','mixed','unavailable']),
  effectiveBalance:RooflineBalance,hardwareBalance:RooflineBalance});
export const RooflineStudySample = z.strictObject({value:Natural.optional(),inputHash:Id.optional(),stepInputHash:Id.optional(),evaluatedContext:Natural.optional(),observations:z.array(RooflineObservation),diagnostics:z.array(Diagnostic)});
export const RooflineStudyTransition = z.strictObject({seriesId:Id,roof:z.enum(['effective','hardware']),knownPoints:Natural,expectedPoints:PositiveInt,
  events:z.array(z.strictObject({kind:z.enum(['balanced_samples','regime_change']),lower:Natural,upper:Natural}))});
export const RooflineStudyResult = z.strictObject({version:z.literal('roofline-study.1'),engineVersion:Id,scenario:Scenario,assets:z.array(AssetDocument),request:RooflineStudyRequest,
  completion:z.enum(['complete','cancelled']),analysis:AnalysisAttempt,base:RooflineStudySample,samples:z.array(RooflineStudySample),scan:CapacitySearchAttempt.optional(),transitions:z.array(RooflineStudyTransition),assumptions:z.array(Id)});
export const RooflineStudyAttempt = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),result:RooflineStudyResult}),z.strictObject({status:z.literal('unavailable'),diagnostics:z.array(Diagnostic).min(1)}),
]);
export const MeasurementComparison = z.strictObject({measurementId:Id,inputHash:Id,measurementHash:Id,engineVersion:Id,scope:MetricScope,
  mfuScope:MetricScope.optional(),mbuScope:MetricScope.optional(),
  executedUtilization:z.strictObject({version:z.literal('executed-utilization.1'),scope:MetricScope.extend({aggregation:z.enum(['per_device','group_total'])}),compute:z.array(z.strictObject({computeClass:ComputeClass,value:metricFor('ratio')}))}).optional(),
  normalizedTime:z.strictObject({kind:z.enum(['single','mean','sum','span']),count:PositiveInt,intervalSeconds:z.number().positive(),perCallEquivalentSeconds:z.number().positive()}),
  mfu:z.array(z.strictObject({computeClass:ComputeClass,value:metricFor('ratio')})),mbu:metricFor('ratio'),mbuBasis:z.enum(['measured_hbm','estimated_hbm','unavailable']),diagnostics:z.array(Diagnostic)});
export const MeasurementComparisonAttempt = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('available'),comparison:MeasurementComparison}),z.strictObject({status:z.literal('unavailable'),diagnostics:z.array(Diagnostic).min(1)}),
]);
export const MeasurementComparisonReport = z.strictObject({version:z.literal('measurement-comparison-report.1'),analysisEngineVersion:Id,rootInputHash:Id,
  scenario:Scenario,assets:z.array(AssetDocument),page:z.strictObject({offset:Natural,pageSize:z.literal(20),totalRecords:Natural}),
  completion:z.enum(['idle','running','complete','cancelled','error']),error:z.string().min(1).optional(),
  entries:z.array(z.strictObject({record:MeasurementRecord,attempt:MeasurementComparisonAttempt.optional()})).max(20)});
export const MeasurementImportPreviewRequest = z.strictObject({file:MeasurementFile,scenario:Scenario,assets:z.array(AssetDocument),result:AnalysisResult.optional(),existing:z.array(MeasurementRecord)});
export const MeasurementImportRow = z.strictObject({measurementId:Id,status:z.enum(['ready','needs_confirmation','unmatched','stale','needs_analysis','duplicate','conflict']),message:Id,comparison:MeasurementComparison.optional()});
export const MeasurementImportPreview = z.strictObject({version:z.literal('measurement-import.1'),rows:z.array(MeasurementImportRow),canApply:z.boolean(),newRecordCount:Natural});
export const AssetIndexEntry = z.strictObject({assetId:AssetId,kind:AssetKind,revision:PositiveInt,name:Id,origin:z.enum(['builtin','user']),archived:z.boolean(),format:z.enum(['json','yaml']),family:Id.optional(),configModelTypes:z.array(Id).optional()});
export const ApiError = z.strictObject({code:z.enum(['validation','reference','conflict','io','not_found','unsupported_version']),message:Id,
  fieldIssues:z.array(z.strictObject({path:z.string(),message:Id})),currentRevision:PositiveInt.optional()});
export const SaveDraftRequest = z.strictObject({requestId:Id,draft:AssetDraft});
export const CommitRequest = z.strictObject({requestId:Id,draftId:Id,draftGeneration:Natural,expectedRevision:PositiveInt.nullable()});
export const SaveProjectRequest = z.strictObject({requestId:Id,expectedRevision:PositiveInt.nullable(),project:ProjectDocument});
export const SaveProjectDraftRequest = z.strictObject({requestId:Id,draft:ProjectDraft});
export const CommitProjectDraftRequest = z.strictObject({requestId:Id,draftId:Id,draftGeneration:Natural,expectedRevision:PositiveInt.nullable()});
export const ArchiveRequest = z.strictObject({requestId:Id,assetId:AssetId,archived:z.boolean()});
export const SnapshotRequest = z.strictObject({refs:z.array(AssetRef)});
export const DecodeAssetRequest = z.strictObject({text:z.string().max(4*1024*1024),format:z.enum(['json','yaml'])});
export const DecodeProjectRequest = DecodeAssetRequest.extend({text:z.string().max(PROJECT_TEXT_BYTES)});
export const RecoverRevisionRequest = z.strictObject({requestId:Id,assetId:AssetId,revision:PositiveInt,expectedRevision:PositiveInt.nullable()});
export const ScanIssue = z.strictObject({file:Id,code:z.enum(['validation','unsupported_version','io','reference','conflict','orphan_revision']),message:Id});
export const RecoveryEntry = z.strictObject({assetId:AssetId,revision:PositiveInt,name:Id,expectedRevision:PositiveInt.nullable()});
export const ScanReport = z.strictObject({assets:z.array(AssetIndexEntry),drafts:z.array(AssetDraft),projects:z.array(ProjectDocument),projectDrafts:z.array(ProjectDraft),issues:z.array(ScanIssue),recoveries:z.array(RecoveryEntry)});
export const AssetDraftIndexEntry=AssetDraft.omit({candidate:true});
export const ProjectDraftIndexEntry=ProjectDraft.omit({candidate:true});
export const ProjectIndexEntry=ProjectDocument.pick({projectId:true,projectRevision:true,name:true}).extend({
  scenarios:z.array(Scenario.pick({scenarioId:true,name:true,model:true})),assetSnapshotCount:Natural,
});
/** Navigation metadata only; full documents are read explicitly by identity. */
export const WorkspaceCatalog=z.strictObject({assets:z.array(AssetIndexEntry),drafts:z.array(AssetDraftIndexEntry),projects:z.array(ProjectIndexEntry),projectDrafts:z.array(ProjectDraftIndexEntry),issues:z.array(ScanIssue),recoveries:z.array(RecoveryEntry)});
export const RequestAck = z.strictObject({requestId:Id});
export const SaveDraftResponse = z.strictObject({requestId:Id,draft:AssetDraft});
export const CommitResponse = z.strictObject({requestId:Id,asset:AssetDocument,headRevision:PositiveInt.optional()});
export const SaveProjectResponse = z.strictObject({requestId:Id,project:ProjectDocument});
export const ReadProjectRequest = z.strictObject({projectId:Id,revision:PositiveInt.optional()});
export const ReadDraftRequest=z.strictObject({draftId:Id});
export const SaveProjectDraftResponse = z.strictObject({requestId:Id,draft:ProjectDraft});
export const DependencyUpgradeIntent = z.strictObject({requestId:Id,projectId:Id,expectedProjectRevision:PositiveInt,scenarioId:Id,
  selections:z.array(z.strictObject({from:AssetRef,to:AssetRef})).min(1)});
export const DependencyUpgradeChange = z.strictObject({source:AssetRef,base:AssetRef,target:AssetRef,name:Id,
  action:z.enum(['reuse','revision','copy']),asset:AssetDocument.optional()});
export const DependencyUpgradeProposal = z.strictObject({version:z.literal('dependency-upgrade.1'),intent:DependencyUpgradeIntent,
  guards:z.array(z.strictObject({assetId:AssetId,head:AssetRef.nullable(),origin:z.enum(['user','builtin','absent'])})),
  changes:z.array(DependencyUpgradeChange).min(1),project:ProjectDocument,warnings:z.array(Id)});
export const DependencyUpgradePlan = DependencyUpgradeProposal.extend({planHash:Id});
export const ApplyDependencyUpgradeRequest = DependencyUpgradeIntent.extend({planHash:Id});
export const DependencyUpgradeOperation = z.strictObject({requestId:Id,status:z.enum(['prepared','complete','cancelled']),plan:DependencyUpgradePlan});
export const DependencyUpgradeOperationRequest = z.strictObject({requestId:Id});
export const DependencyUpgradeHistory = z.strictObject({operations:z.array(DependencyUpgradeOperation),issues:z.array(ScanIssue)});
export const apiResponse = <T extends z.ZodType>(data:T) => z.discriminatedUnion('ok',[
  z.strictObject({ok:z.literal(true),data}),z.strictObject({ok:z.literal(false),error:ApiError})]);
export type AssetDocument = z.infer<typeof AssetDocument>;
export type DependencyUpgradeIntent = z.infer<typeof DependencyUpgradeIntent>;
export type DependencyUpgradeProposal = z.infer<typeof DependencyUpgradeProposal>;
export type DependencyUpgradePlan = z.infer<typeof DependencyUpgradePlan>;
export type DependencyUpgradeOperation = z.infer<typeof DependencyUpgradeOperation>;
export type ApplyDependencyUpgradeRequest = z.infer<typeof ApplyDependencyUpgradeRequest>;
export type AssetDraft = z.infer<typeof AssetDraft>;
export type AssetRef = z.infer<typeof AssetRef>;
export type ValueExpr = z.infer<typeof ValueExpr>;
export type Quantity = z.infer<typeof Quantity>;
export type FormulaDefinition = z.infer<typeof FormulaDefinition>;
export type GraphTemplate = z.infer<typeof GraphTemplate>;
export type StorageSpec = z.infer<typeof StorageSpec>;
export type CostDefinition = z.infer<typeof CostDefinition>;
export type LocalCostSource = z.infer<typeof LocalCostSource>;
export type LocalCostRule = z.infer<typeof LocalCostRule>;
export type LocalDeviceCost = z.infer<typeof LocalDeviceCost>;
export type LocalNodeEvaluation = z.infer<typeof LocalNodeEvaluation>;
export type DistributedCosts = z.infer<typeof DistributedCosts>;
export type SerialExecution = z.infer<typeof SerialExecution>;
export type SerialExecutionAttempt = z.infer<typeof SerialExecutionAttempt>;
export type MemoryPeakEstimate = z.infer<typeof MemoryPeakEstimate>;
export type MemoryPeak = z.infer<typeof MemoryPeak>;
export type MemoryEvidence = z.infer<typeof MemoryEvidence>;
export type MemoryPeakOverride = z.infer<typeof MemoryPeakOverride>;
export type ModulePeakOverride = z.infer<typeof ModulePeakOverride>;
export type HardwareDefinition = z.infer<typeof HardwareDefinition>;
export type TensorSpec = z.infer<typeof TensorSpec>;
export type Shape = z.infer<typeof Shape>;
export type TensorDistribution = z.infer<typeof TensorDistribution>;
export type DeviceTopology = z.infer<typeof DeviceTopology>;
export type CommunicationDefinition = z.infer<typeof CommunicationDefinition>;
export type TensorPartitionResult = z.infer<typeof TensorPartitionResult>;
export type TensorPartitionAttempt = z.infer<typeof TensorPartitionAttempt>;
export type CommunicationEvaluation = z.infer<typeof CommunicationEvaluation>;
export type CommunicationAttempt = z.infer<typeof CommunicationAttempt>;
export type StoragePartitionResult = z.infer<typeof StoragePartitionResult>;
export type StoragePartitionAttempt = z.infer<typeof StoragePartitionAttempt>;
export type ParallelResolution = z.infer<typeof ParallelResolution>;
export type ParallelResolutionAttempt = z.infer<typeof ParallelResolutionAttempt>;
export type Diagnostic = z.infer<typeof Diagnostic>;
export type ProjectDocument = z.infer<typeof ProjectDocument>;
export type ProjectDraft = z.infer<typeof ProjectDraft>;
export type Scenario = z.infer<typeof Scenario>;
export type ConfigurationFields = z.infer<typeof ConfigurationFields>;
export type ConfigurationDraft = z.infer<typeof ConfigurationDraft>;
export type NumericOverride = z.infer<typeof NumericOverride>;
export type ParameterBinding = z.infer<typeof ParameterBinding>;
export type MeasurementRecord = z.infer<typeof MeasurementRecord>;
export type AssetIndexEntry = z.infer<typeof AssetIndexEntry>;
export type ConfigMappingProfile = z.infer<typeof ConfigMappingProfile>;
export type ConfigImportSeed = z.infer<typeof ConfigImportSeed>;
export type ConfigImportMetadata = z.infer<typeof ConfigImportMetadata>;
export type ConfigImportIssue = z.infer<typeof ConfigImportIssue>;
export type ParallelPresetTemplate = z.infer<typeof ParallelPresetTemplate>;
export type ParallelPresetRequest = z.infer<typeof ParallelPresetRequest>;
export type ParallelPresetPreview = z.infer<typeof ParallelPresetPreview>;
export type ParallelPresetAttempt = z.infer<typeof ParallelPresetAttempt>;
export type AnalysisResult = z.infer<typeof AnalysisResult>;
export type SingleStepAnalysisResult = z.infer<typeof SingleStepAnalysisResult>;
export type DecodeSequence = z.infer<typeof DecodeSequence>;
export type DecodeStateTransition = z.infer<typeof DecodeStateTransition>;
export type DecodeStepContext = z.infer<typeof DecodeStepContext>;
export type MetricScope = z.infer<typeof MetricScope>;
export type MetricValue = z.infer<typeof MetricValue>;
export type CostResult = z.infer<typeof CostResult>;
export type RooflinePoint = z.infer<typeof RooflinePoint>;
export type ResolvedGraph = z.infer<typeof ResolvedGraph>;
export type ResolvedParameter = z.infer<typeof ResolvedParameter>;
export type InstantiationResult = z.infer<typeof InstantiationResult>;
export type AnalysisAttempt = z.infer<typeof AnalysisAttempt>;
export type CapacityVariable = z.infer<typeof CapacityVariable>;
export type CapacitySearchRequest = z.infer<typeof CapacitySearchRequest>;
export type CapacitySearchPoint = z.infer<typeof CapacitySearchPoint>;
export type CapacitySearchResult = z.infer<typeof CapacitySearchResult>;
export type CapacitySearchAttempt = z.infer<typeof CapacitySearchAttempt>;
export type Provenance = z.infer<typeof Provenance>;
export type MeasurementComparison = z.infer<typeof MeasurementComparison>;
export type MeasurementComparisonAttempt = z.infer<typeof MeasurementComparisonAttempt>;
export type MeasurementComparisonReport = z.infer<typeof MeasurementComparisonReport>;
export type MeasurementFile = z.infer<typeof MeasurementFile>;
export type DecodeMeasurementsRequest = z.infer<typeof DecodeMeasurementsRequest>;
export type MeasurementImportPreviewRequest = z.infer<typeof MeasurementImportPreviewRequest>;
export type MeasurementImportRow = z.infer<typeof MeasurementImportRow>;
export type MeasurementImportPreview = z.infer<typeof MeasurementImportPreview>;
export type NodeId = z.infer<typeof NodeId>;
export type TensorId = z.infer<typeof TensorId>;
export type StorageId = z.infer<typeof StorageId>;
export type StateId = z.infer<typeof StateId>;
export type DeviceId = z.infer<typeof DeviceId>;
export type ScenarioComparisonRequest = z.infer<typeof ScenarioComparisonRequest>;
export type ScenarioInputChange = z.infer<typeof ScenarioInputChange>;
export type ScenarioCrossing = z.infer<typeof ScenarioCrossing>;
export type ScenarioComparisonResult = z.infer<typeof ScenarioComparisonResult>;
export type ScenarioComparisonAttempt = z.infer<typeof ScenarioComparisonAttempt>;
export type RooflineBalance = z.infer<typeof RooflineBalance>;
export type RooflineStudyRequest = z.infer<typeof RooflineStudyRequest>;
export type RooflineObservation = z.infer<typeof RooflineObservation>;
export type RooflineStudySample = z.infer<typeof RooflineStudySample>;
export type RooflineStudyTransition = z.infer<typeof RooflineStudyTransition>;
export type RooflineStudyResult = z.infer<typeof RooflineStudyResult>;
export type RooflineStudyAttempt = z.infer<typeof RooflineStudyAttempt>;
export * from './trace-import.js';

export type AscendQuantizationSource = z.infer<typeof AscendQuantizationSource>;
export type AscendQuantizationOrigin = z.infer<typeof AscendQuantizationOrigin>;
export type AscendQuantizationMapping = z.infer<typeof AscendQuantizationMapping>;
export type AscendQuantizationReview = z.infer<typeof AscendQuantizationReview>;

export type QuantizedStorageSpec = z.infer<typeof QuantizedStorageSpec>;

export type FusionPresetTemplate = z.infer<typeof FusionPresetTemplate>;

export type FusionGroup = z.infer<typeof FusionGroup>;
