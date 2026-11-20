import type {Scenario,StorageSpec} from '@model-analyser/contracts';import {FormulaError} from './formula.js';
import type {StorageOverrideObservation} from './quantization-observation.js';
/** Same analysis step, before ALL allocation-based access binding. */
export function applyStorageAllocationOverrides(storages:StorageSpec[],overrides:Scenario['numericOverrides'],observe?:(event:StorageOverrideObservation)=>void){
 for(const [overrideIndex,override]of overrides.entries())if(override.target.kind==='storage'&&override.field==='memory_bytes'){
  const targetId=override.target.storageId,storage=storages.find(s=>s.storageId===targetId);if(!storage)throw new FormulaError('missing_reference','显存覆盖引用缺失存储');if(storage.allocation.kind==='alias')throw new FormulaError('invalid_override','不能独立覆盖 alias 的分配，请覆盖规范存储');const before=storage.allocation;storage.allocation={kind:'bytes',value:{kind:'literal',quantity:override.value}};
  observe?.(structuredClone({storageId:storage.storageId,overrideIndex,override,before,after:storage.allocation}));
 }
}
