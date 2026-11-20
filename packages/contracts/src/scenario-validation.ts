import { type Scenario,type AssetDocument,type Diagnostic,type Quantity } from './index.js';
import { quantizationRuleIssues } from './quantization-validation.js';
import { nativeBindingIssues } from './parallel-bindings.js';

export function validateScenario(scenario:Scenario,assets:AssetDocument[]):Diagnostic[]{
  const issues:Diagnostic[]=[];
  const report=(code:string,message:string,fieldPath:string)=>issues.push({diagnosticId:`${scenario.scenarioId}-validation-${issues.length+1}`,severity:'error',code,message,location:{kind:'scenario',scenarioId:scenario.scenarioId,fieldPath}});
  const unique=(values:string[],path:string)=>{if(new Set(values).size!==values.length)report('duplicate_id','ID 重复',path);};
  const asset=(id:string,revision:number)=>assets.find(a=>a.assetId===id&&a.revision===revision);
  const model=asset(scenario.model.assetId,scenario.model.revision);
  for(const [index,rule] of scenario.quantizationOverrides.entries())for(const issue of quantizationRuleIssues(rule,assets,scenario.model))report(issue.code,issue.message,'quantizationOverrides.'+index+(issue.path?'.'+issue.path:''));
  if(scenario.model.kind!=='model'||model?.definition.kind!=='model')report('reference_kind_mismatch','方案 model 必须引用正式模型','model');
  for(const [i,g]of scenario.fusionGroups.entries())if(g.origin){const source=asset(g.origin.asset.assetId,g.origin.asset.revision);if(!source||source.definition.kind!==g.origin.asset.kind||!source.fusionPresets?.some(p=>p.presetId===g.origin?.presetId))report('invalid_fusion_preset','融合来源修订或预设不存在','fusionGroups.'+i+'.origin');}
  const devices=scenario.deviceTopology.devices,groups=scenario.deviceTopology.groups;
  if(scenario.parallelPlan.nativeBindings)for(const message of nativeBindingIssues(scenario.parallelPlan.nativeBindings,scenario.deviceTopology))report('invalid_native_binding',message,'parallelPlan.nativeBindings');
  unique(devices.map(d=>d.deviceId),'deviceTopology.devices');unique(groups.map(g=>g.groupId),'deviceTopology.groups');
  for(const [i,d] of devices.entries())if(d.hardware.kind!=='hardware'||asset(d.hardware.assetId,d.hardware.revision)?.definition.kind!=='hardware')report('reference_kind_mismatch','设备必须引用硬件修订',`deviceTopology.devices.${i}.hardware`);
  const deviceIds=new Set<string>(devices.map(d=>d.deviceId));
  for(const [i,g] of groups.entries()){
    const path=`deviceTopology.groups.${i}`;unique(g.members,path+'.members');for(const id of g.members)if(!deviceIds.has(id))report('missing_reference',`设备组成员不存在 ${id}`,path);
    if(g.mesh){
      unique(g.mesh.axes.map(a=>a.axisId),path+'.mesh.axes');const size=g.mesh.axes.reduce((n,a)=>n*a.size,1);
      if(!Number.isSafeInteger(size)||size!==g.members.length)report('invalid_distribution','mesh 轴乘积必须等于实际组成员数',path+'.mesh');
      const entries=g.mesh.coordinates;unique(entries.map(c=>c.deviceId),path+'.mesh.coordinates');unique(entries.map(c=>c.coordinates.join(',')),path+'.mesh.coordinates');
      if(entries.length!==g.members.length)report('invalid_distribution','mesh 必须完整映射每个成员',path+'.mesh.coordinates');
      for(const c of entries)if(!g.members.includes(c.deviceId)||c.coordinates.length!==g.mesh.axes.length||c.coordinates.some((v,j)=>v>=(g.mesh?.axes[j]?.size??0)))report('invalid_distribution','mesh 坐标越界/成员不符',path+'.mesh.coordinates');
    }
  }
  unique((scenario.memoryPeakOverrides??[]).map(r=>r.overrideId),'memoryPeakOverrides');
  unique((scenario.modulePeakOverrides??[]).map(r=>r.overrideId),'modulePeakOverrides');
  for(const [i,r] of (scenario.modulePeakOverrides??[]).entries()){
    const path='modulePeakOverrides.'+i;unique(r.phases,path+'.phases');
    if(!r.description.trim())report('invalid_override','模块峰值覆盖必须说明来源/假设',path+'.description');
    if(r.peakBytes.kind==='literal'&&(r.peakBytes.quantity.unit!=='byte'||!Number.isSafeInteger(r.peakBytes.quantity.value)||r.peakBytes.quantity.value<0))report('invalid_override','模块峰值必须为非负安全整数 byte',path+'.peakBytes');
  }
  for(const [i,r] of (scenario.memoryPeakOverrides??[]).entries()){
    const path='memoryPeakOverrides.'+i,t=r.target;
    unique(r.phases,path+'.phases');if(!r.description.trim())report('invalid_override','峰值覆盖必须说明来源/假设',path+'.description');
    if(t.kind==='device'&&!deviceIds.has(t.deviceId)||t.kind==='group'&&!groups.some(g=>g.groupId===t.groupId))report('missing_reference','峰值覆盖目标不存在',path+'.target');
    if(r.peakBytes.kind==='literal'&&(r.peakBytes.quantity.unit!=='byte'||!Number.isSafeInteger(r.peakBytes.quantity.value)||r.peakBytes.quantity.value<0))report('invalid_override','峰值覆盖必须为非负安全整数 byte',path+'.peakBytes');
  }
  for(const phase of ['prefill','decode'] as const)for(const d of devices){
    const applicable=(scenario.memoryPeakOverrides??[]).filter(r=>r.phases.includes(phase)&&(r.target.kind==='device'?r.target.deviceId===d.deviceId:groups.some(g=>r.target.kind==='group'&&g.groupId===r.target.groupId&&g.members.includes(d.deviceId))));
    const specific=applicable.filter(r=>r.target.kind==='device').length+scenario.numericOverrides.filter(o=>o.target.kind==='device'&&o.target.deviceId===d.deviceId&&o.field==='memory_bytes').length;
    if(specific>1||!specific&&applicable.length>1)report('conflicting_peak_override','同一物理设备存在同优先级峰值覆盖：'+d.deviceId+' / '+phase,'memoryPeakOverrides');
  }
  const allowed:Record<Scenario['numericOverrides'][number]['target']['kind'],string[]>={project:['parameter'],scenario:['parameter'],node:['parameter','fixed_seconds','compute_efficiency','memory_efficiency','traffic_bytes','communication_bandwidth','communication_latency'],storage:['memory_bytes'],device:['memory_bytes']};
  const units:Partial<Record<Scenario['numericOverrides'][number]['field'],Quantity['unit']>>={fixed_seconds:'second',compute_efficiency:'ratio',memory_efficiency:'ratio',memory_bytes:'byte',traffic_bytes:'byte',communication_bandwidth:'byte_per_second',communication_latency:'second'};
  for(const [i,override] of scenario.numericOverrides.entries()){
    const path=`numericOverrides.${i}`;
    if(!allowed[override.target.kind].includes(override.field))report('invalid_override','覆盖字段不在该目标白名单',path);
    if((override.field==='parameter')!==(override.parameterKey!==undefined))report('invalid_override','只有参数覆盖必须提供 parameterKey',path);
    if(override.target.kind==='scenario'&&override.target.scenarioId!==scenario.scenarioId)report('missing_reference','方案覆盖指向其他方案',path);
    if(override.target.kind==='device'&&!deviceIds.has(override.target.deviceId))report('missing_reference','覆盖目标设备不存在',path);
    const unit=units[override.field];if(unit!==undefined&&override.value.unit!==unit)report('invalid_unit',`覆盖值需要 ${unit}`,path+'.value');
    if(override.field!=='parameter'&&override.value.value<0)report('invalid_override','成本覆盖不能为负数',path+'.value');
    if(override.field==='compute_efficiency'||override.field==='memory_efficiency')if(override.value.value<=0||override.value.value>1)report('invalid_override','效率范围为 (0,1]',path+'.value');
    if(override.field==='communication_bandwidth'&&override.value.value<=0)report('invalid_override','通信带宽必须为正数',path+'.value');
    if(override.field==='memory_bytes'&&!Number.isSafeInteger(override.value.value))report('invalid_override','精确分配 bytes 必须为安全整数',path+'.value');
    if(override.field==='parameter'&&(override.target.kind==='scenario'||override.target.kind==='project')){
      const parameter=model?.parameters.find(p=>p.key===override.parameterKey);
      if(!parameter)report('missing_reference','覆盖参数不存在',path);
      else if(parameter.unit!==override.value.unit||(parameter.type!=='integer'&&parameter.type!=='number'))report('invalid_unit','覆盖参数类型/单位不符',path);
      else if((parameter.type==='integer'&&!Number.isSafeInteger(override.value.value))||(parameter.min!==undefined&&override.value.value<parameter.min)||(parameter.max!==undefined&&override.value.value>parameter.max))report('invalid_override','参数覆盖值超出声明范围',path);
    }
  }
  const indexedCommunications=scenario.parallelPlan.communications.map((c,index)=>({c,index})).filter(({c})=>!c.placement||c.placement.phases.includes(scenario.workload.kind)),communications=indexedCommunications.map(({c})=>c);
  // Native asset IDs are still local here. Treat them as potential reductions;
  // expansion/layout validation later proves the actual object, instance and group.
  const nativeCommunications:typeof communications=[],seenNative=new Set<string>();function native(a:AssetDocument|undefined):void{if(!a||seenNative.has(a.assetId+'@'+a.revision))return;seenNative.add(a.assetId+'@'+a.revision);if(a.definition.kind!=='model'&&a.definition.kind!=='module')return;for(const n of a.definition.graph.nodes)if(n.phases.includes(scenario.workload.kind)){if(n.body.kind==='collective')nativeCommunications.push(n.body.communication);else if(n.body.kind==='module')native(asset(n.body.asset.assetId,n.body.asset.revision));}}native(model);
  unique(communications.flatMap(c=>c.placement?[c.placement.nodeId]:[]),'parallelPlan.communications.placement.nodeId');
  for(const {index:i,c} of indexedCommunications){
    const path=`parallelPlan.communications.${i}`,group=groups.find(g=>g.groupId===c.groupId);
    if(c.placement){unique(c.placement.afterNodeIds,path+'.placement.afterNodeIds');unique(c.placement.beforeNodeIds,path+'.placement.beforeNodeIds');if([...c.placement.afterNodeIds,...c.placement.beforeNodeIds].includes(c.placement.nodeId))report('dependency_cycle','通信不能依赖自身',path+'.placement');}
    if(!group)report('missing_reference','通信设备组不存在',path);
    if(c.operation==='send_recv'){
      if(c.sourceDeviceId===undefined||c.destinationDeviceId===undefined||c.sourceDeviceId===c.destinationDeviceId||!group?.members.some(id=>id===c.sourceDeviceId)||!group?.members.some(id=>id===c.destinationDeviceId))report('invalid_distribution','send_recv 需不同且在组内的发送/接收设备',path);
    }else if(c.sourceDeviceId!==undefined||c.destinationDeviceId!==undefined)report('invalid_distribution','只有 send_recv 使用单独发送/接收设备字段',path);
    for(const d of [c.source.distribution,c.destination.distribution])if(!groups.some(g=>g.groupId===d.groupId))report('missing_reference','通信端点布局设备组不存在',path);
  }
  for(const [i,a] of scenario.parallelPlan.assignments.entries())for(const distribution of [...a.tensorDistributions,...a.storageDistributions]){
    const d=distribution.distribution,path=`parallelPlan.assignments.${i}`;
    const group=groups.find(g=>g.groupId===d.groupId);if(!group){report('missing_reference','布局设备组不存在',path);continue;}
    if(d.kind==='sharded'){
      unique(d.axes.map(a=>a.tensorAxisId),path+'.axes');
      for(const axis of d.axes)if(!group.mesh?.axes.some(a=>a.axisId===axis.meshAxisId))report('invalid_distribution','分片引用缺失 mesh 轴',path);
      if(d.policy.kind==='explicit')for(const s of d.policy.slices)if(!group.members.includes(s.deviceId)||s.end<=s.start)report('invalid_distribution','切片成员或范围非法',path);
    }
    if(d.kind==='manual'){unique(d.members.map(m=>m.deviceId),path+'.members');if(d.members.length!==group.members.length||d.members.some(m=>!group.members.includes(m.deviceId)))report('invalid_distribution','manual 必须覆盖每个设备成员',path);}
    if(d.kind==='partial'&&a.phases.includes(scenario.workload.kind)&&!communications.some(c=>{
      const tensors=assets.flatMap(a=>a.definition.kind==='operator'?a.definition.operator.tensors:a.definition.kind==='model'||a.definition.kind==='module'?a.definition.graph.tensors:[]);
      const sameObject='tensorId' in distribution?c.source.tensorId===distribution.tensorId:tensors.some(t=>t.tensorId===c.source.tensorId&&t.storageId===distribution.storageId);
      return sameObject&&c.source.distribution.kind==='partial'&&c.source.distribution.groupId===d.groupId&&c.source.distribution.reduceOperation===d.reduceOperation&&(c.operation==='all_reduce'||c.operation==='reduce_scatter');
    })){
      const potential=[...communications,...nativeCommunications].some(c=>{const source=c.source.distribution,from=groups.find(g=>g.groupId===(scenario.parallelPlan.nativeBindings?.groups.find(b=>b.logicalGroupId===source.groupId)?.physicalGroupId??source.groupId));return source.kind==='partial'&&source.reduceOperation===d.reduceOperation&&from&&JSON.stringify([...from.members].sort())===JSON.stringify([...group.members].sort())&&(c.operation==='all_reduce'||c.operation==='reduce_scatter');});
      if(potential)issues.push({diagnosticId:`${scenario.scenarioId}-validation-${issues.length+1}`,severity:'warning',code:'deferred_partial_binding',message:'partial 对象或设备组需要在模型展开后按规范身份核对，不能据此声称归约已完成',location:{kind:'scenario',scenarioId:scenario.scenarioId,fieldPath:path}});
      else report('unresolved_partial','partial 结果未声明本对象的归约通信',path);
    }
  }
  if(scenario.executionPlan.kind==='streams'){
    unique(scenario.executionPlan.extraDependencies.map(d=>d.edgeId),'executionPlan.extraDependencies');for(const d of scenario.executionPlan.extraDependencies)if(d.fromNodeId===d.toNodeId)report('dependency_cycle','执行计划不能同步到自身','executionPlan.extraDependencies');
    unique(scenario.executionPlan.assignments.map(a=>a.nodeId),'executionPlan.assignments');
    for(const a of scenario.executionPlan.assignments)if(!groups.some(g=>g.groupId===a.groupId))report('missing_reference','执行流设备组不存在','executionPlan.assignments');
  }
  unique(scenario.fusionGroups.map(g=>g.groupId),'fusionGroups');
  const fusedNodes=scenario.fusionGroups.flatMap(g=>g.memberNodeIds);unique(fusedNodes,'fusionGroups.memberNodeIds');
  for(const fusion of scenario.fusionGroups){unique(fusion.memberNodeIds,'fusionGroups.memberNodeIds');unique(fusion.eliminatedTensorIds,'fusionGroups.eliminatedTensorIds');}
  return issues;
}
