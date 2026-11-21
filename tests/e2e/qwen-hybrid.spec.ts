import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { makeModelProject } from '../../scripts/model-project.js';
import { makeQwenHybridParallelAssets } from '../../scripts/qwen-hybrid-parallel.js';

const selector = (id: string) => '[data-node-id="' + id + '"]';

test('opens both published Qwen hybrid models and displays KV separately from fixed recurrent state', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const models = page.getByLabel('当前模型', { exact: true });
  await models.selectOption('builtin:model:qwen3.5-397b-a17b');
  await expect(page.locator('.canvas-breadcrumb')).toContainText('Qwen3.5-397B-A17B');
  await page.locator(selector('final-norm')).press('Space');
  await expect(page.getByRole('region', { name: 'RMSNorm 计算步骤' })).toContainText('1 + γ');
  const decoder = page.locator(selector('decoder'));
  await expect(decoder).toContainText('15 ×');
  await decoder.press('Enter');
  const linear = page.locator(selector('decoder[0]/linear'));
  await expect(linear).toContainText('3 ×');
  await linear.press('Enter');
  const layer = 'decoder[0]/linear[0]/';
  await expect(page.locator(selector(layer + 'delta-qkv'))).toBeVisible();
  for (const branch of ['$view:routed', '$view:shared']) {
    await expect(page.locator(selector(layer + branch))).toBeVisible();
    await expect(page.locator('[role="img"][aria-label$="' + layer + 'post-norm → ' + layer + branch + '"]')).toBeVisible();
    await expect(page.locator('[role="img"][aria-label$="' + layer + branch + ' → ' + layer + 'shared-add"]')).toBeVisible();
  }
  await page.locator(selector(layer + '$view:attention')).press('Enter');
  await expect(page.locator(selector(layer + 'delta-qkv'))).toHaveCount(0);
  await page.locator(selector(layer + 'recurrent')).press('Space');
  await expect(page.getByRole('region', { name: 'Gated DeltaNet 计算步骤' })).toContainText('Sₜ = S̃ₜ + kₜ · δₜᵀ');

  // Use a separate baseline because a prior canvas test may save TP for this model.
  const serial = makeModelProject(makeQwenHybridParallelAssets('qwen38'), {
    kind: 'prefill', batchSize: 1, queryTokensPerRequest: 1, pastTokensPerRequest: 0,
  }, 'Qwen3.8 serial baseline');
  serial.projectId = randomUUID();
  await page.getByLabel('导入模型工作区').setInputFiles({
    name: 'qwen38-serial.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(serial)),
  });
  await expect(page.locator('.canvas-breadcrumb')).toContainText('Qwen3.8-27B');
  await expect(page.locator('.studio-save')).toContainText('已保存');
  await expect(decoder).toContainText('16 ×');
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('65,536 B / token', { timeout: 45_000 });
  await expect(capacity).toContainText(/\d[\d,]+ token \/ 请求/);
  await capacity.getByText('逐卡显存与缓存分配', { exact: true }).click();
  await expect(capacity.getByRole('row', { name: /^gpu0/ })).toContainText('147.75 MiB');
});
