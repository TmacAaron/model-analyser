import { ParallelPresetAttempt, ParallelPresetRequest, type AssetDocument, type Scenario } from '@model-analyser/contracts';
import { bindDegreePool } from './parallel-degrees.js';

export function defaultDeclaredLayout(scenario: Scenario, model: AssetDocument | undefined) {
  const { parallelPlan: plan } = scenario;
  if (!model?.assetId.startsWith('builtin:model:parallel-') || plan.nativeBindings || plan.assignments.length || plan.communications.length) return;
  const choices = model?.parallelPresets?.filter(preset => preset.strategy === 'declared_plan' &&
    preset.declaredPlan?.groups.some(group => !scenario.deviceTopology.groups.some(actual => actual.groupId === group.groupId)) &&
    preset.phases.includes(scenario.workload.kind));
  return choices?.length === 1 ? choices[0] : undefined;
}

export async function prepareDeclaredLayout(scenario: Scenario, assets: AssetDocument[], signal?: AbortSignal) {
  const find = (ref: Scenario['model'] | Scenario['deviceTopology']['devices'][number]['hardware']) =>
    assets.find(asset => asset.assetId === ref.assetId && asset.revision === ref.revision);
  const model = find(scenario.model), preset = defaultDeclaredLayout(scenario, model);
  if (model?.definition.kind !== 'model' || !preset?.declaredPlan) throw Error('当前阶段没有唯一的内置并行布局。');
  const hardware = find(scenario.deviceTopology.devices[0]!.hardware);
  const timings = model.definition.graph.nodes.flatMap(node => node.body.kind === 'collective' &&
    node.phases.includes(scenario.workload.kind) ? [node.body.communication.timing] : []);
  const first = timings[0];
  const reference = first?.kind === 'bandwidth_latency' && timings.every(timing => timing.kind === 'bandwidth_latency' &&
    timing.bytePerSecond === first.bytePerSecond && timing.latencySeconds === first.latencySeconds) ?
    { bytesPerSecond: first.bytePerSecond, latencySeconds: first.latencySeconds } : undefined;
  const network = preset.networkDefaults ?? (hardware?.definition.kind === 'hardware' ?
    hardware.definition.hardware.communicationDefaults.find(item => item.scope === 'intra_group') : undefined) ?? reference;
  if (!network) throw Error('当前设备缺少通信参数，请在并行方式中填写。');
  const pool = bindDegreePool(scenario, preset.declaredPlan.deviceSlots.length);
  const request = ParallelPresetRequest.parse({ ...pool, assets, network: {
    bytesPerSecond: network.bytesPerSecond, latencySeconds: network.latencySeconds,
  }, presetId: preset.presetId });
  signal?.throwIfAborted();
  return new Promise<Extract<ParallelPresetAttempt, { status: 'available' }>['preview']>((resolve, reject) => {
    const worker = new Worker(new URL('./parallel-preset-worker.ts', import.meta.url), { type: 'module' });
    function cleanup() {
      signal?.removeEventListener('abort', abort);
      worker.terminate();
    }
    function abort() { cleanup(); reject(signal?.reason); }
    function fail() { cleanup(); reject(Error('无法启动并行布局计算，请刷新后重试。')); }
    worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      cleanup();
      const reply = ParallelPresetAttempt.safeParse(data);
      if (!reply.success) reject(Error('无法读取并行布局。'));
      else if (reply.data.status === 'unavailable') reject(Error(reply.data.message));
      else resolve(reply.data.preview);
    };
    worker.onerror = fail;
    worker.onmessageerror = fail;
    signal?.addEventListener('abort', abort, { once: true });
    try { worker.postMessage(request); } catch (issue) { cleanup(); reject(issue); }
  });
}
