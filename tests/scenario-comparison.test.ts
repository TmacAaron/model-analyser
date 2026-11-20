import { describe,it,expect } from 'vitest';
import { compareScenarios,sampledCrossings,comparisonInputChanges,computeInputHash,MAX_COMPARISON_ANALYSES } from '@model-analyser/core';
import { Scenario,ScenarioComparisonRequest,type ScenarioComparisonAttempt,type CapacitySearchPoint,type MetricValue } from '@model-analyser/contracts';
import { validateProject } from '../packages/contracts/src/validation.js';
import { validateScenarioComparison } from '../packages/contracts/src/comparison-validation.js';
import { makeComparisonProject } from '../scripts/comparison-project.js';
import { c01Project } from './model-fixtures.js';
import { readFileSync } from 'node:fs';
import { ProjectDocument } from '@model-analyser/contracts';
import { comparisonRows } from '../apps/web/src/comparison-view.js';
const report=(a:ScenarioComparisonAttempt)=>{expect(a.status,JSON.stringify(a.status==='unavailable'?a.diagnostics:[])).toBe('available');if(a.status!=='available')throw Error();return a.result;};
const fixture=()=>makeComparisonProject(c01Project());
const request=(ids:string[],min=1,max=8)=>({scenarioIds:ids,scan:{variable:{kind:'parameter' as const,parameterKey:'X'},searchRange:{min,max}}});
const number=(m:MetricValue|undefined)=>m?.status==='available'?m.quantity.value:undefined;
describe('bounded reproducible scenario comparison',()=>{
  it('independently checks integer crossings, equality bands, distinct capacities and hashes without changing the project',async()=>{
    const p=fixture(),before=JSON.stringify(p);expect(validateProject(p)).toEqual([]);const r=report(await compareScenarios(p.scenarios,p.assetSnapshots,request(p.scenarios.map(s=>s.scenarioId))));expect(JSON.stringify(p)).toBe(before);expect(r.completion).toBe('complete');
    expect(r.entries.map(e=>e.analysis.status==='available'?number(e.analysis.result.total.seconds):undefined)).toEqual([2,4.5,3]);
    expect(r.entries.map(e=>e.scan?.status==='available'?e.scan.result.capacityStatus:undefined)).toMatchObject([{kind:'solved',maximum:4},{kind:'solved',maximum:8},{kind:'solved',maximum:2}]);
    expect(r.pairs.map(p=>({known:p.knownPoints,crossings:p.crossings}))).toEqual([{known:8,crossings:[{kind:'ordering_change',lower:4,upper:5}]},{known:8,crossings:[{kind:'equal_samples',lower:3,upper:8}]},{known:8,crossings:[{kind:'ordering_change',lower:4,upper:5}]}]);
    const first=r.entries[0],s=p.scenarios[0];if(!first||!s||first.scan?.status!=='available')throw Error();expect(first.changes).toEqual([]);const candidate=Scenario.parse({...s,bindings:[{parameterKey:'X',value:{kind:'integer',value:5}}]});const point=first.scan.result.points[4];expect(point?.status==='available'?point.inputHash:undefined).toBe(await computeInputHash(candidate,p.assetSnapshots));expect(point?.status==='available'?point.fit:undefined).toBe('exceeds');expect(r.entries[1]?.changes.some(c=>c.path.startsWith('/assets/'))).toBe(true);
  });
  it('finds multiple reversals and reports no sampled event when the declared range excludes them',async()=>{
    const p=fixture(),formula=p.assetSnapshots.find(a=>a.assetId==='example:formula:comparison-time-a');if(formula?.definition.kind!=='formula')throw Error();formula.definition.formula.expression='abs(X - 4) + 1';const ids=p.scenarios.slice(0,2).map(s=>s.scenarioId);const r=report(await compareScenarios(p.scenarios,p.assetSnapshots,request(ids,1,9)));expect(r.pairs[0]?.crossings).toEqual([{kind:'ordering_change',lower:7,upper:8}]);
    // Change B to 2.5: A crosses it twice, between integers. Neither interval is a claimed exact root.
    const b=p.assetSnapshots.find(a=>a.assetId==='example:formula:comparison-time-b');if(b?.definition.kind!=='formula')throw Error();b.definition.formula.expression='2.5';expect(report(await compareScenarios(p.scenarios,p.assetSnapshots,request(ids,1,8))).pairs[0]?.crossings).toEqual([{kind:'ordering_change',lower:2,upper:3},{kind:'ordering_change',lower:5,upper:6}]);expect(report(await compareScenarios(p.scenarios,p.assetSnapshots,request(ids,3,5))).pairs[0]?.crossings).toEqual([]);
  });
  it('never bridges missing samples; exact zero ties remain ties, not sign changes',async()=>{
    const p=fixture(),r=report(await compareScenarios(p.scenarios,p.assetSnapshots,request(p.scenarios.slice(0,2).map(s=>s.scenarioId))));const e=r.entries[0];if(e?.scan?.status!=='available')throw Error();const points=e.scan.result.points;
    const series=(times:(number|undefined)[]):CapacitySearchPoint[]=>times.map((time,i)=>{const original=points[i];if(!original||original.status!=='available'||original.seconds.status!=='available')throw Error();return time===undefined?{status:'unavailable',value:i+1,diagnostics:[]}:{...original,value:i+1,seconds:{...original.seconds,status:'available',quantity:{value:time,unit:'second'}}};});
    expect(sampledCrossings(series([1,undefined,5]),series([3,3,3]))).toEqual({knownPoints:2,crossings:[]});expect(sampledCrossings(series([0,0,1]),series([0,0,0]))).toEqual({knownPoints:3,crossings:[{kind:'equal_samples',lower:1,upper:2}]});
    const bad=p.assetSnapshots.find(a=>a.assetId==='example:formula:comparison-time-a');if(bad?.definition.kind!=='formula')throw Error();bad.definition.formula.expression='1 / (X - 3)';const partial=report(await compareScenarios(p.scenarios,p.assetSnapshots,request(p.scenarios.slice(0,2).map(s=>s.scenarioId),1,5)));expect(partial.pairs[0]?.knownPoints).toBeLessThan(5);expect(partial.pairs[0]?.crossings).toEqual([]);
  });
  it('rejects duplicate/missing IDs, mixed-phase scans, unordered or excessive ranges and keeps invalid variables explicit',async()=>{
    const p=fixture(),ids=p.scenarios.slice(0,2).map(s=>s.scenarioId);for(const req of [{scenarioIds:[ids[0],ids[0]]},{scenarioIds:[ids[0],'missing']},request(ids,5,3),request(ids,1,MAX_COMPARISON_ANALYSES)])expect((await compareScenarios(p.scenarios,p.assetSnapshots,req as ScenarioComparisonRequest)).status).toBe('unavailable');
    expect(ScenarioComparisonRequest.safeParse({scenarioIds:ids,scan:{variable:{kind:'workload',field:'steps'},searchRange:{min:1,max:2}}}).success).toBe(false);
    const second=p.scenarios[1];if(!second)throw Error();second.workload={kind:'decode',batchSize:1,queryTokensPerRequest:1,contextTokensPerRequest:0,steps:1};expect((await compareScenarios(p.scenarios,p.assetSnapshots,request(ids))).status).toBe('unavailable');second.workload={kind:'prefill',batchSize:1,queryTokensPerRequest:1,pastTokensPerRequest:0};const r=report(await compareScenarios(p.scenarios,p.assetSnapshots,{scenarioIds:ids,scan:{variable:{kind:'parameter',parameterKey:'absent'},searchRange:{min:1,max:2}}}));expect(r.entries.every(e=>e.scan?.status==='unavailable')).toBe(true);expect(r.pairs[0]?.knownPoints).toBe(0);
  });
  it('keeps completed cancellation evidence and snapshots inputs before any awaited work',async()=>{
    const p=fixture(),ids=p.scenarios.slice(0,2).map(s=>s.scenarioId);let cancelled=false,changed=false;
    const r=report(await compareScenarios(p.scenarios,p.assetSnapshots,request(ids),{isCancelled:()=>cancelled,onProgress:n=>{if(n>=4)cancelled=true;},yieldControl:async()=>{if(!changed){changed=true;const s=p.scenarios[0];if(s)s.name='Edited later';p.assetSnapshots.length=0;}}}));expect(r.completion).toBe('cancelled');expect(r.entries[0]?.scenario.name).toBe('Linear A');expect(r.assets.length).toBeGreaterThan(0);expect(r.pairs).toEqual([]);expect(r.entries[0]?.scan?.status==='available'?r.entries[0].scan.result.completion:undefined).toBe('cancelled');expect(r.entries[0]?.scan?.status==='available'?r.entries[0].scan.result.capacityStatus.kind:undefined).toBe('unavailable');
  });
  it('records absent/null, escaped keys and list changes; editorial names alone do not create differences',async()=>{
    expect(comparisonInputChanges({a:null,'x/y':1,list:[1,2]},{'x/y':2,list:[1]})).toEqual([{path:'/a',before:null},{path:'/list/1',before:2},{path:'/x~1y',before:1,after:2}]);const p=fixture(),s=p.scenarios[0];if(!s)throw Error();const copy=Scenario.parse({...s,scenarioId:'copy',name:'Different name'});const r=report(await compareScenarios([s,copy],p.assetSnapshots,{scenarioIds:[s.scenarioId,copy.scenarioId]}));expect(r.entries[1]?.changes).toEqual([]);
  });
  it('rejects forged complete coverage, duplicate pairs, wrong hashes and unsupported crossing events',async()=>{
    const p=fixture(),r=report(await compareScenarios(p.scenarios,p.assetSnapshots,request(p.scenarios.slice(0,2).map(s=>s.scenarioId))));expect(validateScenarioComparison(r)).toEqual([]);
    for(const mutate of [(v:typeof r)=>{const p=v.pairs[0];if(p)p.knownPoints=9;},(v:typeof r)=>{const p=v.pairs[0];if(p)p.crossings=[{kind:'ordering_change',lower:3,upper:4}];},(v:typeof r)=>{v.pairs.push(...v.pairs);},(v:typeof r)=>{v.entries.pop();},(v:typeof r)=>{const e=v.entries[0];if(e?.scan?.status==='available')e.scan.result.baseInputHash='wrong';}]){const next=structuredClone(r);mutate(next);expect(validateScenarioComparison(next).length).toBeGreaterThan(0);}
  });
  it('keeps logical useful work separate from replicated physical execution and preserves missing communication HBM in the comparison table',async()=>{
    const a=ProjectDocument.parse(JSON.parse(readFileSync('examples/gqa/tp-heads-project.json','utf8')) as unknown),b=ProjectDocument.parse(JSON.parse(readFileSync('examples/gqa/replicated-project.json','utf8')) as unknown),left=a.scenarios[0],right=b.scenarios[0];if(!left||!right)throw Error();right.scenarioId='replicated-copy';const assets=[...new Map([...a.assetSnapshots,...b.assetSnapshots].map(v=>[v.assetId+'@'+v.revision,v])).values()];const r=report(await compareScenarios([left,right],assets,{scenarioIds:[left.scenarioId,right.scenarioId]})),rows=comparisonRows(r);expect(rows.find(r=>r.label.startsWith('模型有效 float matrix'))?.values).toEqual([480,480]);expect(rows.find(r=>r.label.startsWith('物理执行 float matrix'))?.values).toEqual([480,960]);expect(rows.find(r=>r.key==='hbm')?.values[0]).toBeUndefined();expect(rows.some(r=>r.key.startsWith('send:'))).toBe(true);
  });
});
