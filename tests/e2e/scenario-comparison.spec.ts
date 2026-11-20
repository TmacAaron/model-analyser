import { test,expect,type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DeviceId,ProjectDocument,ScenarioComparisonResult,RooflineStudySample } from '@model-analyser/contracts';
import { makeComparisonProject } from '../../scripts/comparison-project.js';
test.setTimeout(90000);
async function open(page:Page){const p=makeComparisonProject(ProjectDocument.parse(JSON.parse(readFileSync('examples/contracts/project.json','utf8')) as unknown));p.projectId=randomUUID();p.name='Comparison '+p.projectId.slice(0,8);await page.goto('/?legacy=1&workspace=projects');await page.getByLabel('导入项目文件',{exact:true}).setInputFiles({name:'comparison.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(p))});await expect(page.locator('.project-editor .save-state')).toContainText('已保存 · 修订 1');return p;}
async function exported(page:Page,name:string){const wait=page.waitForEvent('download');await page.getByRole('button',{name:'导出方案比较 JSON',exact:true}).click();const file=await wait,path='test-results/'+name+'.json';await file.saveAs(path);return ScenarioComparisonResult.parse(JSON.parse(readFileSync(path,'utf8')) as unknown);}
async function scan(page:Page,max='8'){await page.getByLabel('扫描参数交叉点',{exact:true}).check();await page.getByLabel('比较扫描变量',{exact:true}).selectOption('parameter:X');await page.getByLabel('比较扫描最大值',{exact:true}).fill(max);}
test('compares three pinned scenarios, exports integer reversals/equality/capacity and preserves the source project across reopening',async({page})=>{
  const p=await open(page),panel=page.locator('.comparison-panel');await page.getByLabel('比较方案 Plateau C',{exact:true}).check();await scan(page);await panel.getByRole('button',{name:'计算方案比较',exact:true}).click();await expect(panel.locator('.comparison-results')).toContainText('方案比较完成');await expect(panel.getByRole('img',{name:'方案整数扫描耗时曲线',exact:true})).toBeVisible();await expect(panel.locator('.crossing-pair')).toHaveCount(3);await expect(panel.locator('.crossing-pair').nth(0)).toContainText('排序改变区间 [4, 5]');await expect(panel.locator('.crossing-pair').nth(1)).toContainText('完全相等 [3, 8]');
  const r=await exported(page,'comparison-e2e');expect(r.entries.map(e=>e.scan?.status==='available'&&e.scan.result.capacityStatus.kind==='solved'?e.scan.result.capacityStatus.maximum:null)).toEqual([4,8,2]);expect(r.entries.map(e=>e.scenario)).toEqual(p.scenarios);expect(r.entries[1]?.changes.length).toBeGreaterThan(0);
  const wait=page.waitForEvent('download');await panel.getByRole('button',{name:'导出方案结果 CSV',exact:true}).click();const d=await wait,path='test-results/comparison.csv';await d.saveAs(path);const csv=readFileSync(path,'utf8');expect(csv).toContain('deltaFromBaseline');expect(csv).toContain('"second"');expect(csv).toContain('"4.5","2.5"');await panel.screenshot({path:'test-results/scenario-comparison.png'});const inputSummary=panel.locator('summary').filter({hasText:/^Constant B · \d+处计算输入差异/});await inputSummary.click();const detail=inputSummary.locator('..');await expect(detail).toContainText('JSON Pointer');await detail.locator('.cost-source-inspector > summary').click();await expect(detail.locator('.cost-source-inspector')).toContainText('4.5');await inputSummary.click();
  const formal=(await (await page.request.get('/api/v1/project?id='+encodeURIComponent(p.projectId))).json() as {data:unknown}).data;expect(ProjectDocument.parse(formal).scenarios).toEqual(p.scenarios);await page.reload();await page.locator('.project-list').getByRole('button').filter({hasText:p.name}).click();await expect(panel.locator('.comparison-results')).toHaveCount(0);await panel.getByRole('button',{name:'计算方案比较',exact:true}).click();await expect(panel.locator('.comparison-results')).toContainText('方案比较完成');expect((await exported(page,'comparison-reopened')).entries.map(e=>e.scenario)).toEqual(p.scenarios.slice(0,2));
});
test('retains partial evidence on cancellation and invalidates comparisons when source or scan settings change',async({page})=>{
  await open(page);const panel=page.locator('.comparison-panel');await scan(page,'250');await panel.getByRole('button',{name:'计算方案比较',exact:true}).click();await expect(panel.getByRole('status')).toContainText('已完成');await panel.getByRole('button',{name:'取消方案比较',exact:true}).click();await expect(panel.locator('.comparison-results')).toContainText('比较已取消');const r=await exported(page,'comparison-cancelled');expect(r.completion).toBe('cancelled');for(const e of r.entries)if(e.scan?.status==='available'&&e.scan.result.completion==='cancelled')expect(e.scan.result.capacityStatus.kind).toBe('unavailable');expect(r.entries.length<2||r.entries.some(e=>e.scan?.status==='available'&&e.scan.result.completion==='cancelled')).toBe(true);
  await page.getByLabel('比较扫描最大值',{exact:true}).fill('8');await expect(panel.locator('.comparison-results')).toHaveCount(0);await expect(panel).toContainText('旧比较结果已失效');await panel.getByRole('button',{name:'计算方案比较',exact:true}).click();await expect(panel.locator('.comparison-results')).toContainText('方案比较完成');await page.getByLabel('Batch',{exact:true}).fill('2');await expect(panel.locator('.comparison-results')).toHaveCount(0);await panel.getByRole('button',{name:'计算方案比较',exact:true}).click();await expect(panel.locator('.comparison-results')).toContainText('方案比较完成');expect((await exported(page,'comparison-edited')).entries[0]?.scenario.workload.batchSize).toBe(2);
});
test('stops a running worker after later project edits and rejects unordered scan ranges',async({page})=>{
  await open(page);const panel=page.locator('.comparison-panel');await scan(page,'250');await panel.getByRole('button',{name:'计算方案比较',exact:true}).click();await expect(panel.getByRole('status')).toContainText('已完成');await page.getByLabel('Batch',{exact:true}).fill('3');await expect(panel.getByRole('button',{name:'计算方案比较',exact:true})).toBeEnabled();await expect(panel.locator('.comparison-results')).toHaveCount(0);
  await page.getByLabel('比较扫描最大值',{exact:true}).fill('8');await page.getByLabel('比较扫描变量',{exact:true}).selectOption('workload:batchSize');await panel.getByRole('button',{name:'计算方案比较',exact:true}).click();await expect(panel.locator('.comparison-results')).toContainText('方案比较完成');expect((await exported(page,'comparison-after-edit')).entries[0]?.scenario.workload.batchSize).toBe(3);await page.getByLabel('比较扫描最小值',{exact:true}).fill('9');await panel.getByRole('button',{name:'计算方案比较',exact:true}).click();await expect(panel).toContainText('扫描范围必须有序');await expect(panel.locator('.comparison-results')).toHaveCount(0);
});

test('compares the canvas operator at an actual Decode step and separates unmatched scopes',async({page})=>{
  const project=ProjectDocument.parse(JSON.parse(readFileSync('examples/computed/decode-growing-project.json','utf8')));
  project.projectId=randomUUID();
  const baseline=project.scenarios[0]!;
  if(baseline.workload.kind!=='decode')throw Error('Expected decode fixture');
  const alternative={...structuredClone(baseline),scenarioId:'alternative',name:'Shorter decode',
    workload:{...baseline.workload,contextTokensPerRequest:4,steps:2}};
  const hardwareRef=alternative.deviceTopology.devices[0]!.hardware;
  const hardware=structuredClone(project.assetSnapshots.find(a=>a.assetId===hardwareRef.assetId)!);
  if(hardware.definition.kind!=='hardware')throw Error('Expected fixed hardware');
  hardware.revision=2;
  hardware.definition.hardware.memoryCapabilities[0]!.bytesPerSecond/=2;
  hardwareRef.revision=hardware.revision;
  project.assetSnapshots.push(hardware);
  const otherDevice={...structuredClone(baseline),scenarioId:'other-device',name:'Other device'};
  otherDevice.deviceTopology.devices[0]!.deviceId=DeviceId.parse('gpu1');
  project.scenarios.push(alternative,otherDevice);

  await page.goto('/');
  await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({
    name:'compare-decode.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.locator('[data-node-id="update"]').press('Space');
  await page.getByRole('button',{name:'配置对比',exact:true}).click();
  const panel=page.locator('.comparison-panel');
  await panel.getByLabel('比较方案 Other device',{exact:true}).check();
  await panel.getByRole('button',{name:'计算方案比较',exact:true}).click();
  await expect(panel.locator('.comparison-results')).toContainText('方案比较完成');
  await panel.getByText('Roofline 对比',{exact:true}).click();
  await expect(panel.getByRole('combobox',{name:'Roofline 对比范围',exact:true})).toHaveValue('canvas');
  const step=panel.getByLabel('Roofline 对比 Decode 步骤',{exact:true});
  await step.fill('2');
  const roofline=panel.getByRole('table',{name:'Roofline 配置对比',exact:true});
  await expect(roofline).toContainText('步骤 2 · context 3');
  await expect(roofline).toContainText('步骤 2 · context 5');
  await expect(roofline.locator('tbody tr').filter({hasText:'gpu0'}).getByRole('cell').nth(1)).toContainText('Δ');
  await expect(roofline.locator('tbody tr').filter({hasText:'gpu1'}).getByRole('cell').nth(2)).not.toContainText('Δ');
  const metric=panel.getByRole('combobox',{name:'Roofline 对比指标',exact:true});
  await metric.selectOption('hardware-memory');

  const waiting=page.waitForEvent('download');
  await panel.getByRole('button',{name:'导出 Roofline 对比 JSON',exact:true}).click();
  const file=await waiting,path='test-results/comparison-roofline.json';
  await file.saveAs(path);
  const report=JSON.parse(readFileSync(path,'utf8'));
  expect(report.target).toEqual({kind:'node',nodeId:'update'});
  expect(report.decodeStep).toBe(1);
  const first=RooflineStudySample.parse(report.entries[0].sample);
  const second=RooflineStudySample.parse(report.entries[1].sample);
  expect(first.evaluatedContext).toBe(3);
  expect(second.evaluatedContext).toBe(5);
  expect(second.stepInputHash).not.toBe(second.inputHash);
  expect(second.observations[0]?.point.scope.target).toEqual(report.target);
  const row=report.rows.find((r:{series:{scope:{deviceIds:string[]}}})=>r.series.scope.deviceIds[0]==='gpu0');
  expect(row.values[1]).toEqual({value:row.values[0].value/2,delta:-row.values[0].value/2});
  expect(row.values[2]).toEqual({value:null,delta:null});

  await metric.selectOption('intensity');
  await roofline.getByRole('button',{name:'查看Shorter decode Roofline 运算强度依据',exact:true}).click();
  const source=panel.getByRole('region',{name:'指标推导依据',exact:true});
  await expect(source).toContainText(second.stepInputHash!);
  await expect(source).toContainText('该点执行operations / 该点trafficBytes');
  await step.fill('3');
  await expect(source).toHaveCount(0);
  await expect(panel.getByText('Shorter decode · 所选 decode 步骤不存在',{exact:true})).toBeVisible();
  await expect(roofline.getByRole('button',{name:'查看Shorter decode Roofline 运算强度依据',exact:true})).toHaveCount(0);
  const saved=await (await page.request.get('/api/v1/project?id='+encodeURIComponent(project.projectId))).json();
  expect(ProjectDocument.parse(saved.data).scenarios).toEqual(project.scenarios);
});
