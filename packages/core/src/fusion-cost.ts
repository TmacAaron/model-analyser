import { FusionEvaluation,CostResult,ComputeCostResult,metricFor,type ResolvedGraph,type Scenario,type AssetDocument,type ParallelResolution,type Diagnostic,type DeviceId,type MetricValue,type DistributedCosts,type LocalDeviceCost,type MetricScope } from '@model-analyser/contracts';
import { MetricFactory,aggregateCosts } from './metrics.js';
import { evaluateCost,evaluateAggregateTiming } from './cost.js';
import { evaluateDistributedCosts } from './distributed-cost.js';
import { numericValue } from './storage.js';
import { canonical } from '../../contracts/src/validation.js';
import {observeTiming} from './timing-observer.js';
import type {FusionPlanObserver} from './fusion-observation.js';

type Layouts=Pick<ParallelResolution,'tensorLayouts'|'storageLayouts'|'storageAllocations'>;
export function evaluateFusions(resolved:ResolvedGraph,scenario:Scenario,assets:AssetDocument[],layouts:Layouts,localCosts:DistributedCosts,diagnostics:Diagnostic[],singleDeviceBaseline=false,observer?:FusionPlanObserver['fusion']):ParallelResolution['fusions']{
  const provenance={assetRefs:resolved.assetRefs,formulaRefs:resolved.assetRefs.filter(r=>r.kind==='formula'),parameterSources:resolved.parameters.map(p=>({parameterKey:p.nodeId+':'+p.parameterKey,source:p.source.kind})),assumptions:[
    'Fusion retains mathematical members and explicitly declared extra cost once. Eliminated materialization removes only validated internal storage accesses.',
    'sum_members preserves the original global serial member barriers and adds the extra-cost barrier. Every participating device reserves the entire fused span, including waits.',
    'override defines the whole fused duration; member and extra timing are not added again. Member timing components are not separately measurable intervals.',
    'All retained member and extra physical buffers are conservatively live throughout the atomic group; no implicit buffer reuse. Internal mathematical memory order is recorded without fabricating seconds.',...scenario.parallelPlan.assumptions,
  ]},metrics=new MetricFactory(diagnostics,provenance,scenario.scenarioId,'fusion-cost'),allDevices=scenario.deviceTopology.devices.map(d=>d.deviceId),byNode=new Map(localCosts.nodes.map(n=>[n.nodeId,n]));
  const maximum=(values:MetricValue[])=>{const missing=values.filter(v=>v.status==='unavailable');return missing.length?{status:'unavailable' as const,diagnosticIds:[...new Set(missing.flatMap(v=>v.diagnosticIds))]}:metrics.available(Math.max(0,...values.flatMap(v=>v.status==='available'?[v.quantity.value]:[])),'second');};
  function sumSeconds(values:MetricValue[]){const sum=metrics.sum(values,'second');if(sum.status==='unavailable')return sum;let time=0;for(const value of values)if(value.status==='available'){const next=time+value.quantity.value;if(value.quantity.value>0&&next===time)return metrics.unavailable('numeric_overflow','融合累计时间不能吞掉非零步骤');time=next;}return sum;}
  return resolved.fusionApplications.map(application=>{
    const members=application.memberNodeIds.map(id=>byNode.get(id)),memberDevices=[...new Set(members.flatMap(n=>n?.placement.kind==='placed'?n.placement.perDevice.map(d=>d.deviceId):n?.placement.kind==='no_work'?layouts.tensorLayouts.filter(l=>l.nodeId===n.nodeId).flatMap(l=>l.partition.placements.map(p=>p.deviceId)):[]))];let unknown=members.some(n=>!n||n.placement.kind==='unplaced');
    const resourceEmpty=!application.extraCost.compute.length&&!application.extraCost.memoryAccess.length&&!application.extraCost.temporaryStorageIds.length,extraPerDevice:LocalDeviceCost[]=[];
    const capture=observer?.nodeId===application.nodeId?observer:undefined;
    if(resourceEmpty){
      const zeroTime=application.extraCost.timing.kind==='fixed'&&application.extraCost.timing.seconds===0;
      const devices=memberDevices.length?memberDevices:zeroTime?[]:allDevices;
      for(const deviceId of devices){
        const scope:MetricScope={phase:resolved.phase,target:{kind:'node',nodeId:application.extraNodeId},deviceIds:[deviceId],aggregation:'per_device'};
        const device=scenario.deviceTopology.devices.find(d=>d.deviceId===deviceId);
        const hw=assets.find(a=>a.assetId===device?.hardware.assetId&&a.revision===device?.hardware.revision);
        const hardware=hw?.definition.kind==='hardware'?hw.definition.hardware:undefined;
        const context={symbols:{},assets,provenance},extraCapture=capture?.extra?.deviceId===deviceId&&capture.extra.nodeId===application.extraNodeId?capture.extra:undefined;
        const timed=extraCapture?.timing&&application.extraCost.timing.kind==='roofline_bound'?observeTiming(emit=>evaluateCost(application.extraCost,scope,context,hardware,emit)):undefined;
        const evaluated=timed?.evaluation??evaluateCost(application.extraCost,scope,context,hardware);
        diagnostics.push(...evaluated.diagnostics);
        const outcome={status:'available' as const,bindings:[],cost:evaluated.cost};
        extraPerDevice.push({deviceId,outcome});
        if(extraCapture&&device)extraCapture.record(structuredClone({rule:undefined,singleDeviceBaseline,devices,outcome,effective:application.extraCost,symbols:{},hardware:device.hardware,accesses:[],overrides:[],...(timed?{timing:timed.dag}:{})}));
      }
    }
    else if(singleDeviceBaseline||application.extraLocalCost){const extraNode={nodeId:application.extraNodeId,name:'Fusion extra cost',phases:[resolved.phase],portBindings:[],stateBindings:[],body:{kind:'opaque' as const,cost:application.extraCost,...(application.extraLocalCost?{localCost:application.extraLocalCost.rule}:{}),inputs:[],outputs:[]}},context=application.extraLocalCost?.contextNodeId,extraLayouts={...layouts,tensorLayouts:[...layouts.tensorLayouts,...layouts.tensorLayouts.filter(l=>l.nodeId===context).map(l=>({...l,nodeId:application.extraNodeId}))],storageLayouts:[...layouts.storageLayouts,...layouts.storageLayouts.filter(l=>l.nodeId===context).map(l=>({...l,nodeId:application.extraNodeId}))]},extraResolved={...resolved,graph:{...resolved.graph,nodes:[extraNode]},parameters:[...resolved.parameters,...resolved.parameters.filter(p=>context&&(p.nodeId==='$model'||context===p.nodeId||context.startsWith(p.nodeId+'/')||context.startsWith(p.nodeId+'['))).map(p=>({...p,nodeId:application.extraNodeId}))]},evaluated=evaluateDistributedCosts(extraResolved,scenario,assets,extraLayouts,diagnostics,singleDeviceBaseline,capture?.extra).nodes[0];if(evaluated?.placement.kind==='placed')extraPerDevice.push(...evaluated.placement.perDevice);else if(evaluated?.placement.kind==='unplaced'){unknown=true;for(const deviceId of allDevices)extraPerDevice.push({deviceId,outcome:{status:'unavailable',diagnosticIds:evaluated.placement.diagnosticIds}});}}
    else {unknown=true;const missing=metrics.unavailable('missing_fusion_extra_local_rule','多设备非零融合附加成本需声明 extraLocalCost，不能按设备数平分');for(const deviceId of allDevices)extraPerDevice.push({deviceId,outcome:missing});}
    const devices=[...new Set([...memberDevices,...extraPerDevice.map(d=>d.deviceId)])],barriers=members.map(n=>n?.placement.kind==='placed'?maximum(n.placement.perDevice.map(d=>d.outcome.status==='available'?d.outcome.cost.seconds:d.outcome)):n?.placement.kind==='no_work'?metrics.available(0,'second'):metrics.unavailable('unknown_fusion_participation','融合成员放置或方程缺项')),extraBarrier=maximum(extraPerDevice.map(d=>d.outcome.status==='available'?d.outcome.cost.seconds:d.outcome)),sumDuration=sumSeconds([...barriers,extraBarrier]);
    const perDevice:LocalDeviceCost[]=(unknown?allDevices:devices).map(deviceId=>{const scope:MetricScope={phase:resolved.phase,target:{kind:'node',nodeId:application.nodeId},deviceIds:[deviceId],aggregation:'per_device'};if(unknown)return {deviceId,outcome:metrics.unavailable('unknown_fusion_participation','融合参与设备不完整，完整局部组成本不可用')};const costs:CostResult[]=[],missing:MetricValue[]=[],missingClasses:CostResult['compute'][number]['computeClass'][]=[];
      for(const member of members){if(member?.placement.kind!=='placed')continue;const d=member.placement.perDevice.find(d=>d.deviceId===deviceId);if(d?.outcome.status==='available')costs.push(d.outcome.cost);else if(d){missing.push(d.outcome);const body=resolved.graph.nodes.find(n=>n.nodeId===member.nodeId)?.body;if(body?.kind==='opaque')missingClasses.push(...(singleDeviceBaseline?body.cost:body.localCost?.cost??body.cost).compute.map(c=>c.computeClass));}}const extra=extraPerDevice.find(d=>d.deviceId===deviceId);if(extra?.outcome.status==='available')costs.push(extra.outcome.cost);else if(extra){missing.push(extra.outcome);missingClasses.push(...(singleDeviceBaseline?application.extraCost:application.extraLocalCost?.rule.cost??application.extraCost).compute.map(c=>c.computeClass));}if(missing.length){const unavailable={status:'unavailable' as const,diagnosticIds:[...new Set(missing.flatMap(m=>m.diagnosticIds))]},classes=[...new Map(missingClasses.map(c=>[canonical(c),c])).values()];costs.push(CostResult.parse({scope,compute:classes.map(computeClass=>({computeClass,usefulOperations:unavailable,executedOperations:unavailable})),logicalReadBytes:unavailable,logicalWriteBytes:unavailable,hbmBytes:unavailable,communications:[],seconds:unavailable}));}
      const cost=aggregateCosts(costs,scope,metrics);
      if(application.timeStrategy.kind==='sum_members')cost.seconds=metricFor('second').parse(sumDuration);
      else{
        const device=scenario.deviceTopology.devices.find(d=>d.deviceId===deviceId);
        const hw=assets.find(a=>a.assetId===device?.hardware.assetId&&a.revision===device?.hardware.revision);
        const hardware=hw?.definition.kind==='hardware'?hw.definition.hardware:undefined;
        const timing=application.timeStrategy.timing,context={symbols:{},assets,provenance};
        const trace=capture?.timing?.deviceId===deviceId&&timing.kind==='roofline_bound'?capture.timing:undefined;
        const observed=trace?observeTiming(emit=>evaluateAggregateTiming(cost,timing,context,hardware,emit)):undefined;
        const timed=observed?.evaluation??evaluateAggregateTiming(cost,timing,context,hardware);
        if(observed)trace?.record(observed.dag);
        cost.seconds=metricFor('second').parse(timed.seconds);diagnostics.push(...timed.diagnostics);
      }
      return {deviceId,outcome:{status:'available',bindings:[],cost}};
    });
    const classes=new Map<string,typeof application.extraCost.compute>();for(const c of application.extraCost.compute){const key=canonical(c.computeClass);classes.set(key,[...(classes.get(key)??[]),c]);}const logicalExtraCompute=[...classes.values()].map(cs=>{const c=cs[0];if(!c)throw Error('Empty fusion compute class');const value=(key:'usefulOperations'|'executedOperations')=>metrics.sum(cs.map(s=>{try{return metrics.available(numericValue(s[key],'operation',{symbols:{},assets}),'operation');}catch{return metrics.unavailable('invalid_fusion_cost','融合附加数学成本不可计算');}}),'operation');return ComputeCostResult.parse({computeClass:c.computeClass,usefulOperations:value('usefulOperations'),executedOperations:value('executedOperations')});});
    return FusionEvaluation.parse({application,participation:unknown?'unknown':'known',perDevice,extraPerDevice,logicalExtraCompute});
  });
}




