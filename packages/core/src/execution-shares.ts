import type { SerialExecution } from '@model-analyser/contracts';
export interface ExecutionCostShares {
  complete:boolean;knownTotalSeconds:number|undefined;
  costs:{kind:'compute'|'communication'|'metadata';knownSeconds:number|undefined;complete:boolean;share:number|undefined}[];
  communicationCoverageSeconds:number|undefined;communicationCoverageRatio:number|undefined;
}
/** Node-duration cost shares and union wall-clock coverage are different quantities. */
export function executionCostShares(execution:SerialExecution):ExecutionCostShares{
  const sum=(values:number[])=>{let total=0;for(const value of values){const next=total+value;if(!Number.isFinite(next)||value>0&&next===total)return undefined;total=next;}return total;};
  const knownTotalSeconds=sum(execution.steps.flatMap(s=>s.duration.status==='available'?[s.duration.quantity.value]:[])),complete=execution.completeness==='complete'&&execution.steps.every(s=>s.duration.status==='available')&&knownTotalSeconds!==undefined;
  const costs=(['compute','communication','metadata'] as const).map(kind=>{const nodes=execution.steps.filter(s=>s.kind===kind),knownSeconds=sum(nodes.flatMap(s=>s.duration.status==='available'?[s.duration.quantity.value]:[])),ratio=complete&&knownSeconds!==undefined&&knownTotalSeconds!==undefined&&knownTotalSeconds>0?knownSeconds/knownTotalSeconds:undefined;return {kind,knownSeconds,complete:execution.completeness==='complete'&&nodes.every(s=>s.duration.status==='available')&&knownSeconds!==undefined,share:ratio!==undefined&&(knownSeconds===0||ratio>0)?ratio:undefined};});
  const network=execution.steps.filter(s=>s.kind==='communication'),intervals=network.flatMap(s=>s.startSeconds===undefined||s.endSeconds===undefined?[]:[{start:s.startSeconds,end:s.endSeconds}]).sort((a,b)=>a.start-b.start),merged:{start:number;end:number}[]=[];
  for(const interval of intervals){const last=merged.at(-1);if(last&&interval.start<=last.end)last.end=Math.max(last.end,interval.end);else merged.push({...interval});}
  const union=complete&&network.length===intervals.length?sum(merged.map(i=>i.end-i.start)):undefined,span=execution.makespan.status==='available'?execution.makespan.quantity.value:undefined,ratio=union!==undefined&&span!==undefined&&span>0&&union<=span?union/span:undefined;
  return {complete,knownTotalSeconds,costs,communicationCoverageSeconds:union,communicationCoverageRatio:ratio!==undefined&&(union===0||ratio>0)?ratio:undefined};
}
