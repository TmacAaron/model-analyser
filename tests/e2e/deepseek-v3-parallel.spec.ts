import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { makeDeepSeekV3ParallelAssets } from '../../scripts/deepseek-v3-parallel.js';
import { makeModelProject } from '../../scripts/model-project.js';

for (const [moeEp, moeTp] of [[8, 1], [4, 2]] as const) test(`eight shared cards run DeepSeek V3 EP${moeEp} × MoE TP${moeTp} from the canvas`, async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/');
  if (moeTp > 1) {
    const project = makeModelProject(makeDeepSeekV3ParallelAssets('v3', 3), {
      kind: 'prefill', batchSize: 1, pastTokensPerRequest: 0, queryTokensPerRequest: 1,
    }, 'DeepSeek-V3 r3 workspace');
    project.projectId = randomUUID();
    await page.getByLabel('导入模型工作区', { exact: true }).setInputFiles({
      name: 'deepseek-v3-r3.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
    });
    await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
    await page.getByRole('button', { name: '并行方式', exact: true }).click();
    await page.getByRole('button', { name: '更新模型到 r4', exact: true }).click();
    await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');
  } else {
    await page.getByLabel('当前模型', { exact: true }).selectOption('builtin:model:deepseek-v3');
  }
  await expect(page.locator('.canvas-breadcrumb')).toContainText('DeepSeek-V3');
  await page.getByRole('button', { name: '设备', exact: true }).click();
  await page.getByLabel('设备型号', { exact: true }).selectOption('builtin:hardware:amd-mi300x-192gb@1');
  await expect(page.locator('.device-settings')).toContainText('178.8139 GiB');
  await expect(page.getByLabel('设备型号', { exact: true })).toHaveValue('builtin:hardware:amd-mi300x-192gb@1');
  await expect(page.locator('.studio-save')).toContainText('已保存');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await page.getByLabel('Attention TP', { exact: true }).fill('8');
  await page.getByLabel('MoE EP', { exact: true }).fill(String(moeEp));
  await page.getByLabel('MoE TP', { exact: true }).fill(String(moeTp));
  const layout = page.getByRole('region', { name: '逻辑分片与通信' });
  await expect(layout).toContainText('8 个逻辑槽位');
  await layout.getByRole('button', { name: '校验布局' }).click();
  await expect(layout).toContainText('8 个实际设备 · 119 个通信', { timeout: 100_000 });
  await layout.getByRole('button', { name: '应用并行度' }).click();
  await expect(page.locator('.canvas-status')).toContainText('8 物理设备', { timeout: 35_000 });
  await expect(page.locator('.studio-save')).toContainText('已保存');

  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('562,176 B / token', { timeout: 100_000 });
  await expect(capacity).toContainText('每卡复制 70,272 B / token');
  await expect(capacity).toContainText('179,931 token / 请求');
  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  const cards = page.locator('.analysis-cards');
  await expect(cards).toContainText('最大每卡生命周期峰值', { timeout: 100_000 });
  await expect(cards.getByRole('button', { name: '查看理论耗时 · 串行来源' })).not.toContainText('不可用');
  await expect(cards.getByRole('button', { name: '查看估计 HBM 流量来源' })).toContainText('· 算子');
  await page.reload();
  await expect(page.locator('.canvas-breadcrumb')).toContainText('DeepSeek-V3');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await expect(page.getByLabel('Attention TP', { exact: true })).toHaveValue('8');
  await expect(page.getByLabel('MoE EP', { exact: true })).toHaveValue(String(moeEp));
  await expect(page.getByLabel('MoE TP', { exact: true })).toHaveValue(String(moeTp));
});
