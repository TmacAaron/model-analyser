import { describe,it,expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { ProjectDocument,Scenario,type AnalysisResult,type MetricValue,type ScenarioComparisonResult } from '@model-analyser/contracts';
import { compareScenarios,computeInputHash,stableStringify } from '@model-analyser/core';
import { c01Project } from './model-fixtures.js';
import { makeMetricSourceProject,makeMetricCommunicationProject } from '../scripts/metric-source-project.js';
import { makeDecodeProject } from '../scripts/decode-project.js';
import { makeLocalGemmProject } from '../scripts/local-gemm-project.js';
import { comparisonRows,comparisonMetricEvidence,comparisonDeltaEvidence } from '../apps/web/src/comparison-metrics.js';
import { modelComputeFrame } from '../apps/web/src/compute-source.js';
import { ModelComputeSummary } from '../apps/web/src/model-compute-summary.js';
import { ComparisonMetricSource } from '../apps/web/src/comparison-source-view.js';

async function comparison(p:ProjectDocument){const attempt=await compareScenarios(p.scenarios,p.assetSnapshots,{scenarioIds:p.scenarios.map(s=>s.scenarioId)});if(attempt.status!=='available')throw Error(JSON.stringify(attempt));return attempt.result;}
function result(r:ScenarioComparisonResult,i=0):AnalysisResult{const a=r.entries[i]?.analysis;if(a?.status!=='available')throw Error('Available entry required');return a.result;}
function number(m:MetricValue){if(m.status!=='available')throw Error('Available metric required');return m.quantity.value;}
function duplicate(p:ProjectDocument){const s=p.scenarios[0];if(!s)throw Error();p.scenarios.push(Scenario.parse({...s,scenarioId:s.scenarioId+':copy',name:'Independent copy'}));return p;}
describe('exact comparison and model compute sources',()=>{
  it('offers logical-only classes in the comparison even when no device equation reports that precision',async()=>{
    const p=duplicate(makeLocalGemmProject(c01Project())),asset=p.assetSnapshots.find(a=>a.definition.kind==='operator');
    if(asset?.definition.kind!=='operator')throw Error('Missing fixture operator');
    const base=asset.definition.operator.cost.compute[0];if(!base)throw Error('Missing fixture compute');
    const logicalClass={...base.computeClass,multiplyDtype:{category:'float' as const,bits:32,format:'fp32'}},work={kind:'literal' as const,quantity:{value:9,unit:'operation' as const}};
    asset.definition.operator.cost.compute.push({segmentId:'logical-only',computeClass:logicalClass,usefulOperations:work,executedOperations:work});
    const r=await comparison(p),key=stableStringify(logicalClass),rows=comparisonRows(r);
    expect(rows.find(row=>row.key==='useful:'+key)?.values).toEqual([9,9]);
    expect(rows.some(row=>row.key==='executed:'+key)).toBe(false);
    expect(comparisonMetricEvidence(r,'useful:'+key,1)).toMatchObject({kind:'metric',parts:[{targetId:'logical:model',metric:{quantity:{value:9}}}]});
  });
  it('keeps same-model2s→5s and64B→128B identities, both delta operands and immutable input hashes',async()=>{
    const p=makeMetricSourceProject(c01Project()),before=structuredClone(p),r=await comparison(p);
    expect(p.scenarios[0]?.model).toEqual(p.scenarios[1]?.model);
    expect(comparisonRows(r).find(row=>row.key==='seconds')?.values).toEqual([2,5]);
    expect(comparisonDeltaEvidence(r,'seconds',1)).toEqual({baseline:2,current:5,delta:3,problem:undefined});
    expect(comparisonRows(r).find(row=>row.key==='capacity:gpu0')?.values).toEqual([64,128]);
    for(const i of [0,1]){const proof=comparisonMetricEvidence(r,'seconds',i);expect(proof.kind).toBe('metric');if(proof.kind!=='metric')throw Error();expect(proof.parts[0]?.metric).toBe(result(r,i).total.seconds);expect(result(r,i).inputHash).toBe(await computeInputHash(p.scenarios[i]!,p.assetSnapshots));}
    expect(p).toEqual(before);
  });
  it('finds the full compute class in each actual array even when class order differs, rather than index0',async()=>{
    const r=await comparison(makeMetricSourceProject(c01Project(),true)),right=result(r,1);right.total.compute.reverse();
    const rows=comparisonRows(r),vector=rows.find(row=>row.label.startsWith('物理执行 float vector'));
    expect(vector?.values).toEqual([3,3]);if(!vector)throw Error();const proof=comparisonMetricEvidence(r,vector.key,1);if(proof.kind!=='metric')throw Error();
    expect(proof.parts[0]?.metricId).toBe('executed:0');expect(proof.parts[0]?.metric).toBe(right.total.compute[0]?.executedOperations);
    const matrix=rows.find(row=>row.label.startsWith('物理执行 float matrix'));if(!matrix)throw Error();const other=comparisonMetricEvidence(r,matrix.key,1);if(other.kind!=='metric')throw Error();expect(other.parts[0]?.metricId).toBe('executed:1');expect(number(other.parts[0]!.metric)).toBe(1280);
  });
  it('opens logical480 operations and replicated physical960 operations as different exact metrics',async()=>{
    const p=ProjectDocument.parse(JSON.parse(readFileSync('examples/gqa/replicated-project.json','utf8')) as unknown),r=await comparison(duplicate(p)),rows=comparisonRows(r),useful=rows.find(row=>row.label.startsWith('模型有效 float matrix')),executed=rows.find(row=>row.label.startsWith('物理执行 float matrix'));
    if(!useful||!executed)throw Error();expect(useful.values).toEqual([480,480]);expect(executed.values).toEqual([960,960]);
    const a=comparisonMetricEvidence(r,useful.key,0),b=comparisonMetricEvidence(r,executed.key,0);if(a.kind!=='metric'||b.kind!=='metric')throw Error();expect(a.parts[0]?.targetId).toMatch(/^logical:/);expect(b.parts[0]?.targetId).toBe('model');expect(number(a.parts[0]!.metric)).toBe(480);expect(number(b.parts[0]!.metric)).toBe(960);
  });
  it('uses actual physical devices despite reversed memory order and group aliases; missing devices never fall back',async()=>{
    const p=duplicate(makeLocalGemmProject(c01Project())),s=p.scenarios[0]!;s.deviceTopology.groups.push({...structuredClone(s.deviceTopology.groups[0]!),groupId:'same-physical-role'});const r=await comparison(p),a=result(r);a.memory.reverse();
    expect(a.memory).toHaveLength(2);for(const [index,m] of a.memory.entries()){if(m.deviceScope.kind!=='per_device')throw Error();const proof=comparisonMetricEvidence(r,'peak:'+m.deviceScope.deviceId,0);if(proof.kind!=='metric')throw Error();expect(proof.parts[0]?.targetId).toBe('memory:'+index);expect(proof.parts[0]?.metric).toBe(m.peakBytes);}
    a.memory=[];expect(comparisonMetricEvidence(r,'peak:gpu0',0).kind).toBe('missing');
  });
  it('sums both real same-group communication events and retains an unavailable event without zero-filling',async()=>{
    const r=await comparison(makeMetricCommunicationProject(c01Project())),a=result(r),proof=comparisonMetricEvidence(r,'send:tp',0);
    expect(proof.kind).toBe('sum');if(proof.kind!=='sum')throw Error();expect(proof.parts).toHaveLength(2);expect(proof.parts.map(p=>p.metricId)).toEqual(['group-send:0','group-send:1']);expect(proof.sum).toBe(128);expect(proof.parts.map(p=>number(p.metric))).toEqual([64,64]);
    const second=a.total.communications[1];if(!second)throw Error();second.groupSendBytes={status:'unavailable',diagnosticIds:[]};const partial=comparisonMetricEvidence(r,'send:tp',0);if(partial.kind!=='sum')throw Error();expect(partial.complete).toBe(false);expect(partial.sum).toBeUndefined();expect(partial.parts).toHaveLength(2);expect(comparisonRows(r).find(row=>row.key==='send:tp')?.values[0]).toBeUndefined();
  });
  it('uses fixed hardware revision/source for capacity and explicitly rejects missing or mismatched proof',async()=>{
    const r=await comparison(makeMetricSourceProject(c01Project())),proof=comparisonMetricEvidence(r,'capacity:gpu0',1);if(proof.kind!=='hardware')throw Error();expect(proof.recordedCapacity).toBe(128);expect(proof.matches).toBe(true);expect(proof.hardwareRef.assetId).toBe('example:hardware:metric-source128');
    r.assets=r.assets.filter(a=>a.assetId!==proof.hardwareRef.assetId);const missing=comparisonMetricEvidence(r,'capacity:gpu0',1);if(missing.kind!=='hardware')throw Error();expect(missing.asset).toBeUndefined();expect(missing.recordedCapacity).toBe(128);expect(missing.matches).toBe(false);
  });
  it('keeps whole-sequence sources separate from third-step values and never labels aggregate parameters as old missing records',async()=>{
    const r=await comparison(duplicate(makeDecodeProject(c01Project()))),a=result(r),frame=modelComputeFrame(a),row=comparisonRows(r).find(row=>row.key==='useful:'+stableStringify(frame.compute[0]?.computeClass));if(!row)throw Error();
    const proof=comparisonMetricEvidence(r,row.key,0);if(proof.kind!=='metric')throw Error();expect(number(proof.parts[0]!.metric)).toBe(12);expect(number(a.decode!.steps[2]!.result.total.compute[0]!.usefulOperations)).toBe(5);expect(proof.parts[0]?.targetId).toBe(frame.targetId);
    const html=renderToStaticMarkup(createElement(ComparisonMetricSource,{selection:{report:r,rowKey:row.key,entryIndex:0,delta:false},onClose:()=>{}}));expect(html).toContain('整个Decode序列汇总');expect(html).toContain('序列汇总涉及不同实际调用');expect(html).not.toContain('此旧结果没有实际参数记录');
  });
  it('keeps unknown classes/modules/entries explicit and cannot create a delta from a missing side',async()=>{
    const r=await comparison(makeMetricSourceProject(c01Project()));for(const [key,i] of [['useful:missing',0],['module-seconds:absent',0],['seconds',-1],['seconds',99]] as const)expect(comparisonMetricEvidence(r,key,i).kind).toBe('missing');
    result(r,1).total.compute=[];const row=comparisonRows(r).find(row=>row.key.startsWith('useful:'));if(!row)throw Error();expect(comparisonMetricEvidence(r,row.key,1).kind).toBe('missing');expect(comparisonDeltaEvidence(r,row.key,1).delta).toBeUndefined();
  });
  it('renders independent class actions and both fixed delta sources without making the count a source action',async()=>{
    const r=await comparison(makeMetricSourceProject(c01Project(),true)),a=result(r),html=renderToStaticMarkup(createElement(ModelComputeSummary,{result:a,onSource:()=>{}}));expect(html).toContain('2 个计算分类');expect(html).toContain('查看有效工作分类 1 来源');expect(html).toContain('查看有效工作分类 2 来源');expect(html).not.toContain('aria-label="查看有效工作量来源"');
    const delta=renderToStaticMarkup(createElement(ComparisonMetricSource,{selection:{report:r,rowKey:'seconds',entryIndex:1,delta:true},onClose:()=>{}}));expect(delta).toContain('5 − 2 = 3 second');expect(delta).toContain('基准指标依据');expect(delta).toContain('当前指标依据');expect(delta).toContain('展开基准公式、参数与假设');expect(delta).toContain('展开当前公式、参数与假设');
  });
});
