import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { AssetDocument, ProjectDocument } from '@model-analyser/contracts';
import { makeDeepSeekV3ParallelAssets } from '../../scripts/deepseek-v3-parallel.js';
import { makeModelProject, referenceHardware } from '../../scripts/model-project.js';
import { ref } from '../../scripts/model-authoring.js';

test('uses DeepSeek published FP8 weights to open a KV budget in a separate canvas configuration', async ({ page }) => {
  test.setTimeout(420_000);
  const project = makeModelProject(makeDeepSeekV3ParallelAssets('v3', 4), {
    kind: 'prefill', batchSize: 1, pastTokensPerRequest: 0, queryTokensPerRequest: 1,
  }, 'DeepSeek-V3 FP8 capacity');
  const reference = referenceHardware();
  if (reference.definition.kind !== 'hardware') throw Error('Missing test device');
  const hardware = AssetDocument.parse({ ...reference, assetId: 'example:hardware:deepseek-fp8-capacity',
    name: '100 GB theoretical test device', definition: { ...reference.definition,
      hardware: { ...reference.definition.hardware, capacityBytes: 100_000_000_000 },
    },
  });
  project.projectId = randomUUID();
  project.assetSnapshots.push(hardware);
  project.scenarios[0]!.deviceTopology.devices[0]!.hardware = ref(hardware);
  await page.goto('/');
  await page.getByLabel('导入模型工作区', { exact: true }).setInputFiles({
    name: 'deepseek-v3-r4.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  const save = page.locator('.studio-save');
  await expect(save).toContainText('已保存 · 修订 1');
  await page.getByRole('button', { name: '量化', exact: true }).click();
  await page.getByRole('button', { name: '更新模型到 r5', exact: true }).click();
  await expect(save).toContainText('已保存 · 修订 2');
  await page.getByRole('button', { name: '并行方式', exact: true }).click();
  await page.getByLabel('Attention TP', { exact: true }).fill('8');
  await page.getByLabel('MoE EP', { exact: true }).fill('4');
  await page.getByLabel('MoE TP', { exact: true }).fill('2');
  const layout = page.getByRole('region', { name: '逻辑分片与通信' });
  await layout.getByRole('button', { name: '校验布局' }).click();
  await expect(layout).toContainText('8 个实际设备 · 119 个通信', { timeout: 120_000 });
  await layout.getByRole('button', { name: '应用并行度' }).click();
  await expect(save).toContainText('已保存 · 修订 3');
  const capacity = page.getByRole('region', { name: 'KV 缓存容量' });
  await page.getByRole('button', { name: '容量', exact: true }).click();
  await expect(capacity).toContainText('显存不足', { timeout: 120_000 });
  await page.getByRole('button', { name: '＋ 复制配置', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { name: '量化', exact: true }).click();
  const fp8 = page.getByRole('button', { name: '官方 FP8 权重', exact: true });
  await fp8.click();
  await expect(fp8).toHaveAttribute('aria-pressed', 'true');
  await expect(save).toContainText('已保存');
  await page.getByRole('button', { name: '容量', exact: true }).click();
  await expect(capacity).toContainText(/[1-9][\d,]+ token \/ 请求/, { timeout: 120_000 });
  await expect(capacity).toContainText('每卡复制 70,272 B / token');
  await page.getByRole('button', { name: '分析此配置 ↗', exact: true }).click();
  const cards = page.locator('.analysis-cards');
  await expect(cards).toContainText('最大每卡生命周期峰值', { timeout: 120_000 });
  await expect(cards.getByRole('button', { name: '查看理论耗时 · 串行来源' })).not.toContainText('不可用');
  const saved = ProjectDocument.parse((await (await page.request.get('/api/v1/project?id=' + project.projectId)).json()).data);
  expect(saved.scenarios.map(scenario => scenario.quantizationOverrides.map(rule => rule.preset?.assetId)))
    .toEqual([[], ['builtin:quantization:deepseek-v3-fp8-weights']]);
  expect(saved.scenarios[1]?.parallelPlan.generatedFrom?.expertMesh).toMatchObject({ ep: 4, tp: 2 });
  await page.reload();
  await page.getByRole('tab').nth(1).click();
  await page.getByRole('button', { name: '量化', exact: true }).click();
  await expect(fp8).toHaveAttribute('aria-pressed', 'true');
});
