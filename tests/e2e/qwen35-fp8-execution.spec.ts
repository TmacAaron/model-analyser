import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ProjectDocument } from '@model-analyser/contracts';
import { makeModelProject } from '../../scripts/model-project.js';
import { makeQwenHybridParallelAssets } from '../../scripts/qwen-hybrid-parallel.js';

test('runs native FP8 analysis on the Qwen3.5 EP8 configuration and restores it on reload', async ({ page }) => {
  test.setTimeout(420_000);
  const project = makeModelProject(makeQwenHybridParallelAssets('qwen35', 4), {
    kind: 'prefill', batchSize: 1, queryTokensPerRequest: 1, pastTokensPerRequest: 0,
  }, 'Qwen3.5 FP8 execution');
  project.projectId = randomUUID();
  await page.goto('/');
  await page.getByLabel('导入模型工作区').setInputFiles({ name: 'qwen35-native-fp8.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  const save = page.locator('.studio-save');
  await expect(save).toContainText('已保存 · 修订 1');

  await page.getByRole('button', { name: '设备', exact: true }).click();
  const device = page.getByLabel('设备型号', { exact: true });
  const h100 = 'builtin:hardware:nvidia-h100-sxm-80gb@2';
  await device.selectOption(h100);
  await expect(device).toHaveValue(h100);
  await expect(save).toContainText('已保存 · 修订 2');

  await page.getByRole('button', { name: '量化', exact: true }).click();
  const formats = page.getByRole('group', { name: '发布权重格式' });
  const fp8 = formats.getByRole('button', { name: 'FP8 执行', exact: true });
  await fp8.click();
  await expect(fp8).toHaveAttribute('aria-pressed', 'true');
  await expect(formats).toContainText('动态激活缩放');
  await expect(save).toContainText('已保存 · 修订 3');

  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await page.getByLabel('MoE EP', { exact: true }).fill('8');
  const layout = page.getByRole('region', { name: '逻辑分片与通信' });
  await layout.getByRole('button', { name: '校验布局' }).click();
  await expect(layout).toContainText('8 个实际设备 · 60 个通信', { timeout: 120_000 });
  await layout.getByRole('button', { name: '应用并行度' }).click();
  await expect(save).toContainText('已保存 · 修订 4');
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/, { timeout: 120_000 });
  await expect(capacity).toContainText('每卡复制 30,720 B / token');

  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  const results = page.locator('.analysis-cards');
  await expect(results).toContainText('fp8_e4m3fn → fp32', { timeout: 120_000 });
  await expect(results).toContainText('bf16 → fp32');
  await expect(results.getByRole('button', { name: '查看理论耗时 · 串行来源' })).not.toContainText('不可用');
  const response = await page.request.get('/api/v1/project?id=' + project.projectId);
  expect(response.ok()).toBe(true);
  const saved = ProjectDocument.parse((await response.json()).data);
  expect(saved.scenarios[0]?.quantizationOverrides.map(rule => rule.preset?.assetId)).toEqual(['builtin:quantization:qwen3.5-397b-a17b-fp8-execution']);
  expect(saved.scenarios[0]?.deviceTopology.devices.map(row => `${row.hardware.assetId}@${row.hardware.revision}`)).toEqual(Array(8).fill(h100));

  await page.reload();
  await page.getByRole('button', { name: '量化', exact: true }).click();
  await expect(fp8).toHaveAttribute('aria-pressed', 'true');
});
