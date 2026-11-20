import { type LocalCostRule,type Quantity,type TensorSpec,type TensorId,type StorageId,type ValueExpr } from '@model-analyser/contracts';
import { FormulaError } from './formula.js';

/** Bind asset globals now; preserve only the explicitly declared local symbols. */
export function bindLocalCostRule(rule:LocalCostRule,symbols:Record<string,Quantity>,localTensors:TensorSpec[],tensorMap:Map<string,TensorId>,globalTensors:ReadonlyMap<string,TensorSpec>,storageMap:Map<string,StorageId>):LocalCostRule{
  const locals=new Set(rule.bindings.map(b=>b.symbol));if(locals.size!==rule.bindings.length)throw new FormulaError('duplicate_id','局部成本绑定符号重复');
  function tensor(id:TensorId){const mapped=tensorMap.get(id);if(!mapped||!globalTensors.has(mapped))throw new FormulaError('missing_reference','局部成本缺少张量 '+id);return mapped;}
  function storage(id:StorageId){const mapped=storageMap.get(id);if(!mapped)throw new FormulaError('missing_reference','局部成本缺少存储 '+id);return mapped;}
  function expression(value:ValueExpr):ValueExpr{
    if(value.kind==='literal')return value;
    if(value.kind==='symbol'){if(locals.has(value.name))return value;const q=symbols[value.name];if(!q)throw new FormulaError('unbound_symbol','局部成本未声明符号 '+value.name);return {kind:'literal',quantity:q};}
    return {...value,call:{...value.call,bindings:Object.fromEntries(Object.entries(value.call.bindings).map(([key,v])=>[key,expression(v)]))}};
  }
  const participation=rule.participation.kind==='tensor_layout'?{...rule.participation,tensorId:tensor(rule.participation.tensorId)}:{...rule.participation,storageId:storage(rule.participation.storageId)};
  const bindings=rule.bindings.map(b=>{const source=b.source;if(source.kind==='storage_bytes')return {...b,source:{...source,storageId:storage(source.storageId)}};
    const tensorId=tensor(source.tensorId);if(source.kind!=='tensor_axis'&&source.kind!=='tensor_slice')return {...b,source:{...source,tensorId}};
    const local=localTensors.find(t=>t.tensorId===source.tensorId),global=globalTensors.get(tensorId),index=local?.shape.findIndex(a=>a.axisId===source.axisId)??-1;
    if(!local||!global||index<0)throw new FormulaError('missing_reference','局部成本缺少原始张量轴 '+source.axisId);
    const axis=local.shape.length===global.shape.length?global.shape[index]:global.shape.find(a=>a.axisId===source.axisId);if(!axis)throw new FormulaError('ambiguous_axis_mapping','局部成本无法映射 view 轴 '+source.axisId);
    return {...b,source:{...source,tensorId,axisId:axis.axisId}};
  });
  const c=rule.cost,cost={...c,compute:c.compute.map(s=>({...s,usefulOperations:expression(s.usefulOperations),executedOperations:expression(s.executedOperations)})),memoryAccess:c.memoryAccess.map(a=>({...a,storageId:storage(a.storageId),logicalBytes:a.logicalBytes.kind==='storage_allocation'?{kind:'storage_allocation' as const,passes:expression(a.logicalBytes.passes)}:expression(a.logicalBytes),...(a.hbmEstimate?.kind==='bytes'?{hbmEstimate:{kind:'bytes' as const,value:expression(a.hbmEstimate.value)}}:{})})),temporaryStorageIds:c.temporaryStorageIds.map(storage),timing:c.timing.kind==='custom_formula'?{...c.timing,seconds:expression(c.timing.seconds)}:c.timing};
  return {...rule,participation,bindings,cost};
}
