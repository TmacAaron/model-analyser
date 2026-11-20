import { RooflinePoint,type CostResult,type CostDefinition,type HardwareDefinition } from '@model-analyser/contracts';
import { canonical } from '../../contracts/src/validation.js';
import { MetricFactory,type MetricForUnit } from './metrics.js';

export function rooflinePoints(cost:CostResult,definition:CostDefinition,hardware:HardwareDefinition,metrics:MetricFactory):ReturnType<typeof RooflinePoint.parse>[] {
  const traffic=cost.hbmBytes.status==='available'?cost.hbmBytes:metrics.sum([cost.logicalReadBytes,cost.logicalWriteBytes],'byte');
  const trafficBasis=cost.hbmBytes.status==='available'?'estimated_hbm':'logical';
  const timing=definition.timing,computeEfficiency=timing.kind==='roofline_bound'?timing.computeEfficiency:1,memoryEfficiency=timing.kind==='roofline_bound'?timing.memoryEfficiency:1;
  return cost.compute.map(segment=>{
    const operations=segment.executedOperations,matched=hardware.computeCapabilities.filter(c=>canonical(c.computeClass)===canonical(segment.computeClass)),compute=matched[0],memories=hardware.memoryCapabilities.filter(m=>m.key==='hbm'),memory=memories[0];
    let intensity:ReturnType<typeof RooflinePoint.parse>['arithmeticIntensity'];
    if(operations.status!=='available'||traffic.status!=='available')intensity={status:'unavailable',diagnosticIds:[...new Set([...operations.diagnosticIds,...traffic.diagnosticIds])]};
    else if(traffic.quantity.value===0)intensity=metrics.unavailable('zero_traffic','零流量的算术强度无法用有限 operation/byte 表示');
    else {const ratio=operations.quantity.value/traffic.quantity.value;intensity=Number.isFinite(ratio)?{status:'available',operationsPerByte:ratio}:metrics.unavailable('numeric_overflow','算术强度溢出');}
    let roofPerformance:MetricForUnit<'operation_per_second'>;
    const computeCeiling=matched.length!==1||!compute?metrics.unavailable('missing_compute_capability','Roofline 缺少唯一匹配的计算能力'):compute.kind==='effective'&&computeEfficiency!==1?metrics.unavailable('invalid_efficiency','有效计算能力不能再次折减'):metrics.available(compute.operationsPerSecond*(compute.kind==='peak'?computeEfficiency:1),'operation_per_second',compute.kind==='effective'?'estimated':'theoretical');
    const memoryBandwidth=memories.length!==1||!memory?metrics.unavailable('missing_memory_capability','Roofline 缺少唯一 hbm 带宽能力'):memory.kind==='effective'&&memoryEfficiency!==1?metrics.unavailable('invalid_efficiency','有效内存能力不能再次折减'):metrics.available(memory.bytesPerSecond*(memory.kind==='peak'?memoryEfficiency:1),'byte_per_second',memory.kind==='effective'?'estimated':'theoretical');
    if(computeCeiling.status==='unavailable')roofPerformance=computeCeiling;
    else if(traffic.status==='available'&&traffic.quantity.value===0)roofPerformance=computeCeiling;
    else if(intensity.status==='unavailable')roofPerformance=intensity;
    else if(memoryBandwidth.status==='unavailable')roofPerformance=memoryBandwidth;
    else roofPerformance=metrics.available(Math.min(computeCeiling.quantity.value,memoryBandwidth.quantity.value*intensity.operationsPerByte),'operation_per_second',computeCeiling.basis==='estimated'||memoryBandwidth.basis==='estimated'?'estimated':'theoretical');
    let actualOrPredictedPerformance:MetricForUnit<'operation_per_second'>;
    if(operations.status==='unavailable')actualOrPredictedPerformance=operations;
    else if(cost.seconds.status==='unavailable')actualOrPredictedPerformance=cost.seconds;
    else if(cost.seconds.quantity.value===0)actualOrPredictedPerformance=metrics.unavailable('zero_seconds','零耗时不能作为吞吐率分母');
    else actualOrPredictedPerformance=metrics.available(operations.quantity.value/cost.seconds.quantity.value,'operation_per_second','estimated');
    return {scope:cost.scope,computeClass:segment.computeClass,operations,trafficBytes:traffic,arithmeticIntensity:intensity,computeCeiling,memoryBandwidth,roofPerformance,actualOrPredictedPerformance,trafficBasis};
  });
}
