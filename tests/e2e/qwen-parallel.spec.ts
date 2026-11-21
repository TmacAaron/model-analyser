import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { DeviceId, ProjectDocument } from '@model-analyser/contracts';
import { makeQwen17Project } from '../../scripts/model-expansion.js';
import { makeModelProject } from '../../scripts/model-project.js';
import { makeQwenParallelAssets } from '../../scripts/qwen-parallel-assets.js';
import { addQwenContextPreset } from '../../scripts/qwen-context-parallel.js';
import { addQwenPipelinePreset } from '../../scripts/qwen-pipeline.js';

test('upgrades the existing Qwen3-1.7B snapshot and runs full two-card Attention TP', async ({ page }) => {
  test.setTimeout(120_000);
  const project = makeQwen17Project({ kind: 'prefill', batchSize: 1, queryTokensPerRequest: 1, pastTokensPerRequest: 2 });
  project.projectId = randomUUID();
  const scenario = project.scenarios[0]!, first = scenario.deviceTopology.devices[0]!;
  const second = { ...first, deviceId: DeviceId.parse('device_1') };
  scenario.deviceTopology = {
    devices: [first, second],
    groups: [{ groupId: 'main', members: [first.deviceId] }, { groupId: 'previous-pool', members: [first.deviceId, second.deviceId] }],
  };
  await page.goto('/');
  await page.getByLabel('导入模型工作区').setInputFiles({
    name: 'qwen17-old-revision.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await expect(page.locator('.studio-layout-notice')).toContainText('2 张卡');
  await page.getByRole('button', { name: '更新模型到 r4', exact: true }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');
  await page.getByLabel('Attention TP', { exact: true }).fill('2');
  const logical = page.getByRole('region', { name: '逻辑分片与通信' });
  await expect(logical).toContainText('每次模块调用 AllReduce × 1');
  await page.getByLabel('通信带宽 (B/s)', { exact: true }).fill('100000000000');
  await page.getByLabel('单轮延迟 (s)', { exact: true }).fill('0.000001');
  await page.getByRole('button', { name: '校验布局', exact: true }).click();
  await expect(logical).toContainText('2 个实际设备 · 28 个通信', { timeout: 35_000 });
  await page.getByRole('button', { name: '应用并行度', exact: true }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 3');
  const response = await page.request.get('/api/v1/project?id=' + project.projectId);
  expect(response.ok()).toBe(true);
  const current = ProjectDocument.parse((await response.json()).data).scenarios[0]!;
  expect(current.model.revision).toBe(4);
  expect(current.deviceTopology.devices).toEqual([first, second]);
  expect(current.workload).toEqual(scenario.workload);
  expect(current.parallelPlan.communications).toHaveLength(28);
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量', exact: true });
  await expect(capacity).toContainText('114,688 B / token', { timeout: 35_000 });
  await expect(capacity).toContainText(/\d[\d,]+ token \/ 请求/);
  await capacity.getByText('逐卡显存与缓存分配', { exact: true }).click();
  await expect(capacity.getByRole('row', { name: /^gpu0/ })).toContainText('168 KiB');
  await expect(capacity.getByRole('row', { name: /^device_1/ })).toContainText('168 KiB');
  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  const cards = page.locator('.studio-inspector .analysis-cards');
  await expect(cards).toContainText('最大每卡生命周期峰值', { timeout: 35_000 });
  await expect(cards.getByRole('button', { name: '查看理论耗时 · 串行来源', exact: true })).toContainText('ms');
  await expect(cards.getByRole('button', { name: '查看最大每卡生命周期峰值来源', exact: true })).toContainText('GiB');
  const hbm = cards.getByRole('button', { name: '查看估计 HBM 流量来源', exact: true });
  await expect(hbm).toContainText('算子');
  await expect(hbm).toContainText('通信本地 HBM 待核定');
});

test('applies full Qwen3 PCP with replicated KV, restores the degree and returns to one card', async ({ page }) => {
  test.setTimeout(150_000);
  const base = makeQwenParallelAssets();
  const root = base.find(row => row.assetId === 'builtin:model:qwen3-0.6b')!;
  const decoder = base.find(row => row.definition.kind === 'module')!;
  const assets = [...addQwenContextPreset(decoder, [addQwenPipelinePreset(root)]), ...base.filter(row => row.definition.kind === 'formula')];
  const project = makeModelProject(assets, { kind: 'prefill', batchSize: 1, queryTokensPerRequest: 4, pastTokensPerRequest: 3 }, 'Qwen3-0.6B PCP');
  project.projectId = randomUUID();
  await page.goto('/');
  await page.getByLabel('导入模型工作区').setInputFiles({
    name: 'qwen06-pcp.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  const pcp = page.getByLabel('序列与流水线 PCP', { exact: true });
  await pcp.fill('2');
  const logical = page.getByRole('region', { name: '逻辑分片与通信' });
  await expect(logical).toContainText('每个注意力层收集当前 K 和 V');
  await logical.getByRole('button', { name: '校验布局' }).click();
  await expect(logical).toContainText('2 个实际设备 · 56 个通信', { timeout: 45_000 });
  await logical.getByRole('button', { name: '应用并行度' }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量', exact: true });
  await expect(capacity).toContainText('每卡复制 114,688 B / token', { timeout: 45_000 });
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/);
  const response = await page.request.get('/api/v1/project?id=' + project.projectId);
  expect(response.ok()).toBe(true);
  const applied = ProjectDocument.parse((await response.json()).data).scenarios[0];
  expect(applied?.parallelPlan.communications.every(row => row.operation === 'all_gather')).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await expect(pcp).toHaveValue('2');
  await pcp.fill('1');
  await logical.getByRole('button', { name: '校验布局' }).click();
  await expect(logical).toContainText('1 个实际设备 · 0 个通信', { timeout: 45_000 });
  await logical.getByRole('button', { name: '应用并行度' }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 3');
});

test('uses isolated request groups for DP2 × TP2 and returns to two cards when DP is cleared', async ({ page }) => {
  test.setTimeout(150_000);
  const assets = makeQwenParallelAssets().filter(asset => asset.assetId !== 'builtin:model:qwen3-0.6b');
  const project = makeModelProject(assets, { kind: 'prefill', batchSize: 4, queryTokensPerRequest: 1, pastTokensPerRequest: 2 }, 'Qwen3-1.7B DP × TP');
  project.projectId = randomUUID();
  await page.goto('/');
  await page.getByLabel('导入模型工作区').setInputFiles({
    name: 'qwen17-dp-tp.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  const tp = page.getByLabel('Attention TP', { exact: true });
  const dp = page.getByLabel('Attention DP', { exact: true });
  await tp.fill('2');
  await dp.fill('2');
  const logical = page.getByRole('region', { name: '逻辑分片与通信' });
  await expect(logical).toContainText('4 个逻辑槽位 · 2 组请求，每组 2 卡');
  await page.getByLabel('通信带宽 (B/s)', { exact: true }).fill('100000000000');
  await page.getByLabel('单轮延迟 (s)', { exact: true }).fill('0.000001');
  await logical.getByRole('button', { name: '校验布局' }).click();
  await expect(logical).toContainText('4 个实际设备 · 28 个通信', { timeout: 40_000 });
  await logical.getByRole('button', { name: '应用并行度' }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');

  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量', exact: true });
  await expect(capacity).toContainText('本组每卡 57,344 B / token', { timeout: 40_000 });
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/);
  await capacity.getByText('逐卡显存与缓存分配', { exact: true }).click();
  await expect(capacity.getByRole('row', { name: /^gpu0/ })).toContainText('336 KiB');

  await page.reload();
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await expect(tp).toHaveValue('2');
  await expect(dp).toHaveValue('2');
  await dp.fill('1');
  await logical.getByRole('button', { name: '校验布局' }).click();
  await expect(logical).toContainText('2 个实际设备 · 28 个通信', { timeout: 40_000 });
  await logical.getByRole('button', { name: '应用并行度' }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 3');
});
