import { it,expect } from 'vitest';
import { MeasurementRecord,type MeasurementComparisonAttempt,type MetricValue } from '@model-analyser/contracts';
import { analyzeScenario,compareMeasurement } from '@model-analyser/core';
import { c01Project } from './model-fixtures.js';
const number=(v:MetricValue|undefined)=>{if(v?.status!=='available')throw Error('Missing metric');return v.quantity.value;};
const available=(attempt:MeasurementComparisonAttempt)=>{expect(attempt.status).toBe('available');if(attempt.status!=='available')throw Error();return attempt.comparison;};
async function setup(){const p=c01Project(),scenario=p.scenarios[0];if(!scenario)throw Error();const analysis=await analyzeScenario(scenario,p.assetSnapshots);if(analysis.status!=='available')throw Error(JSON.stringify(analysis.diagnostics));const original=p.measurements[0];if(!original)throw Error();const measurement=MeasurementRecord.parse({...original,inputHash:analysis.result.inputHash});return {scenario,assets:p.assetSnapshots,result:analysis.result,measurement};}
it('C01 MFU is 20.48% and estimated MBU is 89.6%, with a separate measurement hash',async()=>{
  const {scenario,assets,result,measurement}=await setup();const c=available(await compareMeasurement(measurement,scenario,result,assets));expect(number(c.mfu[0]?.value)).toBeCloseTo(0.2048,12);expect(number(c.mbu)).toBeCloseTo(0.896,12);expect(c.mbuBasis).toBe('estimated_hbm');expect(c.measurementHash).toMatch(/^[a-f0-9]{64}$/);expect(c.inputHash).toBe(result.inputHash);
  measurement.time={kind:'single',seconds:10};const changed=available(await compareMeasurement(measurement,scenario,result,assets));expect(changed.measurementHash).not.toBe(c.measurementHash);expect(changed.inputHash).toBe(c.inputHash);
});
it('distinguishes mean, sum and wall span while normalizing interval byte counts once',async()=>{
  const {scenario,assets,result,measurement}=await setup();measurement.count=2;
  for(const time of [{kind:'mean' as const,seconds:5},{kind:'sum' as const,seconds:10},{kind:'span' as const,startSeconds:100,endSeconds:110}]){
    measurement.time=time;measurement.actualBytes={readBytes:768,writeBytes:128,basis:'interval_total'};const c=available(await compareMeasurement(measurement,scenario,result,assets));expect(c.normalizedTime.kind).toBe(time.kind);expect(c.normalizedTime.perCallEquivalentSeconds).toBe(5);expect(number(c.mbu)).toBeCloseTo(0.896,12);expect(c.mbuBasis).toBe('measured_hbm');
  }
});
it('never maps a model-only measurement onto subnodes or an unbound/old input version',async()=>{
  const {scenario,assets,result,measurement}=await setup();delete measurement.inputHash;expect((await compareMeasurement(measurement,scenario,result,assets)).status).toBe('unavailable');measurement.inputHash='older';expect((await compareMeasurement(measurement,scenario,result,assets)).status).toBe('unavailable');
  measurement.inputHash=result.inputHash;measurement.target={kind:'node',nodeId:result.nodes[0]?.nodeId??(()=>{throw Error();})()};const c=available(await compareMeasurement(measurement,scenario,result,assets));expect(c.scope.target.kind).toBe('node');
  measurement.phase='prefill';expect((await compareMeasurement(measurement,scenario,result,assets)).status).toBe('unavailable');
});
it('does not use effective throughput as peak utilization or clamp utilization over 100%',async()=>{
  const {scenario,assets,result,measurement}=await setup();measurement.time={kind:'single',seconds:1};const c=available(await compareMeasurement(measurement,scenario,result,assets));expect(number(c.mbu)).toBe(4.48);expect(c.diagnostics.some(d=>d.code==='utilization_above_one')).toBe(true);
  const h=assets.find(a=>a.definition.kind==='hardware');if(h?.definition.kind!=='hardware')throw Error();h.definition.hardware.computeCapabilities.forEach(cap=>cap.kind='effective');const recomputed=await analyzeScenario(scenario,assets);if(recomputed.status!=='available')throw Error();measurement.inputHash=recomputed.result.inputHash;const missing=available(await compareMeasurement(measurement,scenario,recomputed.result,assets));expect(missing.mfu[0]?.value.status).toBe('unavailable');expect(missing.diagnostics.some(d=>d.code==='missing_peak_capability')).toBe(true);
});
it('does not turn utilization underflow into a measured zero',async()=>{
  const {scenario,assets,measurement}=await setup(),hardware=assets.find(a=>a.definition.kind==='hardware');if(hardware?.definition.kind!=='hardware'||!hardware.definition.hardware.computeCapabilities[0])throw Error();hardware.definition.hardware.computeCapabilities[0].operationsPerSecond=1e308;
  const report=await analyzeScenario(scenario,assets);if(report.status!=='available')throw Error();measurement.inputHash=report.result.inputHash;measurement.time={kind:'single',seconds:1e308};
  const c=available(await compareMeasurement(measurement,scenario,report.result,assets));expect(c.mfu[0]?.value.status).toBe('unavailable');expect(c.diagnostics.some(d=>d.code==='numeric_overflow')).toBe(true);
});
