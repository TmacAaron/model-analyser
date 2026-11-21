import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ProjectDocument } from '@model-analyser/contracts';
import { makeDeepSeekV3ParallelAssets } from '../../scripts/deepseek-v3-parallel.js';
import { makeModelProject } from '../../scripts/model-project.js';

test('runs full DeepSeek-V3 FP8 execution with balanced expert routing', async ({ page }) => {
  test.setTimeout(420_000);
  const project = makeModelProject(makeDeepSeekV3ParallelAssets('v3'), {
    kind: 'prefill', batchSize: 1, pastTokensPerRequest: 0, queryTokensPerRequest: 1,
  }, 'DeepSeek-V3 FP8 execution');
  project.projectId = randomUUID();
  await page.goto('/');
  await page.getByLabel('导入模型工作区', { exact: true }).setInputFiles({
    name: 'deepseek-v3-fp8-execution.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  const save = page.locator('.studio-save');
  await expect(save).toContainText('已保存 · 修订 1');

  await page.getByRole('button', { name: '设备', exact: true }).click();
  await page.getByLabel('设备型号', { exact: true }).selectOption('builtin:hardware:nvidia-h100-sxm-80gb@2');
  await expect(save).toContainText('已保存 · 修订 2');
  await page.getByRole('button', { name: '量化', exact: true }).click();
  await page.getByRole('button', { name: '官方 FP8 权重', exact: true }).click();
  await expect(save).toContainText('已保存 · 修订 3');

  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  const degrees = [['序列与流水线 PP', '3'], ['Attention TP', '4'], ['MoE EP', '2'], ['MoE TP', '2']] as const;
  for (const [label, degree] of degrees) {
    await page.getByLabel(label, { exact: true }).fill(degree);
  }
  const layout = page.getByRole('region', { name: '逻辑分片与通信' });
  await expect(layout).toContainText('路由专家均分 · 每 token 使用全局 Top‑K');
  await layout.getByRole('button', { name: '校验布局' }).click();
  await expect(layout).toContainText('12 个实际设备 · 121 个通信', { timeout: 120_000 });
  await layout.getByRole('button', { name: '应用并行度' }).click();
  await expect(save).toContainText('已保存 · 修订 4');

  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  const checkCapacity = async () => {
    await page.getByRole('button', { name: '容量', exact: true }).click();
    await expect(capacity).toContainText('281,088 B / token', { timeout: 120_000 });
    await expect(capacity).toContainText('163,840 token / 请求');
  };
  await checkCapacity();
  await page.getByRole('button', { name: '＋ 复制配置', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(save).toContainText('已保存 · 修订 5');
  await page.getByRole('button', { name: '量化', exact: true }).click();
  const execution = page.getByRole('button', { name: 'FP8 执行', exact: true });
  await execution.click();
  await expect(execution).toHaveAttribute('aria-pressed', 'true');
  await expect(save).toContainText('已保存 · 修订 6');
  await checkCapacity();

  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  const results = page.locator('.analysis-cards');
  await expect(results).toContainText('fp8_e4m3fn → fp32', { timeout: 120_000 });
  await expect(results).toContainText('bf16 → fp32');
  await expect(results.getByRole('button', { name: '查看理论耗时 · 串行来源' })).not.toContainText('不可用');
  const saved = ProjectDocument.parse((await (await page.request.get('/api/v1/project?id=' + project.projectId)).json()).data);
  expect(saved.scenarios.map(row => row.quantizationOverrides[0]?.preset?.assetId))
    .toEqual(['builtin:quantization:deepseek-v3-fp8-weights', 'builtin:quantization:deepseek-v3-fp8-execution']);
  expect(saved.scenarios[1]?.parallelPlan).toEqual(saved.scenarios[0]?.parallelPlan);
  await page.reload();
  await page.getByRole('tab').nth(1).click();
  await page.getByRole('button', { name: '量化', exact: true }).click();
  await expect(execution).toHaveAttribute('aria-pressed', 'true');
});
