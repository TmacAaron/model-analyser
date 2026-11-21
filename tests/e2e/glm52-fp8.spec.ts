import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { AssetDocument, ProjectDocument } from '@model-analyser/contracts';
import { makeGlm52ParallelAssets } from '../../scripts/glm52-parallel.js';
import { ref } from '../../scripts/model-authoring.js';
import { makeModelProject, referenceHardware } from '../../scripts/model-project.js';

test('keeps the GLM layout when upgrading and opens a KV budget with published FP8 weights', async ({ page }) => {
  test.setTimeout(420_000);
  const reference = referenceHardware();
  if (reference.definition.kind !== 'hardware') throw Error('Missing test device');
  const hardware = AssetDocument.parse({ ...reference, assetId: 'example:hardware:glm-5.2-fp8-capacity',
    name: '120 GB theoretical test device',
    definition: { ...reference.definition, hardware: { ...reference.definition.hardware, capacityBytes: 120_000_000_000 } },
  });
  const project = makeModelProject([...makeGlm52ParallelAssets(2), hardware], {
    kind: 'decode', batchSize: 1, contextTokensPerRequest: 3, queryTokensPerRequest: 1, steps: 1,
  }, 'GLM-5.2 FP8 capacity');
  project.projectId = randomUUID();
  project.scenarios[0]!.deviceTopology.devices[0]!.hardware = ref(hardware);
  await page.goto('/');
  await page.getByLabel('导入模型工作区', { exact: true }).setInputFiles({
    name: 'glm52-r2.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  const save = page.locator('.studio-save');
  await expect(save).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await page.getByLabel('Attention TP', { exact: true }).fill('8');
  await page.getByLabel('MoE EP', { exact: true }).fill('4');
  await page.getByLabel('MoE TP', { exact: true }).fill('2');
  const layout = page.getByRole('region', { name: '逻辑分片与通信' });
  await layout.getByRole('button', { name: '校验布局' }).click();
  await expect(layout).toContainText('8 个实际设备 · 153 个通信', { timeout: 100_000 });
  await layout.getByRole('button', { name: '应用并行度' }).click();
  await expect(save).toContainText('已保存 · 修订 2');

  await page.getByRole('button', { name: '量化', exact: true }).click();
  await page.getByRole('button', { name: '更新模型到 r3', exact: true }).click();
  await expect(save).toContainText('已保存 · 修订 3', { timeout: 100_000 });
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('显存不足', { timeout: 100_000 });
  await page.getByRole('button', { name: '＋ 复制配置', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { name: '量化', exact: true }).click();
  const fp8 = page.getByRole('button', { name: '官方 FP8 权重', exact: true });
  await fp8.click();
  await expect(fp8).toHaveAttribute('aria-pressed', 'true');
  await expect(save).toContainText('已保存');
  await page.getByRole('button', { name: '容量', exact: true }).click();
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/, { timeout: 100_000 });
  await expect(capacity).toContainText('每卡复制 95,232 B / token');
  const saved = ProjectDocument.parse((await (await page.request.get('/api/v1/project?id=' + project.projectId)).json()).data);
  expect(saved.scenarios.map(scenario => scenario.model.revision)).toEqual([3, 3]);
  expect(saved.scenarios.map(scenario => scenario.quantizationOverrides.map(rule => rule.preset?.assetId)))
    .toEqual([[], ['builtin:quantization:glm-5.2-fp8-weights']]);
  for (const scenario of saved.scenarios) {
    expect(scenario.parallelPlan.generatedFrom).toMatchObject({ modelRevision: 3, expertMesh: { ep: 4, tp: 2 } });
    expect(scenario.deviceTopology.devices).toHaveLength(8);
  }
  await page.reload();
  await page.getByRole('tab').nth(1).click();
  await page.getByRole('button', { name: '量化', exact: true }).click();
  await expect(fp8).toHaveAttribute('aria-pressed', 'true');
});
