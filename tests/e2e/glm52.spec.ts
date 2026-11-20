import { expect, test } from '@playwright/test';

const node = (id: string) => '[data-node-id="' + id + '"]';

test('explores GLM-5.2 index reuse and shows the graph-derived KV budget and analysis', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await page.getByLabel('当前模型', { exact: true }).selectOption('builtin:model:glm-5.2');
  const root = page.locator('.canvas-breadcrumb').getByRole('button', { name: /GLM-5\.2/ });
  await expect(root).toBeVisible();
  await expect(page.locator(node('dense'))).toContainText('3 ×', { timeout: 45_000 });
  await expect(page.locator(node('shared-prefix'))).toContainText('3 ×');
  await expect(page.locator(node('decoder'))).toContainText('18 ×');
  await expect(page.locator('[role="img"][aria-label*="selected-rows"][aria-label$="dense → shared-prefix"]')).toHaveCount(1);
  await page.locator(node('decoder')).press('Enter');
  await page.locator(node('decoder[0]/source')).press('Enter');
  await expect(page.locator(node('decoder[0]/source/q-a'))).toBeVisible();
  await expect(page.locator(node('decoder[0]/source/kv-a'))).toBeVisible();
  await expect(page.locator(node('decoder[0]/source/$view:attention'))).toContainText('Sparse MLA');
  await expect(page.locator(node('decoder[0]/source/$view:routed'))).toContainText('Routed Experts');
  await expect(page.locator(node('decoder[0]/source/$view:shared'))).toContainText('Shared Expert');
  await page.locator(node('decoder[0]/source/$view:indexer')).press('Enter');
  await page.locator(node('decoder[0]/source/index-topk')).press('Space');
  await expect(page.getByRole('region', { name: 'DSA 因果索引选择 计算步骤' })).toContainText('2048');

  await root.click();
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('95,232 B / token', { timeout: 60_000 });
  await expect(capacity).toContainText('0 token / 请求');
  await expect(capacity).toContainText('含索引缓存');
  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  const cards = page.locator('.analysis-cards');
  await expect(cards).toContainText('理论耗时 · 串行', { timeout: 60_000 });
  await expect(cards).not.toContainText('不可用');
});

test('analyzes two actual Decode steps of the full GLM-5.2 model', async ({ page }) => {
  test.setTimeout(165_000);
  await page.goto('/');
  await page.getByLabel('当前模型', { exact: true }).selectOption('builtin:model:glm-5.2');
  await expect(page.locator('.canvas-breadcrumb')).toContainText('GLM-5.2');
  await page.getByRole('button', { name: '推理配置', exact: true }).click();
  await page.getByLabel('画布推理阶段', { exact: true }).selectOption('decode');
  await page.getByLabel('画布 queryTokensPerRequest', { exact: true }).fill('1');
  await page.getByLabel('画布 contextTokensPerRequest', { exact: true }).fill('2');
  await page.getByLabel('画布 steps', { exact: true }).fill('2');
  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  const decode = page.locator('.decode-results');
  await expect(decode.getByRole('row').filter({ hasText: '2 → 3' })).toBeVisible({ timeout: 115_000 });
  await expect(decode.getByRole('row').filter({ hasText: '3 → 4' })).toBeVisible();
  await decode.getByLabel('查看 Decode 步骤', { exact: true }).selectOption('1');
  await expect(decode).toContainText('步骤输入');
});
