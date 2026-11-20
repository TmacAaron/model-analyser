import type { Quantity,ResolvedParameter,Scenario } from '@model-analyser/contracts';

export type SymbolAssignment={name:string;quantity:Quantity;source:{kind:'workload';field:string}|{kind:'parameter';parameter:ResolvedParameter}};
/** Shared lexical override order for quantization, fusion and memory budgets. */
export function scopedNumericSymbols(parameters:ResolvedParameter[],workload:Scenario['workload'],nodeId:string,onAssign?:(assignment:SymbolAssignment)=>void):Record<string,Quantity>{
  const symbols:Record<string,Quantity>={};
  for(const [name,value] of Object.entries(workload))if(typeof value==='number'){const quantity:Quantity={value,unit:'count'};symbols[name]=quantity;onAssign?.({name,quantity,source:{kind:'workload',field:name}});}
  const ancestors=parameters.filter(p=>p.nodeId==='$model'||nodeId===p.nodeId||nodeId.startsWith(p.nodeId+'/')||nodeId.startsWith(p.nodeId+'[')).sort((a,b)=>(a.nodeId==='$model'?0:a.nodeId.length)-(b.nodeId==='$model'?0:b.nodeId.length));
  for(const parameter of ancestors)if(parameter.value.kind==='integer'||parameter.value.kind==='number'){const quantity:Quantity={value:parameter.value.value,unit:parameter.unit};symbols[parameter.parameterKey]=quantity;onAssign?.({name:parameter.parameterKey,quantity,source:{kind:'parameter',parameter}});}
  return symbols;
}
