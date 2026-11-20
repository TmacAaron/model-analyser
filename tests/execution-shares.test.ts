import { it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ProjectDocument,SerialExecution } from '@model-analyser/contracts';
import { analyzeScenario,executionCostShares } from '@model-analyser/core';
let reference:Promise<SerialExecution>|undefined;
async function calculateReference(){
 const project=ProjectDocument.parse(JSON.parse(readFileSync('examples/gqa/tp-heads-project.json','utf8')));
 const scenario=project.scenarios[0];if(!scenario)throw Error('Missing GQA fixture scenario');
 const analysis=await analyzeScenario(scenario,project.assetSnapshots);
 const execution=analysis.status==='available'?analysis.result.distributed?.layout.execution:undefined;
 if(execution?.status!=='available')throw Error('GQA fixture did not produce a schedule');
 return execution.result;
}
async function base(){return structuredClone(await (reference??=calculateReference()));}
it('checks GQA communication cost and coverage independently without HBM invention',async()=>{
  const r=executionCostShares(await base());expect(r.complete).toBe(true);expect(r.knownTotalSeconds).toBeCloseTo(4.818,12);expect(r.costs.find(c=>c.kind==='communication')?.knownSeconds).toBeCloseTo(.018,12);expect(r.costs.find(c=>c.kind==='communication')?.share).toBeCloseTo(.018/4.818,12);expect(r.communicationCoverageSeconds).toBeCloseTo(.018,12);expect(r.communicationCoverageRatio).toBeCloseTo(.018/4.818,12);
});
it('uses union coverage instead of adding overlapping communication durations or treating accumulated costs as wall-clock contribution',async()=>{
  const original=await base(),leaf=original.steps[0];if(!leaf||leaf.duration.status!=='available'||original.makespan.status!=='available')throw Error();const e=SerialExecution.parse({...original,policy:'streams',makespan:{...original.makespan,quantity:{value:5,unit:'second'}},steps:[{...leaf,nodeId:'c',kind:'compute',startSeconds:0,endSeconds:5,duration:{...leaf.duration,quantity:{value:5,unit:'second'}}},{...leaf,nodeId:'n1',kind:'communication',startSeconds:0,endSeconds:3,duration:{...leaf.duration,quantity:{value:3,unit:'second'}}},{...leaf,nodeId:'n2',kind:'communication',startSeconds:2,endSeconds:4,duration:{...leaf.duration,quantity:{value:2,unit:'second'}}}]});const r=executionCostShares(e);expect(r.knownTotalSeconds).toBe(10);expect(r.costs.find(c=>c.kind==='communication')?.share).toBe(.5);expect(r.communicationCoverageSeconds).toBe(4);expect(r.communicationCoverageRatio).toBe(.8);
});
it('does not claim full percentages for unknown durations, empty zero-time executions or unrepresentable sums',async()=>{
  const e=await base(),first=e.steps[0];if(!first)throw Error();first.duration={status:'unavailable',diagnosticIds:['missing']};const r=executionCostShares(e);expect(r.complete).toBe(false);expect(r.costs.every(c=>c.share===undefined)).toBe(true);expect(r.communicationCoverageRatio).toBeUndefined();const empty={...e,steps:[]};expect(executionCostShares(empty).costs.every(c=>c.share===undefined)).toBe(true);const huge=await base();for(const s of huge.steps)if(s.duration.status==='available')s.duration.quantity.value=1e308;expect(executionCostShares(huge).knownTotalSeconds).toBeUndefined();
});
