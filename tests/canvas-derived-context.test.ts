import { describe,it,expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { analyzeScenario,compareMeasurement } from '@model-analyser/core';
import { ProjectDocument,NodeId,type AnalysisResult } from '@model-analyser/contracts';
import { runMeasurementComparisons,acceptComparisonMessage,type MeasurementComparisonMessage } from '../apps/web/src/measurement-comparison-task.js';
import { buildManualMeasurement,emptyManualMeasurement,manualFrame } from '../apps/web/src/manual-measurement.js';
import { timelineContext,inTimelineContext } from '../apps/web/src/timeline-context.js';
import { Timeline } from '../apps/web/src/timeline-view.js';
import { SerialExecutionView } from '../apps/web/src/serial-execution-view.js';
import { resolveSourceSelection } from '../apps/web/src/cost-source-view.js';
import type { AnalysisFocus } from '../apps/web/src/analysis-focus.js';
import { c01Project,echo } from './model-fixtures.js';
import { makeDecodeProject } from '../scripts/decode-project.js';
import { makeFusedProject } from '../scripts/fused-project.js';
import { makeStateProject } from '../scripts/state-project.js';
import { makeStreamProject } from '../scripts/stream-project.js';
async function setup(p=c01Project()){const s=p.scenarios[0]!,a=await analyzeScenario(s,p.assetSnapshots);if(a.status!=='available')throw Error(JSON.stringify(a));return {p,s,r:a.result};}
const focus=(id:string,kind:'node'|'module'='node'):AnalysisFocus=>({key:kind+id,label:id,target:{kind,nodeId:NodeId.parse(id)}});
describe('background measurement comparison protocol',()=>{
  it('matches existing math for ordinary, shared, distributed and exact growing-decode calls',async()=>{
    for(const p of [c01Project(),makeStateProject('shared'),ProjectDocument.parse(JSON.parse(readFileSync('examples/computed/serial-gather-project.json','utf8'))),makeDecodeProject(c01Project())]){
      const {s,r}=await setup(p),frame=manualFrame(r,s,r.decode?'2':'all'),record=buildManualMeasurement({...emptyManualMeasurement(),step:r.decode?'2':'all',seconds:'5'},{kind:'model'},s,r,'worker-record',frame.result.scope.deviceIds),messages:MeasurementComparisonMessage[]=[];
      await runMeasurementComparisons({scenario:s,assets:p.assetSnapshots,result:r,records:[record]},message=>messages.push(message));
      expect(messages).toEqual([{kind:'item',index:0,id:record.measurementId,attempt:await compareMeasurement(record,frame.scenario,frame.result,p.assetSnapshots)},{kind:'complete',count:1}]);
    }
  });
  it('preserves stale-input rejection, page order and the exact twenty-record limit',async()=>{
    const {p,s,r}=await setup(),records=Array.from({length:20},(_,i)=>({...buildManualMeasurement({...emptyManualMeasurement(),seconds:'5'},{kind:'model'},s,r,'record-'+i,r.scope.deviceIds),...(i===1?{inputHash:'stale-input'}:{})})),messages:MeasurementComparisonMessage[]=[];
    await runMeasurementComparisons({scenario:s,assets:p.assetSnapshots,result:r,records},message=>messages.push(message));
    expect(messages.filter(m=>m.kind==='item').map(m=>m.id)).toEqual(records.map(r=>r.measurementId));expect(messages[1]).toMatchObject({kind:'item',attempt:{status:'unavailable'}});expect(messages.at(-1)).toEqual({kind:'complete',count:20});
    await expect(runMeasurementComparisons({scenario:s,assets:p.assetSnapshots,result:r,records:[...records,{...records[0],measurementId:'twenty-one'}]},()=>{throw Error('must not emit');})).rejects.toThrow();
    await expect(runMeasurementComparisons({scenario:s,assets:p.assetSnapshots,result:r,records:[records[0],records[0]]},()=>{throw Error('must not emit');})).rejects.toThrow();
  });
  it('rejects incomplete, reordered, duplicate and wrong-identity replies before presenting a completed page',async()=>{
    const {p,s,r}=await setup(),record=buildManualMeasurement({...emptyManualMeasurement(),seconds:'5'},{kind:'model'},s,r,'wanted',r.scope.deviceIds),attempt=await compareMeasurement(record,s,r,p.assetSnapshots),item={kind:'item',index:0,id:'wanted',attempt};
    const page=acceptComparisonMessage(['wanted'],[],item);expect(page.complete).toBe(false);expect(acceptComparisonMessage(['wanted'],page.items,{kind:'complete',count:1}).complete).toBe(true);
    expect(()=>acceptComparisonMessage(['wanted'],[],{kind:'complete',count:1})).toThrow();expect(()=>acceptComparisonMessage(['wanted'],[],{...item,index:1})).toThrow();expect(()=>acceptComparisonMessage(['wanted'],page.items,item)).toThrow();expect(()=>acceptComparisonMessage(['other'],[],{...item,id:'other'})).toThrow();expect(()=>acceptComparisonMessage(['wanted'],[],{kind:'error',message:'worker failed'})).toThrow('worker failed');
  });
});
describe('time bars keep actual execution membership and global time',()=>{
  it('filters an exact repeated module or leaf, never a missing target or unrelated text match',async()=>{
    const f=echo('chain'),p=c01Project();p.assetSnapshots=f.assets;p.scenarios=[f.scenario];const {r}=await setup(p),module=timelineContext(r,focus('block','module')),leaf=timelineContext(r,focus('block[1]'));
    expect(r.schedule.filter(e=>inTimelineContext(module,e.nodeId)).map(e=>e.nodeId)).toEqual(['block[0]','block[1]','block[2]']);expect(r.schedule.filter(e=>inTimelineContext(leaf,e.nodeId)).map(e=>e.nodeId)).toEqual(['block[1]']);
    const html=renderToStaticMarkup(createElement(Timeline,{result:r,focus:focus('block[1]')}));expect(html).toContain('data-timeline-node="block[1]"');expect(html).not.toContain('data-timeline-node="block[0]"');expect(html).toContain('x="283.3333333333333"');expect(html).toContain('3 s');
    const missing=timelineContext(r,focus('missing'));expect(missing.reason).toContain('不会自动');expect(r.schedule.some(e=>inTimelineContext(missing,e.nodeId))).toBe(false);
  });
  it('includes a complete atomic fusion execution unit when its mathematical member is selected',async()=>{
    const {r}=await setup(makeFusedProject(c01Project())),member=timelineContext(r,focus('A')),group=r.fusions![0]!.evaluation.application.nodeId;expect(member.atomic).toBe(true);expect(r.schedule.filter(e=>inTimelineContext(member,e.nodeId)).map(e=>e.nodeId)).toEqual([group]);expect(timelineContext(r,focus(group)).atomic).toBe(false);
  });
  it('resolves each decode step independently and never reuses another step membership',async()=>{
    const {r}=await setup(makeDecodeProject(c01Project())),id=r.decode!.steps[0]!.result.nodes[0]!.nodeId,changed:AnalysisResult=structuredClone(r);changed.decode!.steps[2]!.result.nodes=[];
    const context=timelineContext(changed,focus(id));expect(inTimelineContext(context,id,0)).toBe(true);expect(inTimelineContext(context,id,2)).toBe(false);expect(inTimelineContext(context,id,99)).toBe(false);expect(context.missingSteps).toEqual([2]);
  });
  it('preserves multi-stream makespan, original ordinal and per-device full-model memory',async()=>{
    const {r}=await setup(makeStreamProject(c01Project())),layout=r.distributed?.layout;if(!layout)throw Error();const html=renderToStaticMarkup(createElement(SerialExecutionView,{result:layout,analysis:r,focus:focus('B')}));expect(html).toContain('data-execution-node="B"');expect(html).not.toContain('data-execution-node="A"');expect(html).toContain('3 ·');expect(html).toContain('6.5 ms');expect(html).toContain('每设备生命周期峰值');expect(html).toContain('全局耗时');
  });
});
describe('exact metric source requests',()=>{
  it('keeps missing steps, targets and metric IDs unavailable rather than selecting a nearby value',async()=>{
    const {r}=await setup(makeDecodeProject(c01Project()));expect(resolveSourceSelection(r,'9','model','seconds')).toMatchObject({report:undefined,metric:undefined,problem:expect.stringContaining('步骤不存在')});expect(resolveSourceSelection(r,'aggregate','node:missing','seconds')).toMatchObject({target:undefined,metric:undefined,problem:expect.stringContaining('范围不存在')});expect(resolveSourceSelection(r,'aggregate','model','useful:999')).toMatchObject({metric:undefined,problem:expect.stringContaining('指标不存在')});
    const exact=resolveSourceSelection(r,'2','model','seconds');expect(exact.metric?.value).toEqual(r.decode!.steps[2]!.result.total.seconds);expect(exact.scenario?.workload).toMatchObject({contextTokensPerRequest:4});
  });
});
