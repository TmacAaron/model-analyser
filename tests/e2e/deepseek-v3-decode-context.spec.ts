import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { AssetDocument, ProjectDocument } from '@model-analyser/contracts';
import { makeDeepSeekV3FP8WeightPreset } from '../../scripts/deepseek-v3-fp8-weights.js';
import { makeDeepSeekV3ParallelAssets } from '../../scripts/deepseek-v3-parallel.js';
import { ref } from '../../scripts/model-authoring.js';
import { makeModelProject, referenceHardware } from '../../scripts/model-project.js';

test('keeps published FP8 and shows the full fixed MLA cache split over two Decode ranks', async ({ page }) => {
  test.setTimeout(330_000);
  const assets = makeDeepSeekV3ParallelAssets('v3', 7), preset = makeDeepSeekV3FP8WeightPreset(assets, 'v3');
  const reference = referenceHardware();
  if (preset.definition.kind !== 'quantization' || reference.definition.kind !== 'hardware') throw Error('Missing published weights or device');
  const hardware = AssetDocument.parse({ ...reference, assetId: 'example:hardware:deepseek-v3-dcp',
    name: '800 GB theoretical test device',
    definition: { ...reference.definition, hardware: { ...reference.definition.hardware, capacityBytes: 800_000_000_000 } },
  });
  const project = makeModelProject([...assets, preset, hardware], {
    kind: 'decode', batchSize: 1, queryTokensPerRequest: 1, contextTokensPerRequest: 3, steps: 2,
  }, 'DeepSeek-V3 Decode context parallelism');
  project.projectId = randomUUID();
  const scenario = project.scenarios[0]!;
  scenario.deviceTopology.devices[0]!.hardware = ref(hardware);
  scenario.quantizationOverrides = [{ ...preset.definition.quantization, preset: ref(preset) }];
  await page.goto('/');
  await page.getByLabel('导入模型工作区', { exact: true }).setInputFiles({
    name: 'deepseek-v3-r7.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  const save = page.locator('.studio-save');
  await expect(save).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await page.getByRole('button', { name: '更新模型到 r8', exact: true }).click();
  await expect(save).toContainText('已保存 · 修订 2');
  const dcp = page.getByLabel('序列与流水线 DCP', { exact: true });
  await expect(dcp).toBeVisible();
  await dcp.fill('2');
  const layout = page.getByRole('region', { name: '逻辑分片与通信' });
  await expect(layout).toContainText('2 个逻辑槽位');
  await layout.getByRole('button', { name: '校验布局' }).click();
  await expect(layout).toContainText('2 个实际设备 · 183 个通信', { timeout: 120_000 });
  await layout.getByRole('button', { name: '应用并行度' }).click();
  await expect(save).toContainText('已保存 · 修订 3');
  await page.locator('[data-node-id="moe"]').press('Enter');
  await page.locator('[data-node-id="moe[0]/$view:attention"]').press('Enter');
  await expect(page.locator('[data-node-id="moe[0]/local-max"]')).toBeVisible();
  await expect(page.locator('[data-node-id="moe[0]/normalize"]')).toBeVisible();
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('70,272 B / token', { timeout: 120_000 });
  await expect(capacity).toContainText('163,840 token / 请求');
  await expect(capacity).toContainText('固定槽位，已用 5');
  const saved = ProjectDocument.parse((await (await page.request.get('/api/v1/project?id=' + project.projectId)).json()).data).scenarios[0]!;
  expect(saved.model.revision).toBe(8);
  expect(saved.quantizationOverrides[0]?.preset?.revision).toBe(4);
  expect(saved.parallelPlan.decodeContext).toMatchObject({ replacements: expect.arrayContaining([
    expect.objectContaining({ replacement: expect.objectContaining({ assetId: 'builtin:module:deepseek-v3-dcp-dense' }) }),
    expect.objectContaining({ replacement: expect.objectContaining({ assetId: 'builtin:module:deepseek-v3-dcp-moe' }) }),
  ]) });
  await page.reload();
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await expect(dcp).toHaveValue('2');
});
