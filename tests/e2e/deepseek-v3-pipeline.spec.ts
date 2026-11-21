import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { AssetDocument, ProjectDocument } from '@model-analyser/contracts';
import { makeDeepSeekV3ParallelAssets } from '../../scripts/deepseek-v3-parallel.js';
import { makeDeepSeekV3FP8WeightPreset } from '../../scripts/deepseek-v3-fp8-weights.js';
import { ref } from '../../scripts/model-authoring.js';
import { makeModelProject, referenceHardware } from '../../scripts/model-project.js';

test('upgrades published FP8 and applies a two-stage DeepSeek pipeline from the canvas', async ({ page }) => {
  test.setTimeout(420_000);
  const assets = makeDeepSeekV3ParallelAssets('v3', 5);
  const format = makeDeepSeekV3FP8WeightPreset(assets, 'v3');
  const reference = referenceHardware();
  if (format.definition.kind !== 'quantization' || reference.definition.kind !== 'hardware') throw Error('Missing format or device');
  const hardware = AssetDocument.parse({ ...reference, assetId: 'example:hardware:deepseek-v3-pipeline',
    name: '128 GB theoretical test device',
    definition: { ...reference.definition, hardware: { ...reference.definition.hardware, capacityBytes: 128_000_000_000 } },
  });
  const project = makeModelProject([...assets, format, hardware], {
    kind: 'decode', batchSize: 1, contextTokensPerRequest: 2, queryTokensPerRequest: 1, steps: 1,
  }, 'DeepSeek-V3 pipeline');
  project.projectId = randomUUID();
  const scenario = project.scenarios[0]!;
  scenario.deviceTopology.devices[0]!.hardware = ref(hardware);
  scenario.quantizationOverrides = [{ ...format.definition.quantization, preset: ref(format) }];
  await page.goto('/');
  await page.getByLabel('导入模型工作区', { exact: true }).setInputFiles({
    name: 'deepseek-v3-r5.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  const save = page.locator('.studio-save');
  await expect(save).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '量化', exact: true }).click();
  const fp8 = page.getByRole('button', { name: '官方 FP8 权重', exact: true });
  await expect(fp8).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '更新模型到 r8', exact: true }).click();
  await expect(save).toContainText('已保存 · 修订 2');
  await expect(fp8).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  const degrees = [['序列与流水线 PP', '2'], ['Attention TP', '4'], ['MoE EP', '2'], ['MoE TP', '2']] as const;
  for (const [label, degree] of degrees) {
    const field = page.getByLabel(label, { exact: true });
    await expect(field).toBeVisible();
    await field.fill(degree);
  }
  const layout = page.getByRole('region', { name: '逻辑分片与通信' });
  await expect(layout).toContainText('8 个逻辑槽位');
  await layout.getByText('通信参数', { exact: false }).click();
  await layout.getByLabel('阶段间传输带宽 (B/s)', { exact: true }).fill('25000000000');
  await layout.getByLabel('阶段内归约带宽 (B/s)', { exact: true }).fill('100000000000');
  await layout.getByRole('button', { name: '校验布局' }).click();
  await expect(layout).toContainText('8 个实际设备 · 120 个通信', { timeout: 120_000 });
  await layout.getByRole('button', { name: '应用并行度' }).click();
  await expect(save).toContainText('已保存 · 修订 3');
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('281,088 B / token', { timeout: 120_000 });
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/);

  const saved = ProjectDocument.parse((await (await page.request.get('/api/v1/project?id=' + project.projectId)).json()).data).scenarios[0]!;
  expect(saved.model.revision).toBe(8);
  expect(saved.quantizationOverrides[0]?.preset?.revision).toBe(4);
  expect(saved.parallelPlan.generatedFrom).toMatchObject({ pipelineStage: { degree: 4 }, expertMesh: { ep: 2, tp: 2 } });
  expect(saved.parallelPlan.communications.find(row => row.operation === 'send_recv')?.timing).toMatchObject({ bytePerSecond: 25e9 });
  await page.reload();
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  for (const [label, degree] of degrees) await expect(page.getByLabel(label, { exact: true })).toHaveValue(degree);
});
