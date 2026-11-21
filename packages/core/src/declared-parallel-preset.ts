import { type ParallelPresetRequest,type ParallelPresetTemplate,type Scenario } from '@model-analyser/contracts';
import { bindNativeCommunication,remapDistribution,declaredRecipeIssues } from '../../contracts/src/parallel-bindings.js';

/** The selected group is an ordered physical pool; authored roles may reuse its members. */
export function materializeDeclaredPreset(request:ParallelPresetRequest,preset:ParallelPresetTemplate,
  {preserveCommunicationTiming=false}:{preserveCommunicationTiming?:boolean}={}):{topology:Scenario['deviceTopology'];plan:Scenario['parallelPlan']}{
  const issues=declaredRecipeIssues(preset);if(issues.length)throw Error(issues.join('；'));
  const recipe=preset.declaredPlan,selected=request.scenario.deviceTopology.groups.find(g=>g.groupId===request.groupId);
  if(!recipe||!selected)throw Error('声明式预设缺少方案模板或实际设备组');
  if(preset.tensorShards.length||preset.reductions.length)throw Error('声明式方案不能夹带旧式 TP 简写');
  if(new Set(recipe.deviceSlots).size!==recipe.deviceSlots.length||recipe.deviceSlots.length!==selected.members.length)throw Error('此模板需要恰好 '+recipe.deviceSlots.length+' 个不同物理设备槽位；所选组有 '+selected.members.length+' 个成员');
  if(new Set(recipe.groups.map(g=>g.groupId)).size!==recipe.groups.length)throw Error('模板组角色重复');
  if(new Set(selected.members).size!==selected.members.length)throw Error('实际设备组成员重复');
  const devices=recipe.deviceSlots.map((logicalDeviceId,i)=>{const physicalDeviceId=selected.members[i];if(!physicalDeviceId)throw Error('设备槽位映射缺失');return {logicalDeviceId,physicalDeviceId};});
  const mappedDevice=(id:string)=>{const d=devices.find(d=>d.logicalDeviceId===id);if(!d)throw Error('模板引用未声明设备槽位 '+id);return d.physicalDeviceId;};
  // JSON tuple encoding is injective even when user IDs contain colons/slashes.
  const roleId=(id:string)=>'$preset:'+JSON.stringify([request.groupId,request.meshAxisId,id]);
  const bindings:NonNullable<Scenario['parallelPlan']['nativeBindings']>={devices,groups:recipe.groups.map(g=>({logicalGroupId:g.groupId,physicalGroupId:roleId(g.groupId),meshAxes:g.mesh?.axes.map(a=>({logicalAxisId:a.axisId,physicalAxisId:request.meshAxisId+':'+a.axisId}))??[]})),...(request.network?{network:request.network}:{})};
  if(!request.network)throw Error('请显式填写声明式方案的通信带宽和单轮延迟');
  const groups=recipe.groups.map(g=>({...g,groupId:roleId(g.groupId),members:g.members.map(mappedDevice),...(g.mesh?{mesh:{axes:g.mesh.axes.map(a=>({...a,axisId:request.meshAxisId+':'+a.axisId})),coordinates:g.mesh.coordinates.map(c=>({...c,deviceId:mappedDevice(c.deviceId)}))}}:{})}));
  const previous=request.scenario.parallelPlan.nativeBindings;
  // Only replace role groups owned by the previous generated plan. Never overwrite a user group.
  const owned=new Set(previous&&request.scenario.parallelPlan.generatedFrom?previous.groups.map(g=>g.physicalGroupId):[]),existing=request.scenario.deviceTopology.groups.filter(g=>!owned.has(g.groupId)||g.groupId===selected.groupId);
  for(const g of groups)if(existing.some(e=>e.groupId===g.groupId))throw Error('生成组 ID 与已有组冲突，请更改轴前缀：'+g.groupId);
  const communicationBindings=preserveCommunicationTiming?{groups:bindings.groups,devices:bindings.devices}:bindings;
  const plan:Scenario['parallelPlan']={assignments:recipe.plan.assignments.map(a=>({...a,tensorDistributions:a.tensorDistributions.map(t=>({...t,distribution:remapDistribution(t.distribution,bindings)})),storageDistributions:a.storageDistributions.map(s=>({...s,distribution:remapDistribution(s.distribution,bindings)}))})),communications:recipe.plan.communications.map(c=>bindNativeCommunication(c,communicationBindings)),nativeBindings:bindings,assumptions:[...recipe.plan.assumptions,preset.description,...preset.assumptions,
    'Authored device slots map in selected group member order; role groups reuse actual devices. Native graph assets remain immutable. Network bandwidth/latency are explicit scenario bindings; payload/local equations remain dynamic.',
    ...devices.map(d=>'Slot '+d.logicalDeviceId+' → physical '+d.physicalDeviceId),...bindings.groups.map(g=>'Role '+g.logicalGroupId+' → '+g.physicalGroupId)]};
  return {topology:{...request.scenario.deviceTopology,groups:[...existing,...groups]},plan};
}
