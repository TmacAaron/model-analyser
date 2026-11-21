import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  AssetDocument, ParallelPresetAttempt, ParallelPresetRequest,
  type ParallelPresetPreview, type ProjectDocument, type Scenario,
} from '@model-analyser/contracts';
import { pipelineAttentionPreset, pipelineExpertPreset } from '@model-analyser/core';
import { canonical, collectRefs } from '../../../packages/contracts/src/validation.js';
import { request } from './api.js';
import { useDisplayUnits } from './display-units.js';
import { bindDegreePool, currentDegrees, matchingParallelPresets, parallelFields, serialDegrees, type Degrees } from './parallel-degrees.js';

type Props = {
  project: ProjectDocument;
  scenario: Scenario;
  onApply: (scenario: Scenario, assets: AssetDocument[]) => void;
};
type LinkScope = 'intra_group' | 'inter_group';
type LinkText = { bandwidth: string; latency: string };
type Link = NonNullable<ParallelPresetRequest['network']>;

function networkInput(text: LinkText, label: string): Link {
  const bytesPerSecond = Number(text.bandwidth), latencySeconds = Number(text.latency);
  if (!text.bandwidth.trim() || !text.latency.trim() || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0 ||
      !Number.isFinite(latencySeconds) || latencySeconds < 0) {
    throw Error(label + '带宽须大于零，单轮延迟须为非负数。');
  }
  return { bytesPerSecond, latencySeconds };
}

export function ParallelDegreeEditor({ project, scenario, onApply }: Props) {
  const display = useDisplayUnits();
  const model = project.assetSnapshots.find(asset => asset.assetId === scenario.model.assetId && asset.revision === scenario.model.revision);
  const presets = model?.parallelPresets ?? [];
  const current = currentDegrees(scenario, presets);
  const [draft, setDraft] = useState<Partial<Record<keyof Degrees, string>>>({});
  const [variant, setVariant] = useState('');
  const degrees = { ...current ?? serialDegrees };
  for (const field of Object.keys(draft) as (keyof Degrees)[]) degrees[field] = Number(draft[field]);
  const valid = Object.values(degrees).every(degree => Number.isSafeInteger(degree) && degree >= 1 && degree <= 64);
  const matches = matchingParallelPresets(degrees, presets, scenario);
  const origin = scenario.parallelPlan.generatedFrom;
  const optionKey = (presetId?: string, stageId?: string) => JSON.stringify([presetId, stageId]);
  const match = matches.find(item => optionKey(item.preset.presetId, item.pipelineStage?.presetId) ===
    (variant || optionKey(origin?.presetId, origin?.pipelineStage?.presetId))) ?? matches[0];
  const hardwareRef = scenario.deviceTopology.devices[0]?.hardware;
  const hardware = project.assetSnapshots.find(asset => asset.assetId === hardwareRef?.assetId && asset.revision === hardwareRef.revision);
  const isPipeline = match?.preset.strategy === 'pipeline';
  const savedPipeline = presets.some(preset => preset.presetId === scenario.parallelPlan.generatedFrom?.presetId && preset.strategy === 'pipeline');
  const hardwareLink = (scope: LinkScope) => hardware?.definition.kind === 'hardware'
    ? hardware.definition.hardware.communicationDefaults.find(item => item.scope === scope) : undefined;
  const savedLink = (operation?: 'send_recv'|'all_reduce'): Link | undefined => {
    const timing = scenario.parallelPlan.communications.find(item =>
      (!operation || item.operation === operation) && item.timing.kind === 'bandwidth_latency')?.timing;
    return timing?.kind === 'bandwidth_latency' ? { bytesPerSecond: timing.bytePerSecond, latencySeconds: timing.latencySeconds } : undefined;
  };
  const nativeNetwork = scenario.parallelPlan.nativeBindings?.network;
  const innerSaved = savedLink('all_reduce');
  const primarySaved = isPipeline ? savedLink('send_recv') ?? (savedPipeline ? nativeNetwork : undefined)
    : savedPipeline ? innerSaved : nativeNetwork ?? savedLink();
  const primaryScope: LinkScope = isPipeline ? 'inter_group' : match?.preset.networkDefaults?.scope ?? 'intra_group';
  const primaryDefaults = primarySaved ?? match?.preset.networkDefaults ?? hardwareLink(primaryScope);
  const stagePreset = match?.pipelineStage ? pipelineExpertPreset(match.preset, presets, match.pipelineStage.presetId, scenario.workload.kind)
    : match?.pipelineTp ? pipelineAttentionPreset(match.preset, presets, scenario.workload.kind) : undefined;
  const stageReduces = !!stagePreset && (stagePreset.reductions.length > 0 || !!stagePreset.moduleRules?.some(rule => rule.reductions.length));
  const innerDefaults = innerSaved ?? stagePreset?.networkDefaults ?? hardwareLink('intra_group') ?? primaryDefaults;
  const [linkDraft, setLinkDraft] = useState<Partial<Record<LinkScope, Partial<LinkText>>>>({});
  const linkText = (scope: LinkScope, defaults?: Link): LinkText => ({
    bandwidth: linkDraft[scope]?.bandwidth ?? String(defaults?.bytesPerSecond ?? ''),
    latency: linkDraft[scope]?.latency ?? String(defaults?.latencySeconds ?? ''),
  });
  const primaryLink = linkText(primaryScope, primaryDefaults);
  const innerLink = stageReduces ? linkText('intra_group', innerDefaults) : undefined;
  const moduleReductions = match?.preset.moduleRules?.reduce((count, rule) => count + rule.reductions.length, 0) ?? 0;
  const needsNetwork = !!match && (match.preset.strategy === 'declared_plan' || match.preset.strategy === 'pipeline' || match.preset.strategy === 'query_sharded' ||
    match.slots > 1 && (match.preset.reductions.length > 0 || moduleReductions > 0));
  function linkFields(scope: LinkScope, values: LinkText, label?: string) {
    const setValue = (field: keyof LinkText, value: string) =>
      setLinkDraft(previous => ({ ...previous, [scope]: { ...previous[scope], [field]: value } }));
    return <div className="parallel-degree-link">
      <label>{label ?? '通信'}带宽 (B/s)<input type="number" min={0} step="any" value={values.bandwidth} onChange={event => setValue('bandwidth', event.target.value)}/></label>
      <label>{label}单轮延迟 (s)<input type="number" min={0} step="any" value={values.latency} onChange={event => setValue('latency', event.target.value)}/></label>
    </div>;
  }
  const fields = <>{linkFields(primaryScope, primaryLink, innerLink ? '阶段间传输' : undefined)}
    {innerLink && linkFields('intra_group', innerLink, '阶段内归约')}</>;
  const fingerprint = canonical([scenario, project.assetSnapshots, degrees, match?.preset.presetId ?? '', stagePreset?.presetId ?? '', primaryLink, innerLink ?? null]);
  const active = useRef<{ worker: Worker | null } | null>(null);
  const currentKey = useRef(fingerprint);
  currentKey.current = fingerprint;
  const [state, setState] = useState<{ key: string; status: 'running' | 'error' | 'ready'; message?: string; preview?: ParallelPresetPreview }>();
  useEffect(() => () => {
    active.current?.worker?.terminate();
    active.current = null;
  }, [fingerprint]);

  async function preview() {
    if (!match) return;
    const task = { worker: null as Worker | null };
    active.current = task;
    const live = () => active.current === task && currentKey.current === fingerprint;
    setState({ key: fingerprint, status: 'running' });
    try {
      const pool = bindDegreePool(scenario, match.slots);
      const refs = collectRefs([match.preset, stagePreset]).filter(ref => !project.assetSnapshots.some(asset => asset.assetId === ref.assetId && asset.revision === ref.revision));
      const extra = refs.length ? await request('snapshot', z.array(AssetDocument), { refs }) : [];
      if (!live()) return;
      const network = needsNetwork ? networkInput(primaryLink, innerLink ? '阶段间传输' : '通信') : undefined;
      const pipelineTpNetwork = innerLink ? networkInput(innerLink, '阶段内归约') : undefined;
      const input = ParallelPresetRequest.parse({ ...pool, assets: [...project.assetSnapshots, ...extra], presetId: match.preset.presetId,
        network, pipelineTpNetwork, expertMesh: match.expertMesh, requestDp: match.requestDp, pipelineTp: match.pipelineTp, pipelineStage: match.pipelineStage });
      const worker = new Worker(new URL('./parallel-preset-worker.ts', import.meta.url), { type: 'module' });
      task.worker = worker;
      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (!live()) return;
        const result = ParallelPresetAttempt.safeParse(event.data);
        if (result.success && result.data.status === 'available') {
          setState({ key: fingerprint, status: 'ready', preview: result.data.preview });
        } else {
          setState({ key: fingerprint, status: 'error', message: result.success && result.data.status === 'unavailable' ? result.data.message : '无法读取布局预览。' });
        }
        worker.terminate();
        active.current = null;
      };
      worker.onerror = () => {
        if (!live()) return;
        setState({ key: fingerprint, status: 'error', message: '布局预览失败，请重试。' });
        worker.terminate();
        active.current = null;
      };
      worker.postMessage(input);
    } catch (error) {
      if (live()) {
        setState({ key: fingerprint, status: 'error', message: error instanceof Error ? error.message : String(error) });
        active.current = null;
      }
    }
  }

  const outcome = state?.key === fingerprint ? state : undefined;
  const inputsChangedDuringPreview = state?.status === 'running' && !outcome;
  const result = outcome?.preview;
  const edited = Object.keys(draft).length > 0;
  const hasPlan = !!scenario.parallelPlan.generatedFrom || scenario.parallelPlan.assignments.length > 0;
  return <section className="parallel-degree-editor">
    {hasPlan && <p className="scope-note">
      {current ? '布局预设 ' + parallelFields.flatMap(area => area.fields.filter(field => current[field.id] > 1)
        .map(field => area.area + ' ' + field.label + ' ' + current[field.id])).join(' · ') : '当前使用高级布局'}
      {current && Object.values(current).every(value => value === 1) ? '单副本' : ''}
    </p>}
    {parallelFields.map(area => <fieldset key={area.area}>
      <legend>{area.area}</legend>
      <div>{area.fields.map(field => <label key={field.id}>{field.label}
        <input type="number" min={1} max={64} step={1} aria-label={area.area + ' ' + field.label}
          value={draft[field.id] ?? degrees[field.id]} onChange={event => setDraft({ ...draft, [field.id]: event.target.value })}/>
      </label>)}</div>
    </fieldset>)}
    {!valid && <p className="error">并行度须为 1 到 64 之间的整数。</p>}
    {valid && !match && <p className="scope-note">{!hasPlan && !edited
      ? (scenario.deviceTopology.devices.length === 1 ? '当前使用单设备执行。' : '当前从高级拓扑读取设备配置。') +
        (presets.length ? '填写并行度后可预览模型已声明的分片和通信。' : '此型号尚无可用的逻辑并行定义。')
      : '此模型在当前阶段未声明这组并行度的分片和局部计算规则。'}</p>}
    {match && <section className="parallel-degree-preview" aria-label="逻辑分片与通信">
      <h3>逻辑分片与通信</h3>
      {matches.length > 1 && <label>分片方式<select value={optionKey(match.preset.presetId, match.pipelineStage?.presetId)} onChange={event => setVariant(event.target.value)}>
        {matches.map(({ preset, pipelineStage }) => {
          const key = optionKey(preset.presetId, pipelineStage?.presetId);
          const stageName = pipelineStage && (presets.find(row => row.presetId === pipelineStage.presetId)?.name ?? pipelineStage.presetId);
          return <option key={key} value={key}>{stageName && stageName + ' × '}{preset.name}</option>;
        })}
      </select></label>}
      <p>{match.expertMesh ? (match.pipelineStage ? `每阶段 ${match.pipelineStage.degree} 卡。` : '') +
        `均分专家，每组用 ${match.expertMesh.tp} 张卡切分专家中间维度。` +
        (degrees.attentionTp > 1 ? (match.pipelineStage ? 'Attention TP 复用阶段内设备。' : match.requestDp ? 'Attention TP 复用每个请求组内的设备。' : 'Attention TP 复用全部设备。') : '') :
        stagePreset && match.pipelineStage ? `每阶段 ${match.pipelineStage.degree} 卡。${stagePreset.description}` : match.preset.description}</p>
      <p>{match.slots} 个逻辑槽位{match.requestDp && ` · ${match.requestDp} 组请求，每组 ${match.slots / match.requestDp} 卡`}
        {match.preset.declaredPlan && ' · ' + match.preset.declaredPlan.groups.map(group => group.groupId + ' ' + group.members.length).join(' · ')}</p>
      {match.preset.tensorShards.length > 0 && match.slots > 1 && <p>张量轴分片 {match.preset.tensorShards.map(item => item.tensorId + '/' + item.axisId).join('、')}</p>}
      <p>通信 {match.preset.declaredPlan?.plan.communications.map(item => item.operation).join('、') ||
        (match.slots > 1 && match.preset.reductions.length ? 'AllReduce × ' + match.preset.reductions.length
          : moduleReductions && match.slots > 1 ? '每次模块调用 AllReduce × ' + moduleReductions
          : stageReduces ? '阶段内 AllReduce · 阶段间 SendRecv'
          : match.preset.strategy === 'pipeline' ? (match.requestDp ? '各请求组独立执行阶段间 SendRecv' : '阶段间 SendRecv')
          : match.preset.strategy === 'query_sharded' ? (match.requestDp ? '每层在各请求组内收集 K 和 V' : '每个注意力层收集当前 K 和 V')
          : match.preset.strategy === 'declared_plan' ? '由模型图在布局校验时展开' : '无新增通信')}</p>
      <div className="parallel-degree-validation">
        {needsNetwork && ((match.preset.sharedPoolDegrees || match.preset.strategy === 'pipeline' || match.preset.strategy === 'query_sharded' || match.preset.strategy === 'decode_context_sharded') && match.preset.networkDefaults ?
          <details><summary>通信参数{primarySaved || innerLink && innerSaved || Object.keys(linkDraft).length ? '' : ' · 参考值'}</summary>{fields}</details> : fields)}
        <button type="button" onClick={() => void preview()} disabled={outcome?.status === 'running'}>校验布局</button>
        {inputsChangedDuringPreview&&<small role="status">配置已更新，请重新校验。</small>}
        {outcome?.status === 'running' && <button type="button" onClick={() => {
          active.current?.worker?.terminate();
          active.current = null;
          setState(undefined);
        }}>取消布局校验</button>}
        {result && <div className="parallel-degree-result">
          {scenario.workload.kind==='decode'&&scenario.workload.steps>1&&<small>首个 Decode 步骤</small>}
          <p>{result.deviceIds.length} 个实际设备 · {result.communicationCount} 个通信</p>
          <ul>{result.allocations.map(row => <li key={row.deviceId}>{row.deviceId} · 权重 {display.bytes(row.weightBytes)} · 状态 {display.bytes(row.stateBytes)}</li>)}</ul>
          <button type="button" onClick={() => {
            try {
              onApply(result.scenario, result.assets);
              setDraft({});
              setLinkDraft({});
              setState(undefined);
            } catch (error) {
              setState({ key: fingerprint, status: 'error', message: error instanceof Error ? error.message : String(error) });
            }
          }}>应用并行度</button>
        </div>}
        {outcome?.status === 'error' && <p role="alert" className="error">{outcome.message}</p>}
      </div>
    </section>}
  </section>;
}
