import { type Scenario,type TensorDistribution,type CommunicationDefinition,type ParallelPresetTemplate } from './index.js';
import { sendRecvIssue } from './communication-peers.js';

type Bindings=NonNullable<Scenario['parallelPlan']['nativeBindings']>;
/** Bind authored roles without changing tensor/node identifiers or immutable assets. */
export function remapDistribution(d:TensorDistribution,b:Bindings):TensorDistribution{
  const group=b.groups.find(g=>g.logicalGroupId===d.groupId);if(!group)throw Error('未绑定通信/布局组角色 '+d.groupId);
  const device=(id:string)=>{const mapped=b.devices.find(x=>x.logicalDeviceId===id);if(!mapped)throw Error('未绑定设备槽位 '+id);return mapped.physicalDeviceId;};
  const remapAxis=(a:{tensorAxisId:string;meshAxisId:string})=>{const axis=group.meshAxes.find(x=>x.logicalAxisId===a.meshAxisId);if(!axis)throw Error('未绑定 mesh 轴 '+d.groupId+'.'+a.meshAxisId);return {...a,meshAxisId:axis.physicalAxisId};};
  if(d.kind==='sharded')return {...d,groupId:group.physicalGroupId,axes:d.axes.map(remapAxis),policy:d.policy.kind==='explicit'?{...d.policy,slices:d.policy.slices.map(s=>({...s,deviceId:device(s.deviceId)}))}:d.policy};
  if(d.kind==='partial'&&d.partition)return {...d,groupId:group.physicalGroupId,partition:remapAxis(d.partition)};
  if(d.kind==='manual')return {...d,groupId:group.physicalGroupId,members:d.members.map(m=>({...m,deviceId:device(m.deviceId)}))};
  return {...d,groupId:group.physicalGroupId};
}
export function bindNativeCommunication(c:CommunicationDefinition,b:Bindings):CommunicationDefinition{
  const group=b.groups.find(g=>g.logicalGroupId===c.groupId);if(!group)throw Error('未绑定通信组角色 '+c.groupId);
  const device=(id:string)=>{const mapped=b.devices.find(x=>x.logicalDeviceId===id);if(!mapped)throw Error('未绑定通信设备槽位 '+id);return mapped.physicalDeviceId;};
  if(b.network&&c.timing.kind!=='bandwidth_latency')throw Error('网络绑定不能替换 fixed/custom_formula 通信模型');
  return {...c,groupId:group.physicalGroupId,source:{...c.source,distribution:remapDistribution(c.source.distribution,b)},destination:{...c.destination,distribution:remapDistribution(c.destination.distribution,b)},
    ...(c.sourceDeviceId?{sourceDeviceId:device(c.sourceDeviceId)}:{}),...(c.destinationDeviceId?{destinationDeviceId:device(c.destinationDeviceId)}:{}),
    ...(c.peerPairs?{peerPairs:c.peerPairs.map(pair=>({sourceDeviceId:device(pair.sourceDeviceId),destinationDeviceId:device(pair.destinationDeviceId)}))}:{}),
    ...(c.perDevicePayloads?{perDevicePayloads:c.perDevicePayloads.map(p=>({...p,deviceId:device(p.deviceId)}))}:{}),
    timing:b.network?{kind:'bandwidth_latency',bytePerSecond:b.network.bytesPerSecond,latencySeconds:b.network.latencySeconds}:c.timing};
}
export function nativeBindingIssues(b:Bindings,topology:Scenario['deviceTopology']):string[]{
  const errors:string[]=[],unique=(ids:string[],label:string)=>{if(new Set(ids).size!==ids.length)errors.push(label+' 重复');};
  unique(b.groups.map(g=>g.logicalGroupId),'逻辑组角色');unique(b.devices.map(d=>d.logicalDeviceId),'逻辑设备槽位');unique(b.devices.map(d=>d.physicalDeviceId),'物理设备绑定');
  for(const d of b.devices)if(!topology.devices.some(p=>p.deviceId===d.physicalDeviceId))errors.push('绑定的物理设备不存在 '+d.physicalDeviceId);
  for(const g of b.groups){const physical=topology.groups.find(p=>p.groupId===g.physicalGroupId);if(!physical)errors.push('绑定的物理组不存在 '+g.physicalGroupId);
    unique(g.meshAxes.map(a=>a.logicalAxisId),'逻辑 mesh 轴');unique(g.meshAxes.map(a=>a.physicalAxisId),'物理 mesh 轴');
    if(physical){for(const a of g.meshAxes)if(!physical.mesh?.axes.some(p=>p.axisId===a.physicalAxisId))errors.push('绑定的物理 mesh 轴不存在 '+a.physicalAxisId);
      if(physical.members.some(id=>!b.devices.some(d=>d.physicalDeviceId===id)))errors.push('绑定组包含未绑定物理设备 '+g.physicalGroupId);}
  }return errors;
}

export function pipelineAttentionPreset(preset:ParallelPresetTemplate,presets:ParallelPresetTemplate[],phase:ParallelPresetTemplate['phases'][number]){
  const id=preset.strategy==='pipeline'?preset.pipeline?.attentionPresetId:undefined;
  return id?presets.find(row=>row.presetId===id&&row.strategy==='tensor_sharded'&&row.phases.includes(phase)&&
    row.sharedPoolDegrees?.length===1&&row.sharedPoolDegrees[0]==='attentionTp'):undefined;
}

export function declaredRecipeIssues(p:ParallelPresetTemplate):string[]{
  const r=p.declaredPlan,errors:string[]=[],unique=(ids:string[],label:string)=>{if(new Set(ids).size!==ids.length)errors.push(label+' 重复');};
  if((p.strategy==='declared_plan')!==(r!==undefined))errors.push('declared_plan 必须且仅能提供声明式方案模板');
  if((p.strategy==='pipeline')!==(p.pipeline!==undefined))errors.push('流水线预设必须独立声明层链与传输消息');
  if(p.pipeline&&(p.tensorShards.length||p.reductions.length||p.moduleRules))errors.push('流水线预设须按阶段分布，无额外张量分片规则');
  if((p.strategy==='query_sharded')!==(p.queryParallel!==undefined))errors.push('查询分片预设须声明查询轴和 KV 收集边界');
  if((p.strategy==='decode_context_sharded')!==(p.decodeContext!==undefined))errors.push('Decode 上下文预设须声明固定模块与替代模块');
  if(p.requestBatchSharding&&p.strategy!=='decode_context_sharded'&&p.strategy!=='query_sharded'&&p.strategy!=='pipeline')errors.push('此请求分片声明仅适用于上下文并行或流水线预设');
  if(p.decodeContext&&(p.decodeContext.module.kind!=='module'||p.decodeContext.replacement.kind!=='module'||
    p.phases.some(phase=>phase!=='decode')||!p.moduleRules?.some(rule=>rule.module.assetId===p.decodeContext?.replacement.assetId&&rule.module.revision===p.decodeContext.replacement.revision)))
    errors.push('Decode 上下文预设仅用于 Decode，需声明替代模块的实际分片和归约');
  if(p.queryParallel){
    if(p.tensorShards.length||p.reductions.length||p.moduleRules||p.phases.some(phase=>phase!=='prefill'))errors.push('查询分片布局适用于 Prefill，按声明查询轴和收集边界生成');
    unique(p.queryParallel.moduleGathers.map(rule=>rule.module.assetId+'@'+rule.module.revision),'模块收集规则');
    for(const rule of p.queryParallel.moduleGathers){
      if(rule.module.kind!=='module')errors.push('查询分片收集边界必须引用固定模块修订');
      unique(rule.gathers.map(gather=>gather.tensorId),'模块规则的收集张量');
    }
  }
  if(p.sharedPoolDegrees){
    if(p.strategy!=='tensor_sharded'||!(p.tensorShards.length||p.moduleRules?.length))errors.push('同池并行度需要轴分片预设和显式张量规则');
    unique(p.sharedPoolDegrees,'同池并行度');
  }
  if(p.moduleRules){
    if(p.strategy!=='tensor_sharded'&&p.strategy!=='decode_context_sharded')errors.push('模块分片规则仅适用于轴分片预设');
    unique(p.moduleRules.map(rule=>rule.module.assetId+'@'+rule.module.revision),'模块分片规则');
    for(const rule of p.moduleRules){
      if(rule.module.kind!=='module')errors.push('模块分片规则必须引用固定模块修订');
      if(!rule.tensorShards.length&&!rule.reductions.length)errors.push('模块分片规则缺少张量分片或输出归约');
      unique(rule.tensorShards.map(shard=>shard.tensorId),'模块规则的张量分片');
      unique(rule.reductions.map(reduction=>reduction.tensorId),'模块规则的输出归约');
    }
  }
  if(!r)return errors;
  if(p.tensorShards.length||p.reductions.length)errors.push('声明式方案不能夹带旧式 TP 简写');
  unique(r.deviceSlots,'设备槽位');unique(r.groups.map(g=>g.groupId),'组角色');
  for(const id of r.deviceSlots)if(!r.groups.some(g=>g.members.includes(id)))errors.push('未使用的设备槽位 '+id);
  for(const g of r.groups){unique(g.members,'组成员');if(g.members.some(id=>!r.deviceSlots.includes(id)))errors.push('组引用未知设备槽位 '+g.groupId);
    if(g.mesh){const m=g.mesh,size=m.axes.reduce((n,a)=>n*a.size,1);unique(m.axes.map(a=>a.axisId),'mesh 轴');unique(m.coordinates.map(c=>c.deviceId),'mesh 坐标设备');unique(m.coordinates.map(c=>JSON.stringify(c.coordinates)),'mesh 坐标');
      if(!Number.isSafeInteger(size)||size!==g.members.length||m.coordinates.length!==g.members.length||m.coordinates.some(c=>!g.members.includes(c.deviceId)||c.coordinates.length!==m.axes.length||c.coordinates.some((v,i)=>v>=(m.axes[i]?.size??0))))errors.push('模板 mesh 必须完整且唯一地映射组内实际槽位 '+g.groupId);}
  }
  const check=(d:TensorDistribution)=>{const g=r.groups.find(g=>g.groupId===d.groupId);if(!g){errors.push('布局引用未知组角色 '+d.groupId);return;}
    if(d.kind==='sharded'&&d.axes.some(a=>!g.mesh?.axes.some(m=>m.axisId===a.meshAxisId)))errors.push('分片引用未知模板 mesh 轴');
    if(d.kind==='partial'&&d.partition&&!g.mesh?.axes.some(m=>m.axisId===d.partition?.meshAxisId))errors.push('归约保留分片引用未知模板 mesh 轴');
    if(d.kind==='manual'&&(d.members.length!==g.members.length||new Set(d.members.map(m=>m.deviceId)).size!==g.members.length||d.members.some(m=>!g.members.includes(m.deviceId))))errors.push('manual 布局必须完整覆盖角色成员');
    if(d.kind==='sharded'&&d.policy.kind==='explicit'&&d.policy.slices.some(s=>!g.members.includes(s.deviceId)||s.start>=s.end))errors.push('显式切片引用未知槽位或非法范围');
  };
  for(const a of r.plan.assignments){if(a.phases.some(phase=>!p.phases.includes(phase)))errors.push('布局阶段超出预设支持范围');for(const d of [...a.tensorDistributions,...a.storageDistributions])check(d.distribution);}
  for(const c of r.plan.communications){const group=r.groups.find(g=>g.groupId===c.groupId);if(!group)errors.push('通信引用未知组角色');const issue=sendRecvIssue(c,group?.members);if(issue)errors.push(issue);check(c.source.distribution);check(c.destination.distribution);}
  return errors;
}
