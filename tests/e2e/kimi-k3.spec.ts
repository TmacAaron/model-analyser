import { expect, test } from '@playwright/test';

const node = (id: string) => '[data-node-id="' + id + '"]';

test('explores Kimi-K3 depth archives, KDA and the two latent expert branches from the canvas', async ({ page }) => {
  test.setTimeout(160_000);
  await page.goto('/');
  await page.getByLabel('当前模型', { exact: true }).selectOption('builtin:model:kimi-k3');
  const root = page.locator('.canvas-breadcrumb').getByRole('button', { name: /Kimi-K3/ });
  await expect(root).toBeVisible();
  await expect(page.locator(node('blocks'))).toContainText('6 ×', { timeout: 50_000 });
  await expect(page.locator('[role="img"][aria-label*="main-archive"][aria-label$="blocks → tail"]')).toHaveCount(1);
  await page.locator(node('blocks')).press('Enter');
  await expect(page.locator(node('blocks[0]/cycle'))).toContainText('2 ×');
  await page.locator(node('blocks[0]/boundary')).press('Enter');
  await expect(page.locator(node('blocks[0]/boundary/kda-qkv'))).toBeVisible();
  await expect(page.locator(node('blocks[0]/boundary/archive-residual'))).toBeVisible();
  await expect(page.locator(node('blocks[0]/boundary/$view:routed'))).toContainText('Latent MoE');
  await expect(page.locator(node('blocks[0]/boundary/$view:shared'))).toContainText('Shared Experts');
  await page.locator(node('blocks[0]/boundary/$view:attention')).press('Enter');
  await page.locator(node('blocks[0]/boundary/bounded-decay')).press('Space');
  await expect(page.getByRole('region', { name: 'Kimi Delta Attention 计算步骤' })).toContainText('−5');

  await root.click();
  await page.locator(node('tail')).press('Enter');
  await page.locator(node('tail/final-full')).press('Enter');
  await expect(page.locator(node('tail/final-full/$view:attention'))).toContainText('Gated MLA · NoPE');
  await expect(page.locator(node('tail/final-full/kv-a'))).toBeVisible();
  await page.locator(node('tail/final-full/q-rmsnorm')).press('Space');
  await expect(page.getByRole('region', { name: 'RMSNorm 计算步骤' })).toContainText('10⁻⁶');

  await root.click();
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('27,648 B / token', { timeout: 75_000 });
  await expect(capacity).toContainText('0 token / 请求');
  await capacity.getByText('逐卡显存与缓存分配', { exact: true }).click();
  await expect(capacity.getByRole('row', { name: /^gpu0/ })).toContainText('433.4063 MiB');
  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  const cards = page.locator('.analysis-cards');
  await expect(cards).toContainText('理论耗时 · 串行', { timeout: 75_000 });
  await expect(cards).not.toContainText('不可用');
});

test('analyzes two actual Decode steps of the full Kimi-K3 model', async ({ page }) => {
  test.setTimeout(190_000);
  await page.goto('/');
  await page.getByLabel('当前模型', { exact: true }).selectOption('builtin:model:kimi-k3');
  await expect(page.locator('.canvas-breadcrumb')).toContainText('Kimi-K3');
  await page.getByRole('button', { name: '推理配置', exact: true }).click();
  await page.getByLabel('画布推理阶段', { exact: true }).selectOption('decode');
  await page.getByLabel('画布 queryTokensPerRequest', { exact: true }).fill('1');
  await page.getByLabel('画布 contextTokensPerRequest', { exact: true }).fill('2');
  await page.getByLabel('画布 steps', { exact: true }).fill('2');
  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  const decode = page.locator('.decode-results');
  await expect(decode.getByRole('row').filter({ hasText: '2 → 3' })).toBeVisible({ timeout: 145_000 });
  await expect(decode.getByRole('row').filter({ hasText: '3 → 4' })).toBeVisible();
  await decode.getByLabel('查看 Decode 步骤', { exact: true }).selectOption('1');
  await expect(decode).toContainText('步骤输入');
});
