import { StorageSpec,StorageId,TensorId,TensorDistribution,StoragePartitionAttempt,metricFor,type StoragePartitionResult,type DeviceTopology,type Diagnostic } from '@model-analyser/contracts';
import { allocateStorage,type AllocationObservation,type EvaluationContext } from './storage.js';
import { partitionTensor } from './partition.js';
import { FormulaError } from './formula.js';
import { MetricFactory } from './metrics.js';
import { collectRefs } from '../../contracts/src/validation.js';
import type {PartitionObserver} from './layout-observation.js';

type AllocationObserver={partition:PartitionObserver;allocation?:(event:AllocationObservation)=>void;copies?:(event:{perCopyBytes:number;copies:number;totalBytes:number})=>void};

/** Each physical copy is packed/aligned and gets its own quantization auxiliaries. */
export function allocateDistributedStorage(storageId:StorageId,inputs:StorageSpec[],layout:TensorDistribution,topology:DeviceTopology,context:EvaluationContext,observer?:AllocationObserver):StoragePartitionAttempt{
  const diagnostics:Diagnostic[]=[];
  try{
    const storages=inputs.map(s=>StorageSpec.parse(s)),distribution=TensorDistribution.parse(layout),seen=new Set<string>();
    if(new Set(storages.map(s=>s.storageId)).size!==storages.length)throw new FormulaError('duplicate_id','分布存储 ID 重复');
    let storage=storages.find(s=>s.storageId===storageId);if(!storage)throw new FormulaError('missing_reference','分布存储不存在');
    while(storage.allocation.kind==='alias'){if(seen.has(storage.storageId))throw new FormulaError('dependency_cycle','分布存储 alias 环');seen.add(storage.storageId);const target:StorageId=storage.allocation.targetStorageId;storage=storages.find(s=>s.storageId===target);if(!storage)throw new FormulaError('missing_reference','分布存储 alias 目标不存在');}
    if(storage.allocation.kind==='bytes'&&distribution.kind!=='replicated'&&distribution.kind!=='partial')throw new FormulaError('invalid_distribution','固定 bytes 存储没有维度，不能隐式按比例分片；请声明张量形状或独立局部字节存储');
    const allocation=storage.allocation;
    const tensor={tensorId:TensorId.parse('$storage:'+storage.storageId),name:storage.name,storageId:storage.storageId,shape:allocation.kind==='tensor'?allocation.shape:[],dtype:allocation.kind==='tensor'?allocation.dtype:{category:'uint' as const,bits:8,format:'u8'}};
    const split=partitionTensor(tensor,distribution,topology,context,observer?.partition);if(split.status==='unavailable')return StoragePartitionAttempt.parse(split);
    const provenance=context.provenance??{assetRefs:context.assets.map(a=>({assetId:a.assetId,revision:a.revision,kind:a.definition.kind})),formulaRefs:collectRefs(storage),parameterSources:Object.keys(context.symbols).map(parameterKey=>({parameterKey,source:'evaluation_context'})),assumptions:['Physical copies on different devices are distinct allocations; quantization packing, padding and auxiliaries are recalculated per local copy. Manual copies multiply fully packed allocations, not the payload element count.']};
    const metrics=new MetricFactory(diagnostics,provenance,'storage-partition','distributed-storage-'+storage.storageId),perDevice:StoragePartitionResult['perDevice']=[];
    for(const p of split.result.placements){const localId=StorageId.parse('$device:'+encodeURIComponent(p.deviceId)+'::'+encodeURIComponent(storage.storageId));
      const local:StorageSpec={...storage,storageId:localId,allocation:allocation.kind==='tensor'?{...allocation,shape:p.allocatedShape}:allocation};
      const capture=observer?.partition.deviceId===p.deviceId?observer:undefined;
      const allocated=allocateStorage(localId,[local],{...context,provenance},capture?.allocation);diagnostics.push(...allocated.diagnostics);
      const bytes=allocated.totalBytes.status==='available'?allocated.totalBytes.quantity.value*p.copies:undefined;
      const totalBytes=bytes===undefined?allocated.totalBytes:!Number.isSafeInteger(bytes)?metrics.unavailable('numeric_overflow','局部物理副本总分配超出安全整数'):metrics.available(bytes,'byte');
      if(capture&&allocated.totalBytes.status==='available'&&totalBytes.status==='available')capture.copies?.({perCopyBytes:allocated.totalBytes.quantity.value,copies:p.copies,totalBytes:totalBytes.quantity.value});
      perDevice.push({deviceId:p.deviceId,copies:p.copies,allocatedShape:p.allocatedShape,allocation:allocated,totalBytes:metricFor('byte').parse(totalBytes)});
    }
    return StoragePartitionAttempt.parse({status:'available',result:{storageId,canonicalStorageId:storage.storageId,distribution,perDevice,diagnostics}});
  }catch(e){diagnostics.push({diagnosticId:'distributed-storage-failure',severity:'error',code:e instanceof FormulaError?e.code:'invalid_distribution',message:e instanceof Error?e.message:'存储分布失败',location:{kind:'file',name:'distributed-storage'}});return StoragePartitionAttempt.parse({status:'unavailable',diagnostics});}
}
