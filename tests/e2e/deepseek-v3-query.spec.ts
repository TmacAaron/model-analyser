import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { AssetDocument, ProjectDocument } from '@model-analyser/contracts';
import { previewParallelPreset } from '@model-analyser/core';
import { bindDegreePool } from '../../apps/web/src/parallel-degrees.js';
import { makeDeepSeekV3FP8WeightPreset } from '../../scripts/deepseek-v3-fp8-weights.js';
import { makeDeepSeekV3ParallelAssets } from '../../scripts/deepseek-v3-parallel.js';
import { ref } from '../../scripts/model-authoring.js';
import { makeModelProject, referenceHardware } from '../../scripts/model-project.js';

test('upgrades an FP8 pipeline and keeps a separate DP × PCP configuration', async ({ page }) => {
  test.setTimeout(420_000);
  const assets = makeDeepSeekV3ParallelAssets('v3', 6), format = makeDeepSeekV3FP8WeightPreset(assets, 'v3');
  const reference = referenceHardware();
  if (format.definition.kind !== 'quantization' || reference.definition.kind !== 'hardware') throw Error('Missing format or device');
  const hardware = AssetDocument.parse({ ...reference, assetId: 'example:hardware:deepseek-v3-query',
    name: '800 GB theoretical test device',
    definition: { ...reference.definition, hardware: { ...reference.definition.hardware, capacityBytes: 800_000_000_000 } },
  });
  const project = makeModelProject([...assets, format, hardware], {
    kind: 'prefill', batchSize: 2, queryTokensPerRequest: 4, pastTokensPerRequest: 3,
  }, 'DeepSeek-V3 context parallelism');
  const scenario = project.scenarios[0]!;
  project.projectId = randomUUID();
  scenario.deviceTopology.devices[0]!.hardware = ref(hardware);
  scenario.quantizationOverrides = [{ ...format.definition.quantization, preset: ref(format) }];
  const pipeline = await previewParallelPreset({ ...bindDegreePool(scenario, 8), assets: project.assetSnapshots, presetId: 'pp-decoder',
    pipelineStage: { presetId: 'tp-mla-ep-routed', degree: 4 }, expertMesh: { ep: 2, tp: 2 },
    network: { bytesPerSecond: 25e9, latencySeconds: 6e-6 }, pipelineTpNetwork: { bytesPerSecond: 100e9, latencySeconds: 3e-6 } });
  if (pipeline.status !== 'available') throw Error(pipeline.message);
  project.scenarios[0] = pipeline.preview.scenario;
  project.assetSnapshots = pipeline.preview.assets;
  await page.goto('/');
  await page.getByLabel('导入模型工作区', { exact: true }).setInputFiles({
    name: 'deepseek-v3-pp-r6.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  const save = page.locator('.studio-save');
  await expect(save).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await page.getByRole('button', { name: '更新模型到 r7', exact: true }).click();
  await expect(save).toContainText('已保存 · 修订 2', { timeout: 120_000 });
  await expect(page.getByLabel('序列与流水线 PP', { exact: true })).toHaveValue('2');
  await expect(page.getByLabel('MoE EP', { exact: true })).toHaveValue('2');
  await page.getByRole('button', { name: '＋ 复制配置', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  for (const [label, value] of [['序列与流水线 PP', '1'], ['Attention TP', '1'], ['MoE EP', '1'], ['MoE TP', '1'],
    ['Attention DP', '2'], ['序列与流水线 PCP', '2']] as const) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  const preview = page.getByRole('region', { name: '逻辑分片与通信' });
  await expect(preview).toContainText('4 个逻辑槽位');
  await preview.getByRole('button', { name: '校验布局' }).click();
  await expect(preview).toContainText('4 个实际设备 · 122 个通信', { timeout: 120_000 });
  await preview.getByRole('button', { name: '应用并行度' }).click();
  await expect(save).toContainText('已保存 · 修订 4');
  await page.getByRole('button', { name: '容量', exact: true }).click();
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await expect(capacity).toContainText('140,544 B / token', { timeout: 120_000 });
  await expect(capacity).toContainText('163,840 token / 请求');
  const saved = ProjectDocument.parse((await (await page.request.get('/api/v1/project?id=' + project.projectId)).json()).data);
  expect(saved.scenarios.map(row => row.quantizationOverrides[0]?.preset?.revision)).toEqual([3, 3]);
  expect(saved.scenarios.map(row => row.parallelPlan.generatedFrom)).toMatchObject([
    { modelRevision: 7, presetId: 'pp-decoder', pipelineStage: { degree: 4 }, expertMesh: { ep: 2, tp: 2 } },
    { modelRevision: 7, presetId: 'pcp-queries', requestDp: 2 },
  ]);
  await page.reload();
  await page.getByRole('tab').nth(1).click();
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await expect(page.getByLabel('序列与流水线 PCP', { exact: true })).toHaveValue('2');
  await expect(page.getByLabel('Attention DP', { exact: true })).toHaveValue('2');
});
