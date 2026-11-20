import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { ProjectDocument } from '@model-analyser/contracts';
import { makeModelProject } from '../../scripts/model-project.js';
import { makeQwenHybridAssets } from '../../scripts/qwen-hybrid-model.js';
import { makeQwenHybridParallelAssets } from '../../scripts/qwen-hybrid-parallel.js';

async function applyParallel(page: Page, area: 'Attention TP' | 'MoE TP' | 'MoE EP', degree: number, communications: number) {
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await page.getByLabel(area, { exact: true }).fill(String(degree));
  const preview = page.getByRole('region', { name: '逻辑分片与通信' });
  await expect(preview).toContainText(`${degree} 个逻辑槽位`);
  await preview.getByRole('button', { name: '校验布局' }).click();
  await expect(preview).toContainText(`${degree} 个实际设备 · ${communications} 个通信`, { timeout: 120_000 });
  await preview.getByRole('button', { name: '应用并行度' }).click();
  await expect(page.locator('.canvas-status')).toContainText(`${degree} 物理设备`, { timeout: 45_000 });
  await expect(page.locator('.studio-save')).toContainText('已保存');
}

async function verifyAnalysis(page: Page) {
  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  const results = page.locator('.analysis-cards');
  await expect(results).toContainText('最大每卡生命周期峰值', { timeout: 120_000 });
  await expect(results.getByRole('button', { name: '查看理论耗时 · 串行来源' })).not.toContainText('不可用');
  await expect(results.getByRole('button', { name: '查看估计 HBM 流量来源' })).toContainText('· 算子');
}

test('Qwen3.8 attention TP shards GQA KV separately from DeltaNet state', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/');
  await page.getByLabel('当前模型', { exact: true }).selectOption('builtin:model:qwen3.8-27b');
  await expect(page.locator('.canvas-breadcrumb')).toContainText('Qwen3.8-27B');
  await applyParallel(page, 'Attention TP', 4, 64);
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('65,536 B / token', { timeout: 120_000 });
  await expect(capacity).toContainText('每卡分片 16,384 B / token');
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/);
  await capacity.getByText('逐卡显存与缓存分配', { exact: true }).click();
  await expect(capacity.getByRole('row', { name: /^gpu0/ })).toContainText('36.9375 MiB');
  await verifyAnalysis(page);
  await page.reload();
  await expect(page.locator('.canvas-breadcrumb')).toContainText('Qwen3.8-27B');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await expect(page.getByLabel('Attention TP', { exact: true })).toHaveValue('4');
});

test('Qwen3.5-397B expert TP fits the full BF16 text decoder and analyzes the replicated cache', async ({ page }) => {
  test.setTimeout(360_000);
  await page.goto('/');
  await page.getByLabel('当前模型', { exact: true }).selectOption('builtin:model:qwen3.5-397b-a17b');
  await expect(page.locator('.canvas-breadcrumb')).toContainText('Qwen3.5-397B-A17B');
  await page.getByRole('button', { name: '设备', exact: true }).click();
  await page.getByLabel('设备型号', { exact: true }).selectOption('builtin:hardware:amd-mi300x-192gb@1');
  await expect(page.locator('.device-settings')).toContainText('178.8139 GiB');
  await applyParallel(page, 'MoE TP', 8, 60);
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('245,760 B / token', { timeout: 120_000 });
  await expect(capacity).toContainText('每卡复制 30,720 B / token');
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/);
  await verifyAnalysis(page);
});

test('Qwen3.5-397B EP8 shards experts separately from the global TopK selection', async ({ page }) => {
  test.setTimeout(360_000);
  const project = makeModelProject(makeQwenHybridParallelAssets('qwen35'), {
    kind: 'prefill', batchSize: 1, queryTokensPerRequest: 1, pastTokensPerRequest: 0,
  }, 'Qwen3.5-397B EP');
  project.projectId = randomUUID();
  await page.goto('/');
  await page.getByLabel('导入模型工作区').setInputFiles({
    name: 'qwen35-ep.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await page.getByRole('button', { name: '更新模型到 r4', exact: true }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');
  await page.getByRole('button', { name: '设备', exact: true }).click();
  await page.getByLabel('设备型号', { exact: true }).selectOption('builtin:hardware:amd-mi300x-192gb@1');
  await expect(page.locator('.device-settings')).toContainText('178.8139 GiB');
  await applyParallel(page, 'MoE EP', 8, 60);
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('每卡复制 30,720 B / token', { timeout: 120_000 });
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/);
  await verifyAnalysis(page);
  await page.reload();
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await expect(page.getByLabel('MoE EP', { exact: true })).toHaveValue('8');
  await expect(page.getByLabel('MoE TP', { exact: true })).toHaveValue('1');
  await expect(page.getByRole('region', { name: '逻辑分片与通信' })).toContainText('按均衡路由估算负载');
});

test('updates a saved Qwen3.8 r1 workspace to r2 while keeping its workload and device', async ({ page }) => {
  const project = makeModelProject(makeQwenHybridAssets('qwen38'), {
    kind: 'prefill', batchSize: 3, queryTokensPerRequest: 2, pastTokensPerRequest: 31,
  }, 'Qwen3.8 previous revision');
  project.projectId = randomUUID();
  await page.goto('/');
  await page.getByLabel('导入模型工作区').setInputFiles({
    name: 'qwen38-r1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await page.getByRole('button', { name: '更新模型到 r2' }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');
  const response = await page.request.get('/api/v1/project?id=' + project.projectId);
  expect(response.ok()).toBe(true);
  const updated = ProjectDocument.parse((await response.json()).data);
  expect(updated.scenarios[0]).toEqual({ ...project.scenarios[0]!, model: { ...project.scenarios[0]!.model, revision: 2 } });
  expect(updated.assetSnapshots.filter(asset => asset.assetId === project.scenarios[0]!.model.assetId).map(asset => asset.revision)).toEqual([1, 2]);
});
