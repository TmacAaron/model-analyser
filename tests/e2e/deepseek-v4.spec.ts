import { expect, test } from '@playwright/test';

const node = (id: string) => '[data-node-id="' + id + '"]';

test('opens V4 Flash with repeated layers, real branches, and a numeric compressed-cache budget', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const catalog = page.getByLabel('当前模型', { exact: true });
  await catalog.selectOption('builtin:model:deepseek-v4-flash');
  await expect(page.locator('.canvas-breadcrumb')).toContainText('DeepSeek-V4-Flash');
  await expect(page.locator(node('window-hash'))).toContainText('2 ×');
  await expect(page.locator(node('decoder'))).toContainText('20 ×');
  await page.locator(node('csa-hash')).press('Enter');
  const owner = 'csa-hash/';
  for (const name of ['q-a', 'q-b', 'kv-project', 'attn-hc-merge', 'ffn-hc-merge']) {
    await expect(page.locator(node(owner + name))).toBeVisible();
  }
  for (const [from, to] of [
    ['ffn-rmsnorm', '$view:routed'], ['ffn-rmsnorm', '$view:shared'],
    ['$view:routed', 'shared-add'], ['$view:shared', 'shared-add'],
  ]) {
    await expect(page.locator('[role="img"][aria-label$="' + owner + from + ' → ' + owner + to + '"]')).toHaveCount(1);
  }
  await page.locator(node(owner + '$view:attention')).press('Enter');
  await expect(page.locator(node(owner + 'q-b'))).toHaveCount(0);
  await page.locator(node(owner + 'main-pool')).press('Space');
  await expect(page.getByRole('region', { name: '门控分组压缩 计算步骤' })).toContainText('softmaxₜ');

  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('1,415,744 B / token', { timeout: 45_000 });
  await expect(capacity).toContainText('0 token / 请求');
  await expect(capacity).toContainText('固定窗口 128 token');
  await expect(capacity).toContainText('每 4 / 128 个 token 生成一行压缩缓存');
  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  await expect(page.locator('.analysis-cards')).toContainText('理论耗时 · 串行', { timeout: 45_000 });
  await expect(page.locator('.analysis-cards')).not.toContainText('不可用');
});
