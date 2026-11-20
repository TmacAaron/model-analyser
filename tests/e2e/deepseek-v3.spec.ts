import { expect, test } from '@playwright/test';

const node = (id: string) => '[data-node-id="' + id + '"]';

test('opens the distinct V3 and R1 releases with grouped MLA, routed and shared branches', async ({ page }) => {
  await page.goto('/');
  const catalog = page.getByLabel('当前模型', { exact: true });
  await expect(catalog.locator('optgroup[label="DeepSeek"] option[value="builtin:model:deepseek-v3"]')).toHaveText(/DeepSeek-V3/);
  await expect(catalog.locator('optgroup[label="DeepSeek"] option[value="builtin:model:deepseek-r1"]')).toHaveText(/DeepSeek-R1/);
  await catalog.selectOption('builtin:model:deepseek-v3');
  await expect(page.locator(node('dense'))).toContainText('3 ×');
  const repeat = page.locator(node('moe'));
  await expect(repeat).toContainText('58 ×');
  await repeat.press('Enter');
  await expect(page.getByLabel('查看重复模块实例', { exact: true })).toHaveValue('moe[0]');
  const route = 'moe[0]/$view:routed', shared = 'moe[0]/$view:shared';
  for (const [from, to] of [
    ['moe[0]/post-norm', route], ['moe[0]/post-norm', shared], [route, 'moe[0]/shared-add'], [shared, 'moe[0]/shared-add'],
  ]) {
    const edge = page.getByRole('img', { name: new RegExp((from + ' → ' + to).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') });
    await expect(edge).toHaveCount(1);
  }
  await expect(page.locator(node('moe[0]/q-proj'))).toBeVisible();
  await expect(page.locator(node('moe[0]/kv-a'))).toBeVisible();
  await page.locator(node(route)).press('Enter');
  await expect(page.locator(node('moe[0]/group-select'))).toBeVisible();
  await expect(page.locator(node('moe[0]/route-weights'))).toBeVisible();
  await expect(page.locator(node('moe[0]/shared-down'))).toHaveCount(0);
  await catalog.selectOption('builtin:model:deepseek-r1');
  await expect(page.locator('.canvas-breadcrumb')).toContainText('DeepSeek-R1');
  await expect(page.locator('.studio-save')).toContainText('已保存');
  await expect(page.locator(node('moe'))).toContainText('58 ×');
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('70,272 B / token');
  await expect(capacity).toContainText('0 token / 请求');
});
