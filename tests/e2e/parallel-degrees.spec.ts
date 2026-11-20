import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DeviceId, ProjectDocument } from '@model-analyser/contracts';
import { makeGqaBaseProject, makeGqaProject } from '../../scripts/gqa-project.js';
import { makeNamedParallelBase } from '../../scripts/named-parallel-project.js';
import { makeQwen17Project } from '../../scripts/model-expansion.js';

async function importProject(page: Page, project: ProjectDocument) {
  project.projectId = randomUUID();
  await page.goto('/');
  await page.getByLabel('导入模型工作区').setInputFiles({
    name: 'parallel-degrees.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
}

async function storedProject(page: Page, project: ProjectDocument) {
  const response = await page.request.get('/api/v1/project?id=' + project.projectId);
  expect(response.ok()).toBe(true);
  return ProjectDocument.parse((await response.json()).data);
}

async function validateLayout(page: Page) {
  await page.getByLabel('通信带宽 (B/s)', { exact: true }).fill('1000');
  await page.getByLabel('单轮延迟 (s)', { exact: true }).fill('0.001');
  await page.getByRole('button', { name: '校验布局', exact: true }).click();
}

test('Attention TP from a single-card configuration previews first and drives persisted KV budgets', async ({ page }) => {
  const project = makeGqaBaseProject(1);
  await importProject(page, project);
  const tp = page.getByLabel('Attention TP', { exact: true });
  const dp = page.getByLabel('Attention DP', { exact: true });
  const layout = page.getByRole('region', { name: '逻辑分片与通信', exact: true });
  await tp.fill('2');
  await expect(layout).toContainText('2 个逻辑槽位');
  await expect(layout).toContainText('AllReduce × 1');
  await expect(page.getByLabel('设备型号', { exact: true })).toHaveCount(0);
  await dp.fill('2');
  await expect(page.locator('.parallel-degree-editor')).toContainText('未声明这组并行度');
  await expect(layout).toHaveCount(0);
  await dp.fill('1');
  await validateLayout(page);
  await expect(layout).toContainText('2 个实际设备 · 1 个通信');
  await expect(layout).toContainText('权重 192 B · 状态 24 B');
  expect((await storedProject(page, project)).scenarios[0]?.deviceTopology.devices).toHaveLength(1);
  await page.getByRole('button', { name: '应用并行度', exact: true }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');
  const saved = (await storedProject(page, project)).scenarios[0]!;
  expect(saved.deviceTopology.devices).toHaveLength(2);
  expect(saved.parallelPlan.generatedFrom?.presetId).toBe('tp-heads');
  await page.getByRole('button', { name: '容量', exact: true }).click();
  await expect(page.getByRole('region', { name: 'KV 缓存容量' })).toContainText('96 token / 请求');

  await page.reload();
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await expect(tp).toHaveValue('2');
  await tp.fill('1');
  await page.getByRole('button', { name: '校验布局', exact: true }).click();
  await expect(layout).toContainText('1 个实际设备 · 0 个通信');
  await page.getByRole('button', { name: '应用并行度', exact: true }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 3');
  const restored = (await storedProject(page, project)).scenarios[0]!;
  expect(restored.deviceTopology.devices).toEqual(project.scenarios[0]?.deviceTopology.devices);
  expect(restored.parallelPlan.communications).toEqual([]);
});

test('MoE EP and expert TP bind the shared physical roles defined by the model', async ({ page }) => {
  const project = makeNamedParallelBase('ep2-tp2');
  const scenario = project.scenarios[0]!;
  scenario.deviceTopology = { devices: scenario.deviceTopology.devices.slice(0, 1), groups: [] };
  await importProject(page, project);
  await page.getByLabel('MoE EP', { exact: true }).fill('2');
  await expect(page.locator('.parallel-degree-editor')).toContainText('未声明这组并行度');
  await page.getByLabel('MoE TP', { exact: true }).fill('2');
  const layout = page.getByRole('region', { name: '逻辑分片与通信', exact: true });
  await expect(layout).toContainText('4 个逻辑槽位');
  await validateLayout(page);
  await expect(layout).toContainText('4 个实际设备');
  await page.getByRole('button', { name: '应用并行度', exact: true }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');
  const saved = (await storedProject(page, project)).scenarios[0]!;
  expect(saved.parallelPlan.nativeBindings?.groups.map(group => group.logicalGroupId)).toEqual(['world', 'grid', 'tp0', 'tp1']);
  expect(saved.deviceTopology.devices).toHaveLength(4);
});

test('a custom profile applies to all parallel cards and updates the same KV calculation', async ({ page }) => {
  const { project } = await makeGqaProject('tp-heads');
  await importProject(page, project);
  await page.getByRole('button', { name: '设备', exact: true }).click();
  const panel = page.locator('.device-settings');
  await expect(panel.getByLabel('设备型号', { exact: true })).toHaveCount(1);
  await expect(panel).toContainText('2 卡');
  await panel.getByRole('button', { name: '自定义参数', exact: true }).click();
  await panel.getByLabel('硬件容量 byte', { exact: true }).fill('2048');
  await panel.getByRole('button', { name: '应用自定义参数', exact: true }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');
  const saved = await storedProject(page, project);
  const current = saved.scenarios[0]!;
  const profile = saved.assetSnapshots.find(asset => asset.assetId === current.deviceTopology.devices[0]!.hardware.assetId);
  expect(current.deviceTopology.devices.map(device => device.deviceId)).toEqual(['gpu0', 'gpu1']);
  expect(current.deviceTopology.devices[0]!.hardware).toEqual(current.deviceTopology.devices[1]!.hardware);
  expect(profile?.definition).toMatchObject({ kind: 'hardware', hardware: { capacityBytes: 2048 } });
  expect(current.parallelPlan).toEqual(project.scenarios[0]?.parallelPlan);
  await page.getByRole('button', { name: '容量', exact: true }).click();
  await expect(page.getByRole('region', { name: 'KV 缓存容量' })).toContainText('224 token / 请求');
});

test('explains unbound cards and makes an independent single-card configuration with actual results', async ({ page }) => {
  const project = makeQwen17Project({ kind: 'prefill', batchSize: 1, queryTokensPerRequest: 1, pastTokensPerRequest: 0 });
  const original = project.scenarios[0]!;
  original.name = '双卡基准';
  original.deviceTopology = {
    devices: [original.deviceTopology.devices[0]!, { ...original.deviceTopology.devices[0]!, deviceId: DeviceId.parse('device_1') }],
    groups: [{ groupId: 'main', members: [original.deviceTopology.devices[0]!.deviceId] }],
  };
  await importProject(page, project);
  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  const notice = page.locator('.studio-layout-notice');
  await expect(notice).toContainText('2 张卡尚未应用当前阶段的并行布局');
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量', exact: true });
  await expect(capacity).toContainText('待核定');
  await expect(notice).toContainText('2 张卡');
  await notice.getByRole('button', { name: '新建单卡配置', exact: true }).click();
  await expect(page.getByRole('tab', { name: /^双卡基准 · 单卡/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');
  await expect(capacity).toContainText('114,688 B / token');
  await expect(notice).toHaveCount(0);
  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  const cards = page.locator('.studio-inspector .analysis-cards');
  await expect(cards).toContainText('生命周期显存峰值');
  await expect(cards).not.toContainText('不可用');
  const saved = await storedProject(page, project);
  expect(saved.scenarios[0]).toEqual(original);
  expect(saved.scenarios[1]?.deviceTopology.devices).toEqual(original.deviceTopology.devices.slice(0, 1));
  expect(saved.scenarios[1]?.workload).toEqual(original.workload);
});
