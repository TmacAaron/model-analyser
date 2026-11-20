import { StorageAllocationResult, type StorageSpec,type Quantity,type AssetDocument,type Diagnostic,type ValueExpr,type Provenance,type StorageId,type MetricValue } from '@model-analyser/contracts';
import { evaluateValue,FormulaError } from './formula.js';
import { collectRefs } from '../../contracts/src/validation.js';

export type EvaluationContext={symbols:Record<string,Quantity>;assets:AssetDocument[];provenance?:Provenance;storageBytes?:ReadonlyMap<StorageId,MetricValue>};
export function numericValue(expr:ValueExpr,unit:Quantity['unit'],context:EvaluationContext,integer=false):number {
  const q=evaluateValue(expr,context.symbols,context.assets);
  if(q.unit!==unit)throw new FormulaError('invalid_unit',`需要 ${unit}，收到 ${q.unit}`);
  if(!Number.isFinite(q.value)||q.value<0||(integer&&!Number.isSafeInteger(q.value)))throw new FormulaError('invalid_shape','数值必须非负有限，精确分配必须为安全整数');return q.value;
}
function exact(value:number):number{if(!Number.isSafeInteger(value)||value<0)throw new FormulaError('numeric_overflow','精确分配超出安全整数范围');return value;}
function packedBytes(count:number,bits:number):number {
  // Divide first so an exact, safe byte count does not overflow merely because its bit count is larger.
  return exact(exact(count*Math.floor(bits/8))+exact(Math.floor(count/8)*(bits%8))+Math.ceil((count%8)*(bits%8)/8));
}
export type AllocationObservation={field:string;operation:string;inputs:number[];value:number;unit:'count'|'byte'};
export function allocateStorage(storageId:StorageSpec['storageId'],storages:StorageSpec[],context:EvaluationContext,observe?:(event:AllocationObservation)=>void):ReturnType<typeof StorageAllocationResult.parse> {
  const diagnostics:Diagnostic[]=[],seen=new Set<string>();
  let storage=storages.find(s=>s.storageId===storageId);
  const provenance=context.provenance??{assetRefs:[],formulaRefs:storage?collectRefs(storage):[],parameterSources:Object.keys(context.symbols).map(parameterKey=>({parameterKey,source:'evaluation_context'})),assumptions:['Bit packing is rounded up; payload alignment is applied before tightly packed auxiliary tensors.']};
  const available=(value:number)=>({status:'available' as const,quantity:{value,unit:'byte' as const},basis:'theoretical' as const,provenance,diagnosticIds:[]});
  try{
    if(!storage)throw new FormulaError('missing_reference',`缺少存储 ${storageId}`);
    while(storage.allocation.kind==='alias'){
      if(seen.has(storage.storageId))throw new FormulaError('dependency_cycle','存储 alias 环');seen.add(storage.storageId);
      const target:StorageSpec['storageId']=storage.allocation.targetStorageId;storage=storages.find(s=>s.storageId===target);if(!storage)throw new FormulaError('missing_reference',`缺少 alias 目标 ${target}`);
    }
    let payloadBytes:number;const auxiliaryBytes:{name:string;bytes:ReturnType<typeof available>}[]=[];
    if(storage.allocation.kind==='bytes'){payloadBytes=numericValue(storage.allocation.value,'byte',context,true);observe?.({field:'payload',operation:'declared_bytes',inputs:[payloadBytes],value:payloadBytes,unit:'byte'});}
    else {
      const allocation=storage.allocation,shape=allocation.shape.map(axis=>({...axis,value:numericValue(axis.size,'count',context,true)}));
      if(new Set(shape.map(a=>a.axisId)).size!==shape.length)throw new FormulaError('duplicate_id','shape 轴 ID 重复');
      const elements=shape.reduce((n,a)=>{const value=exact(n*a.value);observe?.({field:'shape.'+a.axisId,operation:'multiply',inputs:[n,a.value],value,unit:'count'});return value;},1),q=allocation.quantization;
      const padded=q?exact(Math.ceil(elements/q.packingUnitElements)*q.packingUnitElements):elements;
      const bits=q?.payloadBits??allocation.dtype.bits;
      const raw=packedBytes(padded,bits);payloadBytes=q?exact(Math.ceil(raw/q.alignmentBytes)*q.alignmentBytes):raw;
      observe?.({field:'paddedElements',operation:q?'ceil_multiple':'identity',inputs:q?[elements,q.packingUnitElements]:[elements],value:padded,unit:'count'});
      observe?.({field:'packedPayload',operation:'ceil_bits_div8',inputs:[padded,bits],value:raw,unit:'byte'});
      observe?.({field:'alignedPayload',operation:q?'ceil_multiple':'identity',inputs:q?[raw,q.alignmentBytes]:[raw],value:payloadBytes,unit:'byte'});
      const auxiliaries=q?.auxiliaries??[];
      if(new Set(auxiliaries.map(a=>a.name)).size!==auxiliaries.length)throw new FormulaError('duplicate_id','辅助张量名称重复');
      for(const aux of auxiliaries){let count:number;let countInputs:number[]=[];
        switch(aux.count.kind){
          case 'formula':count=numericValue(aux.count.value,'count',context,true);countInputs=[count];break;
          case 'tensor':count=elements===0?0:1;countInputs=[elements];break;
          case 'group':count=Math.ceil(elements/aux.count.groupSize);countInputs=[elements,aux.count.groupSize];break;
          case 'channel':{const id=aux.count.axisId;const selected=shape.find(a=>a.axisId===id);if(!selected)throw new FormulaError('invalid_shape',`辅助张量 channel 轴不存在 ${id}`);count=elements===0?0:selected.value;countInputs=[elements,selected.value];break;}
          case 'block':{
            const axes=aux.count.axes;if(new Set(axes.map(a=>a.axisId)).size!==axes.length||axes.some(a=>!shape.some(s=>s.axisId===a.axisId)))throw new FormulaError('invalid_shape','block 轴缺失或重复');
            count=shape.reduce((n,s)=>{const block=axes.find(a=>a.axisId===s.axisId)?.blockSize??1,value=exact(n*Math.ceil(s.value/block));observe?.({field:'auxiliary.'+aux.name+'.block.'+s.axisId,operation:'multiply_ceil_div',inputs:[n,s.value,block],value,unit:'count'});return value;},1);countInputs=[count];break;
          }
        }
        const bytes=packedBytes(count,aux.dtype.bits);observe?.({field:'auxiliary.'+aux.name+'.count',operation:'declared_'+aux.count.kind,inputs:countInputs,value:count,unit:'count'});observe?.({field:'auxiliary.'+aux.name+'.bytes',operation:'ceil_bits_div8',inputs:[count,aux.dtype.bits],value:bytes,unit:'byte'});auxiliaryBytes.push({name:aux.name,bytes:available(bytes)});
      }
    }
    const total=auxiliaryBytes.reduce((n,a)=>exact(n+a.bytes.quantity.value),payloadBytes);
    observe?.({field:'totalBytes',operation:'sum',inputs:[payloadBytes,...auxiliaryBytes.map(a=>a.bytes.quantity.value)],value:total,unit:'byte'});
    return StorageAllocationResult.parse({storageId,canonicalStorageId:storage.storageId,payloadBytes:available(payloadBytes),auxiliaryBytes,totalBytes:available(total),diagnostics});
  }catch(e){
    diagnostics.push({diagnosticId:`storage-${storageId}-error`,severity:'error',code:e instanceof FormulaError?e.code:'invalid_shape',message:e instanceof Error?e.message:'存储分配失败',location:{kind:'file',name:storageId}});
    const unavailable={status:'unavailable',diagnosticIds:diagnostics.map(d=>d.diagnosticId)};
    return StorageAllocationResult.parse({storageId,canonicalStorageId:storage?.storageId??storageId,payloadBytes:unavailable,auxiliaryBytes:[],totalBytes:unavailable,diagnostics});
  }
}
