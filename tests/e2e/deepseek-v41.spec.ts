import { expect, test } from '@playwright/test';

const node = (id: string) => '[data-node-id="' + id + '"]';

test('shows V4.1 cache reuse, Engram internals and the physical budget on the canvas', async ({ page }) => {
  test.setTimeout(125_000);
  await page.goto('/');
  const catalog = page.getByLabel('当前模型', { exact: true });
  await catalog.selectOption('builtin:model:deepseek-v4.1-flash');
  await expect(page.locator('.canvas-breadcrumb')).toContainText('DeepSeek-V4.1-Flash');
  await expect(page.locator(node('r2'))).toContainText('2 ×');
  await page.locator(node('r1')).press('Enter');
  await expect(page.locator(node('r1/reindex'))).toContainText('4 ×');
  const candidate = page.locator('[role="img"][aria-label*="candidate-mask"][aria-label$="r1/candidate-source → r1/reindex"]');
  await expect(candidate).toHaveCount(1);
  await page.locator(node('r1/reindex')).press('Enter');
  await expect(page.locator(node('r1/reindex[0]/reuse'))).toContainText('3 ×');
  await page.locator(node('r1/reindex[0]/source')).press('Enter');
  await expect(page.locator(node('r1/reindex[0]/source/kv-project'))).toBeVisible();
  await page.locator(node('r1/reindex[0]/source/$view:attention')).press('Enter');
  await expect(page.locator(node('r1/reindex[0]/source/candidate-mask-apply'))).toBeVisible();
  await expect(page.locator(node('r1/reindex[0]/source/main-write'))).toHaveCount(0);

  await page.locator('.canvas-breadcrumb').getByRole('button', { name: /DeepSeek-V4.1-Flash/ }).click();
  await page.locator(node('window-engram')).press('Enter');
  await page.locator(node('window-engram/$view:engram')).press('Enter');
  await page.locator(node('window-engram/engram-gate')).press('Space');
  await expect(page.getByRole('region', { name: 'Engram 残差注入 计算步骤' })).toContainText('√max');

  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('1,313,920 B / token', { timeout: 45_000 });
  await expect(capacity).toContainText('0 token / 请求');
  await expect(capacity).toContainText('含索引缓存');
  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  const cards = page.locator('.analysis-cards');
  await expect(cards).toContainText('理论耗时 · 串行', { timeout: 45_000 });
  await expect(cards).not.toContainText('不可用');
});

test('renders both actual Decode steps for the full V4.1 model', async ({ page }) => {
  test.setTimeout(125_000);
  await page.goto('/');
  await page.getByLabel('当前模型', { exact: true }).selectOption('builtin:model:deepseek-v4.1-flash');
  await expect(page.locator('.canvas-breadcrumb')).toContainText('DeepSeek-V4.1-Flash');
  await page.getByRole('button', { name: '推理配置', exact: true }).click();
  await page.getByLabel('画布推理阶段', { exact: true }).selectOption('decode');
  await page.getByLabel('画布 queryTokensPerRequest', { exact: true }).fill('1');
  await page.getByLabel('画布 contextTokensPerRequest', { exact: true }).fill('2');
  await page.getByLabel('画布 steps', { exact: true }).fill('2');
  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  const decode = page.locator('.decode-results');
  await expect(decode.getByRole('row').filter({ hasText: '2 → 3' })).toBeVisible({ timeout: 95_000 });
  await expect(decode.getByRole('row').filter({ hasText: '3 → 4' })).toBeVisible();
  await decode.getByLabel('查看 Decode 步骤', { exact: true }).selectOption('1');
  await expect(decode).toContainText('步骤输入');
});
