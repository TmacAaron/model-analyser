import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { ProjectDocument } from '@model-analyser/contracts';
import { makeModelProject } from '../../scripts/model-project.js';
import { makeQwenHybridAssets } from '../../scripts/qwen-hybrid-model.js';
import { makeQwenHybridParallelAssets } from '../../scripts/qwen-hybrid-parallel.js';
import { addQwenPipelinePreset } from '../../scripts/qwen-pipeline.js';

async function applyParallel(page: Page, area: 'Attention TP' | 'MoE TP' | 'MoE EP', degree: number, communications: number) {
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await page.getByLabel(area, { exact: true }).fill(String(degree));
  const preview = page.getByRole('region', { name: '逻辑分片与通信' });
  await expect(preview).toContainText(`${degree} 个逻辑槽位`);
  await preview.getByRole('button', { name: '校验布局' }).click();
  await expect(preview).toContainText(`${degree} 个实际设备 · ${communications} 个通信`, { timeout: 120_000 });
  await preview.getByRole('button', { name: '应用并行度' }).click();
  await expect(page.locator('.canvas-status')).toContainText(`${degree} 物理设备`, { timeout: 45_000 });
  await expect(page.locator('.studio-save')).toContainText('已保存');
}

async function verifyAnalysis(page: Page) {
  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  const results = page.locator('.analysis-cards');
  await expect(results).toContainText('最大每卡生命周期峰值', { timeout: 120_000 });
  await expect(results.getByRole('button', { name: '查看理论耗时 · 串行来源' })).not.toContainText('不可用');
  await expect(results.getByRole('button', { name: '查看估计 HBM 流量来源' })).toContainText('· 算子');
}

test('Qwen3.8 attention TP shards GQA KV separately from DeltaNet state', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await page.getByLabel('当前模型', { exact: true }).selectOption('builtin:model:qwen3.8-27b');
  await expect(page.locator('.canvas-breadcrumb')).toContainText('Qwen3.8-27B');
  await applyParallel(page, 'Attention TP', 4, 64);
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('65,536 B / token', { timeout: 120_000 });
  await expect(capacity).toContainText('每卡分片 16,384 B / token');
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/);
  await capacity.getByText('逐卡显存与缓存分配', { exact: true }).click();
  await expect(capacity.getByRole('row', { name: /^gpu0/ })).toContainText('36.9375 MiB');
  await verifyAnalysis(page);
  await page.reload();
  await expect(page.locator('.canvas-breadcrumb')).toContainText('Qwen3.8-27B');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await expect(page.getByLabel('Attention TP', { exact: true })).toHaveValue('4');
});

test('Qwen3.5-397B expert TP fits the full BF16 text decoder and analyzes the replicated cache', async ({ page }) => {
  test.setTimeout(360_000);
  await page.goto('/');
  await page.getByLabel('当前模型', { exact: true }).selectOption('builtin:model:qwen3.5-397b-a17b');
  await expect(page.locator('.canvas-breadcrumb')).toContainText('Qwen3.5-397B-A17B');
  await page.getByRole('button', { name: '设备', exact: true }).click();
  await page.getByLabel('设备型号', { exact: true }).selectOption('builtin:hardware:amd-mi300x-192gb@1');
  await expect(page.locator('.device-settings')).toContainText('178.8139 GiB');
  await applyParallel(page, 'MoE TP', 8, 60);
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('245,760 B / token', { timeout: 120_000 });
  await expect(capacity).toContainText('每卡复制 30,720 B / token');
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/);
  await verifyAnalysis(page);
});

test('Qwen3.5-397B EP8 shards experts separately from the global TopK selection', async ({ page }) => {
  test.setTimeout(360_000);
  const project = makeModelProject(makeQwenHybridParallelAssets('qwen35'), {
    kind: 'prefill', batchSize: 1, queryTokensPerRequest: 1, pastTokensPerRequest: 0,
  }, 'Qwen3.5-397B EP');
  project.projectId = randomUUID();
  await page.goto('/');
  await page.getByLabel('导入模型工作区').setInputFiles({
    name: 'qwen35-ep.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await page.getByRole('button', { name: '更新模型到 r5', exact: true }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');
  await page.getByRole('button', { name: '设备', exact: true }).click();
  await page.getByLabel('设备型号', { exact: true }).selectOption('builtin:hardware:amd-mi300x-192gb@1');
  await expect(page.locator('.device-settings')).toContainText('178.8139 GiB');
  await applyParallel(page, 'MoE EP', 8, 60);
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('每卡复制 30,720 B / token', { timeout: 120_000 });
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/);
  await verifyAnalysis(page);
  await page.reload();
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await expect(page.getByLabel('MoE EP', { exact: true })).toHaveValue('8');
  await expect(page.getByLabel('MoE TP', { exact: true })).toHaveValue('1');
  await expect(page.getByRole('region', { name: '逻辑分片与通信' })).toContainText('按均衡路由估算负载');
});

test('applies stage-local MoE EP × TP and reopens the Qwen3.5 pipeline layout', async ({ page }) => {
  test.setTimeout(180_000);
  const [root, ...dependencies] = makeQwenHybridParallelAssets('qwen35', 4);
  const model = addQwenPipelinePreset(root!, { requestBatchSharding: true, attentionPresetId: 'tp-hybrid-attention' });
  const project = makeModelProject([model, ...dependencies], {
    kind: 'prefill', batchSize: 1, queryTokensPerRequest: 1, pastTokensPerRequest: 2,
  }, model.name);
  project.scenarios[0]!.bindings = [{ parameterKey: 'Periods', value: { kind: 'integer', value: 3 } }];
  project.projectId = randomUUID();
  await page.goto('/');
  await page.getByLabel('导入模型工作区').setInputFiles({
    name: 'qwen35-pipeline-ep.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  const status = page.locator('.studio-save');
  await expect(status).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  const pp = page.getByLabel('序列与流水线 PP', { exact: true });
  const ep = page.getByLabel('MoE EP', { exact: true });
  const tp = page.getByLabel('MoE TP', { exact: true });
  await pp.fill('2');
  await ep.fill('2');
  await tp.fill('2');
  const layout = page.getByRole('region', { name: '逻辑分片与通信' });
  await expect(layout).toContainText('每阶段 4 卡');
  await expect(layout).toContainText('8 个逻辑槽位');
  await layout.getByText(/^通信参数/).click();
  const intraBand = layout.getByLabel('阶段内归约带宽 (B/s)', { exact: true });
  await intraBand.fill('50000000000');
  await layout.getByRole('button', { name: '校验布局', exact: true }).click();
  await expect(layout).toContainText('8 个实际设备 · 13 个通信', { timeout: 75_000 });
  await layout.getByRole('button', { name: '应用并行度', exact: true }).click();
  await expect(status).toContainText('已保存 · 修订 2');
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('24,576 B / token', { timeout: 75_000 });
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/);
  await verifyAnalysis(page);
  const response = await page.request.get('/api/v1/project?id=' + project.projectId);
  expect(response.ok()).toBe(true);
  const saved = ProjectDocument.parse((await response.json()).data).scenarios[0];
  expect(saved?.parallelPlan.generatedFrom?.pipelineStage).toEqual({ presetId: 'ep-routed', degree: 4 });
  expect(saved?.parallelPlan.generatedFrom?.expertMesh).toMatchObject({ ep: 2, tp: 2 });
  expect(saved?.parallelPlan.communications.find(row => row.operation === 'send_recv')?.peerPairs).toHaveLength(4);
  await page.reload();
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await expect(pp).toHaveValue('2');
  await expect(ep).toHaveValue('2');
  await expect(tp).toHaveValue('2');
  await layout.getByText(/^通信参数/).click();
  await expect(intraBand).toHaveValue('50000000000');
});

test('updates a saved Qwen3.8 r1 workspace to r5 while keeping its workload and device', async ({ page }) => {
  const project = makeModelProject(makeQwenHybridAssets('qwen38'), {
    kind: 'prefill', batchSize: 3, queryTokensPerRequest: 2, pastTokensPerRequest: 31,
  }, 'Qwen3.8 previous revision');
  project.projectId = randomUUID();
  await page.goto('/');
  await page.getByLabel('导入模型工作区').setInputFiles({
    name: 'qwen38-r1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await page.getByRole('button', { name: '更新模型到 r5' }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');
  const response = await page.request.get('/api/v1/project?id=' + project.projectId);
  expect(response.ok()).toBe(true);
  const updated = ProjectDocument.parse((await response.json()).data);
  expect(updated.scenarios[0]).toEqual({ ...project.scenarios[0]!, model: { ...project.scenarios[0]!.model, revision: 5 } });
  expect(updated.assetSnapshots.filter(asset => asset.assetId === project.scenarios[0]!.model.assetId).map(asset => asset.revision)).toEqual([1, 5]);
});

test('upgrades Qwen3.8 PP and applies Attention TP within each stage', async ({ page }) => {
  test.setTimeout(180_000);
  const [root, ...dependencies] = makeQwenHybridParallelAssets('qwen38');
  const model = addQwenPipelinePreset(root!);
  const project = makeModelProject([model, ...dependencies], {
    kind: 'prefill', batchSize: 4, queryTokensPerRequest: 1, pastTokensPerRequest: 2,
  }, model.name);
  project.projectId = randomUUID();
  await page.goto('/');
  await page.getByLabel('导入模型工作区').setInputFiles({
    name: 'qwen38-pipeline.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  const pp = page.getByLabel('序列与流水线 PP', { exact: true });
  const tp = page.getByLabel('Attention TP', { exact: true });
  await pp.fill('2');
  const preview = page.getByRole('region', { name: '逻辑分片与通信' });
  await expect(preview).toContainText('阶段间 SendRecv');
  await preview.getByRole('button', { name: '校验布局' }).click();
  await expect(preview).toContainText('2 个实际设备 · 1 个通信', { timeout: 75_000 });
  await preview.getByRole('button', { name: '应用并行度' }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');
  await page.getByRole('button', { name: '更新模型到 r5', exact: true }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 3');
  await expect(pp).toHaveValue('2');
  await tp.fill('2');
  await expect(preview).toContainText('4 个逻辑槽位');
  await expect(preview).toContainText('阶段内 AllReduce · 阶段间 SendRecv');
  await preview.getByText(/^通信参数/).click();
  const transferBandwidth=preview.getByLabel('阶段间传输带宽 (B/s)',{exact:true});
  const transferLatency=preview.getByLabel('阶段间传输单轮延迟 (s)',{exact:true});
  const reduceBandwidth=preview.getByLabel('阶段内归约带宽 (B/s)',{exact:true});
  const reduceLatency=preview.getByLabel('阶段内归约单轮延迟 (s)',{exact:true});
  await transferBandwidth.fill('20000000000');
  await transferLatency.fill('0.000007');
  await reduceBandwidth.fill('400000000000');
  await reduceLatency.fill('0.000002');
  await preview.getByRole('button', { name: '校验布局' }).click();
  await expect(preview).toContainText('4 个实际设备 · 65 个通信', { timeout: 75_000 });
  await reduceLatency.fill('0.0000015');
  await expect(preview.getByRole('button', { name: '应用并行度' })).toHaveCount(0);
  await preview.getByRole('button', { name: '校验布局' }).click();
  await expect(preview).toContainText('4 个实际设备 · 65 个通信', { timeout: 75_000 });
  await preview.getByRole('button', { name: '应用并行度' }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 4');
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('65,536 B / token', { timeout: 75_000 });
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/);
  const response = await page.request.get('/api/v1/project?id=' + project.projectId);
  expect(response.ok()).toBe(true);
  const scenario = ProjectDocument.parse((await response.json()).data).scenarios[0];
  const reductions=scenario?.parallelPlan.communications.filter(row=>row.operation==='all_reduce');
  expect(reductions).toHaveLength(64);
  expect(reductions?.every(row=>row.timing.kind==='bandwidth_latency'&&row.timing.bytePerSecond===400e9&&row.timing.latencySeconds===1.5e-6)).toBe(true);
  expect(scenario?.parallelPlan.communications.find(row=>row.operation==='send_recv')).toMatchObject({
    timing:{kind:'bandwidth_latency',bytePerSecond:20e9,latencySeconds:7e-6},peerPairs: [
    { sourceDeviceId: 'gpu0', destinationDeviceId: '$degree-rank:2' },
    { sourceDeviceId: '$degree-rank:1', destinationDeviceId: '$degree-rank:3' },
  ] });
  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  await expect(page.locator('.analysis-cards')).toBeVisible({ timeout: 75_000 });
  const inspector = page.locator('.cost-source-inspector');
  await inspector.locator(':scope > summary').click();
  await inspector.getByLabel('查找成本来源范围', { exact: true }).fill('communication:0');
  await inspector.getByLabel('成本来源范围', { exact: true }).selectOption('communication:0');
  const communication = inspector.getByRole('region', { name: '通信运算来源' });
  await communication.getByRole('button', { name: '复核此通信的实际运算', exact: true }).click();
  await expect(communication.getByRole('heading', { name: 'gpu0 · 发送端 · 对端 $degree-rank:2', exact: true })).toBeVisible({ timeout: 75_000 });
  await expect(communication.getByRole('heading', { name: '$degree-rank:3 · 接收端 · 对端 $degree-rank:1', exact: true })).toBeVisible();
  await expect(communication).toContainText('40960 ÷ 20000000000');
  await inspector.getByLabel('查找成本来源范围', { exact: true }).fill('communication:1');
  await inspector.getByLabel('成本来源范围', { exact: true }).selectOption('communication:1');
  await expect(communication).toContainText('40960 ÷ 400000000000', { timeout: 75_000 });
  await page.reload();
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await expect(pp).toHaveValue('2');
  await expect(tp).toHaveValue('2');
  await preview.getByText(/^通信参数/).click();
  await expect(transferBandwidth).toHaveValue('20000000000');
  await expect(transferLatency).toHaveValue('0.000007');
  await expect(reduceBandwidth).toHaveValue('400000000000');
  await expect(reduceLatency).toHaveValue('0.0000015');
  await pp.fill('1');
  await tp.fill('1');
  await preview.getByRole('button', { name: '校验布局' }).click();
  await expect(preview).toContainText('1 个实际设备 · 0 个通信', { timeout: 75_000 });
  await preview.getByRole('button', { name: '应用并行度' }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 5');
});
