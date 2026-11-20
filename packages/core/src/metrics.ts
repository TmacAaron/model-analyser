import { CostResult,type MetricValue,type Quantity,type Diagnostic,type Provenance,type MetricScope } from '@model-analyser/contracts';
import { canonical } from '../../contracts/src/validation.js';
import { FormulaError } from './formula.js';
export type MetricForUnit<U extends Quantity['unit']> = Extract<MetricValue,{status:'unavailable'}> |
  (Omit<Extract<MetricValue,{status:'available'}>,'quantity'> & {quantity:{value:number;unit:U}});
export class MetricFactory {
  constructor(readonly diagnostics:Diagnostic[],readonly provenance:Provenance,readonly scenarioId:string,private readonly prefix='analysis'){}
  private id(){let i=this.diagnostics.length+1;while(this.diagnostics.some(d=>d.diagnosticId===`${this.prefix}-${i}`))i++;return `${this.prefix}-${i}`;}
  unavailable(code:string,message:string):Extract<MetricValue,{status:'unavailable'}> {const diagnosticId=this.id();this.diagnostics.push({diagnosticId,severity:'error',code,message,location:{kind:'scenario',scenarioId:this.scenarioId}});return {status:'unavailable',diagnosticIds:[diagnosticId]};}
  available<U extends Quantity['unit']>(value:number,unit:U,basis:'theoretical'|'estimated'|'measured'='theoretical'):MetricForUnit<U> {
    if(!Number.isFinite(value)||value<0)return this.unavailable('numeric_overflow','指标必须为非负有限值');
    const diagnosticIds:string[]=[];
    if((unit==='operation'||unit==='byte')&&value>Number.MAX_SAFE_INTEGER){const diagnosticId=this.id();this.diagnostics.push({diagnosticId,severity:'warning',code:'precision_estimate',message:'超过安全整数，以浮点估计表示',location:{kind:'scenario',scenarioId:this.scenarioId}});diagnosticIds.push(diagnosticId);}
    return {status:'available',quantity:{value,unit},basis,provenance:this.provenance,diagnosticIds};
  }
  sum<U extends Quantity['unit']>(values:MetricValue[],unit:U):MetricForUnit<U> {
    const unavailable=values.filter(v=>v.status==='unavailable');if(unavailable.length)return {status:'unavailable',diagnosticIds:[...new Set(unavailable.flatMap(v=>v.diagnosticIds))]};
    if(values.some(v=>v.status==='available'&&v.quantity.unit!==unit))throw new FormulaError('invalid_unit','汇总指标单位不一致');
    return this.available(values.reduce((n,v)=>n+(v.status==='available'?v.quantity.value:0),0),unit,values.some(v=>v.status==='available'&&v.basis==='estimated')?'estimated':'theoretical');
  }
}
export function aggregateCosts(costs:CostResult[],scope:MetricScope,metrics:MetricFactory):CostResult {
  for(const cost of costs)if(cost.scope.phase!==scope.phase||cost.scope.aggregation!==scope.aggregation||canonical([...cost.scope.deviceIds].sort())!==canonical([...scope.deviceIds].sort()))throw new FormulaError('invalid_scope','不能直接累加不同阶段/设备/统计口径');
  const classes=new Map<string,CostResult['compute'][number][]>();for(const cost of costs)for(const segment of cost.compute){const key=canonical(segment.computeClass),entries=classes.get(key);if(entries)entries.push(segment);else classes.set(key,[segment]);}
  const compute=[...classes.values()].map(segments=>{const first=segments[0];if(!first)throw new FormulaError('invalid_cost','空计算分类');return {computeClass:first.computeClass,usefulOperations:metrics.sum(segments.map(s=>s.usefulOperations),'operation'),executedOperations:metrics.sum(segments.map(s=>s.executedOperations),'operation')};});
  return CostResult.parse({scope,compute,logicalReadBytes:metrics.sum(costs.map(c=>c.logicalReadBytes),'byte'),logicalWriteBytes:metrics.sum(costs.map(c=>c.logicalWriteBytes),'byte'),hbmBytes:metrics.sum(costs.map(c=>c.hbmBytes),'byte'),communications:costs.flatMap(c=>c.communications),seconds:metrics.sum(costs.map(c=>c.seconds),'second')});
}
