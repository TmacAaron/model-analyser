import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { DeviceId, ProjectDocument } from '@model-analyser/contracts';
import { makeQwen17Project } from '../../scripts/model-expansion.js';

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
  await page.getByRole('button', { name: '更新模型到 r2', exact: true }).click();
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
  expect(current.model.revision).toBe(2);
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
