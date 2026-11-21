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
  await page.locator(node('moe[0]/q-a-norm')).press('Space');
  await expect(page.getByRole('region', { name: 'RMSNorm 计算步骤' })).toContainText('Q 潜向量维度');
  await page.locator(node('moe[0]/$view:attention')).press('Enter');
  await page.locator(node('moe[0]/qk')).press('Space');
  const mla = page.getByRole('region', { name: '吸收投影的 MLA 计算步骤' });
  await expect(mla).toContainText('⟨q̃ₕ, cₜ⟩ + ⟨qʳₕ, kʳₜ⟩');
  await expect(page.getByRole('link', { name: '查看固定版本源码 ↗' })).toHaveAttribute('href', /DeepSeek-V3\/blob\/[a-f0-9]{40}\/inference\/model\.py$/);
  await page.locator('.canvas-breadcrumb').getByRole('button', { name: 'moe[0]', exact: true }).click();
  await page.locator(node(route)).press('Enter');
  await expect(page.locator(node('moe[0]/group-select'))).toBeVisible();
  await expect(page.locator(node('moe[0]/route-weights'))).toBeVisible();
  await expect(page.locator(node('moe[0]/shared-down'))).toHaveCount(0);
  await page.locator(node('moe[0]/route-weights')).press('Space');
  const routing = page.getByRole('region', { name: '分组 MoE 路由 计算步骤' });
  await expect(routing).toContainText('TopK(r[g], 2)');
  await expect(routing).toContainText('2.5 · sᵢ / Σⱼ∈ids sⱼ');
  await page.locator(node('moe[0]/expert-silu')).press('Space');
  await expect(page.getByRole('region', { name: 'SwiGLU 计算步骤' })).toContainText('g ⊙ sigmoid(g)');
  await catalog.selectOption('builtin:model:deepseek-r1');
  await expect(page.locator('.canvas-breadcrumb')).toContainText('DeepSeek-R1');
  await expect(page.locator('.studio-save')).toContainText('已保存');
  await expect(page.locator(node('moe'))).toContainText('58 ×');
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('70,272 B / token');
  await expect(capacity).toContainText('0 token / 请求');
});
