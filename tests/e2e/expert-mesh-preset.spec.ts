import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { AssetId } from '@model-analyser/contracts';
import { makeKimiK3ParallelAssets } from '../../scripts/kimi-k3-parallel.js';
import { makeKimiK3MXFP4WeightPreset } from '../../scripts/kimi-k3-mxfp4-weights.js';
import { ref } from '../../scripts/model-authoring.js';
import { makeModelProject } from '../../scripts/model-project.js';

test('shares four Kimi-K3 devices between Attention and the MoE expert mesh after reopening', async ({ page }) => {
  test.setTimeout(400_000);
  const assets = makeKimiK3ParallelAssets(3), [root, ...modules] = assets;
  if (!root) throw Error('Missing Kimi-K3');
  const snapshotId = randomUUID();
  const model = { ...root, assetId: AssetId.parse('example:model:kimi-k3-expert-mesh-' + snapshotId) };
  const published = makeKimiK3MXFP4WeightPreset(assets);
  if (published.definition.kind !== 'quantization' || !published.definition.modelWeights) throw Error('Missing MXFP4 preset');
  const preset = { ...published, assetId: AssetId.parse('example:quantization:kimi-k3-mxfp4-' + snapshotId),
    definition: { ...published.definition, modelWeights: { ...published.definition.modelWeights, model: ref(model) } } };
  const project = makeModelProject([model, ...modules, preset], {
    kind: 'prefill', batchSize: 1, queryTokensPerRequest: 1, pastTokensPerRequest: 3,
  }, model.name);
  const hardware = project.assetSnapshots.find(asset => asset.definition.kind === 'hardware');
  if (hardware?.definition.kind !== 'hardware') throw Error('Missing capacity test device');
  hardware.definition.hardware.capacityBytes = 512e9;
  await page.goto('/');
  await page.getByLabel('导入模型工作区').setInputFiles({ name: 'kimi-k3-expert-mesh.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '量化', exact: true }).click();
  await page.getByRole('group', { name: '发布权重格式' }).getByRole('button', { name: '官方 MXFP4 权重' }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');

  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await page.getByLabel('Attention TP', { exact: true }).fill('4');
  await page.getByLabel('MoE EP', { exact: true }).fill('2');
  await page.getByLabel('MoE TP', { exact: true }).fill('2');
  const layout = page.getByRole('region', { name: '逻辑分片与通信' });
  await expect(layout).toContainText('4 个逻辑槽位');
  await layout.getByRole('button', { name: '校验布局' }).click();
  await expect(layout).toContainText('4 个实际设备 · 185 个通信', { timeout: 170_000 });
  await layout.getByRole('button', { name: '应用并行度' }).click();
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 3');
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/, { timeout: 135_000 });
  await expect(capacity).toContainText('每卡复制 27,648 B / token');

  await page.reload();
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await expect(page.getByLabel('Attention TP', { exact: true })).toHaveValue('4');
  await expect(page.getByLabel('MoE EP', { exact: true })).toHaveValue('2');
  await expect(page.getByLabel('MoE TP', { exact: true })).toHaveValue('2');
  await expect(page.locator('.canvas-status')).toContainText('4 物理设备');
});
