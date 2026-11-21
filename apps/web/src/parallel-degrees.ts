import { DeviceId, type ParallelPresetTemplate, type Scenario, type ParallelPresetRequest } from '@model-analyser/contracts';
import { expertMeshPresets, pipelineAttentionPreset, pipelineTensorMeshAxis, requestReplicaMeshAxis, supportsRequestReplicas } from '@model-analyser/core';

export const parallelFields = [
  { area: 'Attention', fields: [{ id: 'attentionTp', label: 'TP' }, { id: 'attentionDp', label: 'DP' }] },
  { area: 'MoE', fields: [{ id: 'moeEp', label: 'EP' }, { id: 'moeTp', label: 'TP' }] },
  { area: '序列与流水线', fields: [{ id: 'sp', label: 'SP' }, { id: 'pcp', label: 'PCP' }, { id: 'dcp', label: 'DCP' }, { id: 'pp', label: 'PP' }] },
] as const;
type Degree = (typeof parallelFields)[number]['fields'][number]['id'];
export type Degrees = Record<Degree, number>;
export const serialDegrees: Degrees = { attentionTp: 1, attentionDp: 1, moeEp: 1, moeTp: 1, sp: 1, pcp: 1, dcp: 1, pp: 1 };
const ids = parallelFields.flatMap(area => area.fields.map(field => field.id));
const poolId = '$degree-pool';
const rankPrefix = '$degree-rank:';
type DegreeMatch = { preset: ParallelPresetTemplate; slots: number; expertMesh?: ParallelPresetRequest['expertMesh']; requestDp?: number; pipelineTp?: number };

function declaredDegrees(model: Scenario['model'], preset: ParallelPresetTemplate, size: number): Degrees | undefined {
  if (preset.strategy === 'batch_sharded') return size > 1 ? { ...serialDegrees, attentionDp: size } : undefined;
  if (preset.strategy === 'replicated') return size === 1 ? serialDegrees : undefined;
  if (preset.strategy === 'pipeline') return size > 1 ? { ...serialDegrees, pp: size } : undefined;
  if (preset.strategy === 'query_sharded') return size > 1 ? { ...serialDegrees, pcp: size } : undefined;
  if (preset.strategy === 'decode_context_sharded') return size > 1 ? { ...serialDegrees, dcp: size } : undefined;
  if (preset.strategy === 'tensor_sharded' && preset.sharedPoolDegrees?.length) {
    if (size <= 1) return;
    const degrees = { ...serialDegrees };
    for (const axis of preset.sharedPoolDegrees) degrees[axis] = size;
    return degrees;
  }
  const fullModelPresets = (model.assetId === 'builtin:model:qwen3-1.7b' && model.revision === 2) ||
    (model.assetId === 'builtin:model:qwen3-0.6b' && model.revision === 3) ||
    ((model.revision === 3 || model.revision === 4) && model.assetId === 'builtin:model:qwen3.5-397b-a17b') ||
    (model.revision === 2 && ['builtin:model:deepseek-v3', 'builtin:model:deepseek-r1',
      'builtin:model:qwen3.5-397b-a17b', 'builtin:model:qwen3.8-27b'].includes(model.assetId));
  const ownerId = preset.strategy === 'declared_plan' ? 'builtin:model:parallel-' + preset.presetId : 'builtin:model:gqa-distributed-reference';
  if (!fullModelPresets && (model.revision !== 1 || model.assetId !== ownerId)) return undefined;
  switch (preset.strategy) {
    case 'tensor_sharded': return size > 1 ? { ...serialDegrees, attentionTp: size } : undefined;
    case 'declared_plan':
      switch (preset.presetId) {
        case 'ep2': return { ...serialDegrees, moeEp: 2 };
        case 'ep2-tp2': return { ...serialDegrees, moeEp: 2, moeTp: 2 };
        case 'sp2': return { ...serialDegrees, sp: 2 };
        case 'pcp2': return { ...serialDegrees, pcp: 2 };
        case 'dcp2': return { ...serialDegrees, dcp: 2 };
        case 'pp2': return { ...serialDegrees, pp: 2 };
      }
  }
}

export function matchingParallelPresets(degrees: Degrees, presets: ParallelPresetTemplate[], scenario: Scenario): DegreeMatch[] {
  if (ids.some(id => !Number.isSafeInteger(degrees[id]) || degrees[id] < 1 || degrees[id] > 64)) return [];
  const requestDp = degrees.attentionDp;
  if (requestDp > 1 && ids.some(id => id !== 'attentionDp' && degrees[id] > 1)) {
    if (!presets.some(preset => preset.strategy === 'batch_sharded' && preset.phases.includes(scenario.workload.kind))) return [];
    return matchingParallelPresets({ ...degrees, attentionDp: 1 }, presets, scenario).flatMap(match => {
      const slots = match.slots * requestDp;
      return supportsRequestReplicas(match.preset) && slots <= 64 ? [{ ...match, slots, requestDp }] : [];
    });
  }
  if(degrees.pp>1&&degrees.attentionTp>1&&ids.every(id=>id==='pp'||id==='attentionTp'||degrees[id]===1)){
    const slots=degrees.pp*degrees.attentionTp;
    if(slots>64)return [];
    return presets.flatMap(preset=>preset.phases.includes(scenario.workload.kind)&&pipelineAttentionPreset(preset,presets,scenario.workload.kind)
      ?[{preset,slots,pipelineTp:degrees.attentionTp}]:[]);
  }
  const { moeEp: ep, moeTp: tp, attentionTp, ...other } = degrees;
  if (ep > 1 && tp > 1 && Object.values(other).every(degree => degree === 1)) {
    const slots = ep * tp;
    const recipes = expertMeshPresets(presets, scenario.workload.kind);
    const preset = attentionTp === 1 ? recipes?.ep : attentionTp === slots ? recipes?.shared : undefined;
    if (preset && slots <= 64) return [{ preset, slots, expertMesh: { ep, tp } }];
  }
  const size = Math.max(...ids.map(id => degrees[id]));
  return presets.flatMap(preset => {
    const slots = preset.declaredPlan?.deviceSlots.length ?? size;
    const declared = declaredDegrees(scenario.model, preset, slots);
    return preset.phases.includes(scenario.workload.kind) && declared && ids.every(id => declared[id] === degrees[id]) ? [{ preset, slots }] : [];
  });
}

export function currentDegrees(scenario: Scenario, presets: ParallelPresetTemplate[]) {
  const origin = scenario.parallelPlan.generatedFrom;
  const preset = presets.find(p => p.presetId === origin?.presetId);
  const group = scenario.deviceTopology.groups.find(g => g.groupId === origin?.groupId);
  if (!preset || !group || origin?.modelId !== scenario.model.assetId || origin.modelRevision !== scenario.model.revision) return undefined;
  const requestDp = origin.requestDp;
  const width = group.members.length / (requestDp ?? 1);
  const stageCount=width/(origin.pipelineTp??1);
  if ((requestDp||origin.pipelineTp)&&(!Number.isInteger(stageCount)||group.mesh?.axes.find(axis=>axis.axisId===origin.meshAxisId)?.size!==stageCount))return undefined;
  if (requestDp && (!supportsRequestReplicas(preset) || group.mesh?.axes.find(axis => axis.axisId === requestReplicaMeshAxis)?.size !== requestDp)) return undefined;
  if(origin.pipelineTp&&(!pipelineAttentionPreset(preset,presets,scenario.workload.kind)||group.mesh?.axes.find(axis=>axis.axisId===pipelineTensorMeshAxis)?.size!==origin.pipelineTp))return undefined;
  const degrees = declaredDegrees(scenario.model, preset, stageCount);
  if (!degrees) return undefined;
  if (requestDp) degrees.attentionDp = requestDp;
  if(origin.pipelineTp)degrees.attentionTp=origin.pipelineTp;
  if (!origin.expertMesh) return degrees;
  const { ep, tp, groupId } = origin.expertMesh;
  const expert = scenario.deviceTopology.groups.find(item => item.groupId === groupId);
  if (!expert || expert.members.length !== group.members.length || ep * tp !== width ||
      expert.members.some((member, index) => member !== group.members[index]) ||
      expert.mesh?.axes.find(axis => axis.axisId === 'expert')?.size !== ep ||
      expert.mesh.axes.find(axis => axis.axisId === 'feature')?.size !== tp ||
      requestDp && expert.mesh.axes.find(axis => axis.axisId === requestReplicaMeshAxis)?.size !== requestDp) return undefined;
  return { ...degrees, moeEp: ep, moeTp: tp };
}

export function bindDegreePool(scenario: Scenario, slots: number) {
  const { devices, groups } = scenario.deviceTopology;
  const existingPool = groups.find(group => group.groupId === poolId);
  const ownsPool = scenario.parallelPlan.generatedFrom?.groupId === poolId;
  if (existingPool && !ownsPool) throw Error('当前配置使用同名设备池，请在高级设备与拓扑中绑定。');
  // A manually configured multi-device topology can be reused exactly as authored.
  // Only devices previously generated by this editor can be retired automatically.
  const unrelatedGroups = groups.filter(group => group.groupId !== poolId && group.groupId !== scenario.parallelPlan.generatedFrom?.expertMesh?.groupId &&
    !scenario.parallelPlan.nativeBindings?.groups.some(binding => binding.physicalGroupId === group.groupId && ownsPool));
  const required = new Set(unrelatedGroups.flatMap(group => group.members));
  const reusable = devices.filter(device => !ownsPool || !existingPool?.members.includes(device.deviceId) ||
    !device.deviceId.startsWith(rankPrefix) || required.has(device.deviceId));
  if (reusable.length > slots || !ownsPool && reusable.length > 1 && reusable.length !== slots) {
    throw Error('已有设备映射与此并行配置的槽位数不同。请在高级设备与拓扑中调整映射。');
  }
  const mapped = [...reusable];
  const hardware = devices[0]!.hardware;
  for (const device of devices) {
    if (mapped.length === slots) break;
    if (!mapped.includes(device)) mapped.push(device);
  }
  let index = 1;
  while (mapped.length < slots) {
    const deviceId = DeviceId.parse(rankPrefix + index++);
    if (!devices.some(device => device.deviceId === deviceId)) mapped.push({ deviceId, hardware });
  }
  const members = mapped.map(device => device.deviceId);
  return {
    scenario: {
      ...scenario,
      deviceTopology: {
        devices: mapped,
        groups: [...unrelatedGroups, {
          groupId: poolId,
          members,
          mesh: { axes: [{ axisId: 'rank', size: slots }], coordinates: members.map((deviceId, i) => ({ deviceId, coordinates: [i] })) },
        }],
      },
    },
    groupId: poolId,
    meshAxisId: 'rank',
  };
}
