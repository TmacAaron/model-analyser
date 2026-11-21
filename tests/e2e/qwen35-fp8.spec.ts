import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ProjectDocument } from '@model-analyser/contracts';
import { makeModelProject } from '../../scripts/model-project.js';
import { makeQwenHybridParallelAssets } from '../../scripts/qwen-hybrid-parallel.js';

test('switches the 397B checkpoint weights on one configuration and opens a working EP8 KV budget', async ({ page }) => {
  test.setTimeout(420_000);
  const project = makeModelProject(makeQwenHybridParallelAssets('qwen35', 3), {
    kind: 'prefill', batchSize: 1, queryTokensPerRequest: 1, pastTokensPerRequest: 0,
  }, 'Qwen3.5 weight format');
  project.projectId = randomUUID();
  await page.goto('/');
  await page.getByLabel('导入模型工作区').setInputFiles({ name: 'qwen35-weights.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '量化', exact: true }).click();
  await page.getByRole('button', { name: '更新模型到 r5', exact: true }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');
  await page.getByRole('button', { name: '设备', exact: true }).click();
  const device = page.getByLabel('设备型号', { exact: true });
  await device.selectOption('builtin:hardware:nvidia-a100-sxm-80gb@1');
  await expect(device).toHaveValue('builtin:hardware:nvidia-a100-sxm-80gb@1');
  await expect(page.locator('.device-settings')).toContainText('74.5058 GiB');
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 3');

  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await page.getByLabel('MoE EP', { exact: true }).fill('8');
  const layout = page.getByRole('region', { name: '逻辑分片与通信' });
  await layout.getByRole('button', { name: '校验布局' }).click();
  await expect(layout).toContainText('8 个实际设备 · 60 个通信', { timeout: 120_000 });
  await layout.getByRole('button', { name: '应用并行度' }).click();
  await expect(page.locator('.canvas-status')).toContainText('8 物理设备');
  await expect(page.locator('.studio-save')).toContainText('已保存');
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('显存不足', { timeout: 120_000 });

  await page.getByRole('button', { name: '＋ 复制配置', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { name: '量化', exact: true }).click();
  const formats = page.getByRole('group', { name: '发布权重格式' });
  await expect(formats.getByRole('button', { name: '原始权重' })).toHaveAttribute('aria-pressed', 'true');
  await formats.getByRole('button', { name: '官方 FP8 权重' }).click();
  await expect(formats.getByRole('button', { name: '官方 FP8 权重' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.studio-save')).toContainText('已保存');
  await page.getByRole('button', { name: '容量', exact: true }).click();
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/, { timeout: 120_000 });
  await expect(capacity).toContainText('每卡复制 30,720 B / token');

  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  const results = page.locator('.analysis-cards');
  await expect(results).toContainText('最大每卡生命周期峰值', { timeout: 120_000 });
  await expect(results.getByRole('button', { name: '查看理论耗时 · 串行来源' })).not.toContainText('不可用');
  const response = await page.request.get('/api/v1/project?id=' + project.projectId);
  expect(response.ok()).toBe(true);
  const saved = ProjectDocument.parse((await response.json()).data);
  expect(saved.scenarios.map(scenario => scenario.quantizationOverrides.length)).toEqual([0, 1]);
  expect(saved.scenarios[1]?.model.revision).toBe(5);
  expect(saved.scenarios[1]?.parallelPlan.communications).toHaveLength(60);
  await page.reload();
  await page.getByRole('tab').nth(1).click();
  await page.getByRole('button', { name: '量化', exact: true }).click();
  await expect(formats.getByRole('button', { name: '官方 FP8 权重' })).toHaveAttribute('aria-pressed', 'true');
  await formats.getByRole('button', { name: '原始权重' }).click();
  await expect(formats.getByRole('button', { name: '原始权重' })).toHaveAttribute('aria-pressed', 'true');
});

test('keeps a pinned FP8 choice when upgrading and applying Qwen3.5 PP × Attention TP', async ({ page }) => {
  test.setTimeout(180_000);
  const project = makeModelProject(makeQwenHybridParallelAssets('qwen35', 4), {
    kind: 'prefill', batchSize: 2, queryTokensPerRequest: 2, pastTokensPerRequest: 3,
  }, 'Qwen3.5 FP8 pipeline');
  project.scenarios[0]!.bindings = [{ parameterKey: 'Periods', value: { kind: 'integer', value: 3 } }];
  project.projectId = randomUUID();
  await page.goto('/');
  await page.getByLabel('导入模型工作区').setInputFiles({ name: 'qwen35-pipeline.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  const savedStatus = page.locator('.studio-save');
  await expect(savedStatus).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '量化', exact: true }).click();
  const format = page.getByRole('button', { name: '官方 FP8 权重', exact: true });
  await format.click();
  await expect(savedStatus).toContainText('已保存 · 修订 2');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  const tp = page.getByLabel('Attention TP', { exact: true });
  const dp = page.getByLabel('Attention DP', { exact: true });
  const layout = page.getByRole('region', { name: '逻辑分片与通信' });
  await tp.fill('2');
  await dp.fill('2');
  await layout.getByRole('button', { name: '校验布局', exact: true }).click();
  await expect(layout).toContainText('4 个实际设备 · 12 个通信');
  await layout.getByRole('button', { name: '应用并行度', exact: true }).click();
  await expect(savedStatus).toContainText('已保存 · 修订 3');
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await page.getByRole('button', { name: '容量', exact: true }).click();
  await expect(capacity).toContainText('显存不足');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await page.getByRole('button', { name: '更新模型到 r5', exact: true }).click();
  const savedUpgrade = savedStatus.filter({ hasText: '已保存 · 修订 4' });
  const upgradeError = page.locator('.studio-error');
  await expect(savedUpgrade.or(upgradeError)).toBeVisible({ timeout: 60_000 });
  expect(await upgradeError.allTextContents()).toEqual([]);
  await expect(savedUpgrade).toBeVisible();
  await expect(tp).toHaveValue('2');
  await expect(dp).toHaveValue('2');
  await page.getByRole('button', { name: '量化', exact: true }).click();
  await expect(format).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await page.getByLabel('序列与流水线 PP', { exact: true }).fill('2');
  await dp.fill('1');
  await layout.getByRole('button', { name: '校验布局', exact: true }).click();
  await expect(layout).toContainText('4 个实际设备 · 13 个通信');
  await layout.getByRole('button', { name: '应用并行度', exact: true }).click();
  await expect(savedStatus).toContainText('已保存 · 修订 5');
  await page.reload();
  await page.getByRole('button', { name: '容量', exact: true }).click();
  await expect(capacity).toContainText('6,144 B / token');
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/);
  const response = await page.request.get('/api/v1/project?id=' + project.projectId);
  expect(response.ok()).toBe(true);
  const saved = ProjectDocument.parse((await response.json()).data);
  expect(saved.scenarios[0]).toMatchObject({ model: { revision: 5 },
    quantizationOverrides: [{ preset: { assetId: 'builtin:quantization:qwen3.5-397b-a17b-fp8-weights', revision: 2 } }],
    parallelPlan: { generatedFrom: { presetId: 'pp-decoder', pipelineTp: 2 } } });
  expect(saved.assetSnapshots.filter(asset => asset.assetId.endsWith('-fp8-weights')).map(asset => asset.revision)).toEqual([1, 2]);
});
