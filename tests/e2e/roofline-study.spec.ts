import { test,expect,type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ProjectDocument,RooflineStudyResult } from '@model-analyser/contracts';
import { makeRooflineProject } from '../../scripts/roofline-project.js';
import { c01Project } from '../model-fixtures.js';
test.setTimeout(90000);
async function open(page:Page,p=makeRooflineProject(ProjectDocument.parse(JSON.parse(readFileSync('examples/contracts/project.json','utf8')) as unknown),.5)){p.projectId=randomUUID();p.name='Roofline '+p.projectId.slice(0,8);await page.goto('/?legacy=1&workspace=projects');await page.getByLabel('导入项目文件',{exact:true}).setInputFiles({name:'roofline.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(p))});await expect(page.locator('.project-editor .save-state')).toContainText('已保存 · 修订 1');await calculate(page);return p;}
async function calculate(page:Page){await page.locator('.analysis-panel').getByRole('button',{name:'计算理论结果',exact:true}).click();await expect(page.locator('.analysis-cards')).toBeVisible();}
async function study(page:Page){const panel=page.locator('.roofline-study');await panel.getByRole('button',{name:'计算 Roofline 拐点',exact:true}).click();await expect(panel.locator('.roofline-study-results')).toContainText('Roofline研究完成');return panel;}
async function exported(page:Page,name:string){const wait=page.waitForEvent('download');await page.getByRole('button',{name:'导出 Roofline 研究 JSON',exact:true}).click();const d=await wait,path='test-results/'+name+'.json';await d.saveAs(path);return RooflineStudyResult.parse(JSON.parse(readFileSync(path,'utf8')) as unknown);}
test('shows independent hardware/effective roofs, integer ridge events and source-preserving exports without changing the project',async({page})=>{
  const p=await open(page),panel=page.locator('.roofline-study');await panel.getByLabel('扫描 Roofline 参数拐点',{exact:true}).check();await panel.getByLabel('Roofline扫描变量',{exact:true}).selectOption('parameter:M');await study(page);await expect(panel.getByRole('img',{name:'所选范围硬件与有效 Roofline',exact:true})).toBeVisible();await expect(panel.locator('.roofline-transition').nth(0)).toContainText('限制侧改变区间 [3, 4]');await expect(panel.locator('.roofline-transition').nth(1)).toContainText('平衡采样点 [16, 16]');const r=await exported(page,'roofline-e2e');expect(r.base.observations[0]?.effectiveBalance).toMatchObject({ridgeOperationsPerByte:2,side:'compute'});expect(r.base.observations[0]?.hardwareBalance).toMatchObject({ridgeOperationsPerByte:4,side:'memory'});expect(r.samples).toHaveLength(20);expect(r.scenario).toEqual(p.scenarios[0]);await panel.locator('.roofline-samples > summary').click();await expect(panel.locator('.roofline-samples tbody > tr')).toHaveCount(20);await panel.locator('.roofline-samples > summary').click();await panel.screenshot({path:'test-results/roofline-study.png'});
  const stored=ProjectDocument.parse((await (await page.request.get('/api/v1/project?id='+encodeURIComponent(p.projectId))).json() as {data:unknown}).data);expect(stored.scenarios).toEqual(p.scenarios);
});
test('selects module and leaf scopes, invalidates old evidence and reconstructs results after reopening',async({page})=>{
  const p=await open(page),panel=page.locator('.roofline-study');const modules=await panel.getByLabel('Roofline范围',{exact:true}).locator('option').evaluateAll(options=>options.map(o=>({value:(o as HTMLOptionElement).value,text:o.textContent})));const module=modules.find(o=>o.value.startsWith('module:')),node=modules.find(o=>o.value.startsWith('node:'));if(!module||!node)throw Error();await panel.getByLabel('Roofline范围',{exact:true}).selectOption(module.value);await study(page);expect((await exported(page,'roofline-module')).base.observations[0]?.point.scope.target.kind).toBe('module');await panel.getByLabel('Roofline范围',{exact:true}).selectOption(node.value);await expect(panel.locator('.roofline-study-results')).toHaveCount(0);await study(page);expect((await exported(page,'roofline-leaf')).base.observations[0]?.aggregation).toBe('leaf');await page.reload();await page.locator('.project-list').getByRole('button').filter({hasText:p.name}).click();await calculate(page);await expect(panel.locator('.roofline-study-results')).toHaveCount(0);await study(page);expect((await exported(page,'roofline-reopened')).base.inputHash).toBeDefined();
});
test('retains partial cancellation evidence and terminates a running scan when source input changes',async({page})=>{
  await open(page);const panel=page.locator('.roofline-study');await panel.getByLabel('扫描 Roofline 参数拐点',{exact:true}).check();await panel.getByLabel('Roofline扫描变量',{exact:true}).selectOption('parameter:M');await panel.getByLabel('Roofline扫描最大值',{exact:true}).fill('511');await panel.getByRole('button',{name:'计算 Roofline 拐点',exact:true}).click();await expect(panel.getByRole('status')).toContainText('Roofline已完成');await panel.getByRole('button',{name:'取消 Roofline 扫描',exact:true}).click();await expect(panel.locator('.roofline-study-results')).toContainText('研究已取消');const cancelled=await exported(page,'roofline-cancelled');expect(cancelled.completion).toBe('cancelled');expect(cancelled.samples.length).toBeLessThan(511);
  await panel.getByRole('button',{name:'计算 Roofline 拐点',exact:true}).click();await expect(panel.getByRole('status')).toContainText('Roofline已完成');await page.getByLabel('Batch',{exact:true}).fill('2');await expect(panel).toHaveCount(0);await calculate(page);await study(page);expect((await exported(page,'roofline-edited')).scenario.workload.batchSize).toBe(2);
});
test('uses the explicitly selected decode step and its changing context instead of a mixed sequence roof',async({page})=>{
  await open(page,ProjectDocument.parse(JSON.parse(readFileSync('examples/computed/decode-growing-project.json','utf8')) as unknown));const panel=page.locator('.roofline-study');await panel.getByLabel('Roofline decode步骤',{exact:true}).selectOption('1');await study(page);const r=await exported(page,'roofline-decode');expect(r.request.decodeStep).toBe(1);expect(r.base.evaluatedContext).toBe(3);expect(r.base.stepInputHash).toBeDefined();await expect(panel.locator('.roofline-study-results')).toContainText('步骤上下文 3');
});

test('bounds canvas study evidence and exports every integer and class after cancellation and retry',async({page})=>{
  await page.addInitScript(()=>{
    const NativeWorker=window.Worker;
    const held:(()=>void)[]=[];
    Object.assign(window,{rooflineHeldExports:held});
    window.Worker=class extends NativeWorker{
      constructor(url:string|URL,options?:WorkerOptions){
        super(url,options);
        if(!String(url).includes('roofline-study-worker-'))return;
        this.addEventListener('message',event=>{
          if(event.data?.kind!=='exported')return;
          event.stopImmediatePropagation();
          held.push(()=>this.onmessage?.call(this,event));
        });
      }
    };
  });
  const project=makeRooflineProject(c01Project(),.625,.75);
  project.projectId=randomUUID();
  const op=project.assetSnapshots.find(asset=>asset.definition.kind==='operator'&&asset.definition.operator.cost.timing.kind==='roofline_bound')?.definition;
  const hw=project.assetSnapshots.find(asset=>asset.definition.kind==='hardware')?.definition;
  if(op?.kind!=='operator'||hw?.kind!=='hardware')throw Error('Missing Roofline fixture assets');
  const segment=op.operator.cost.compute[0];
  if(!segment)throw Error('Missing fixture compute segment');
  for(let index=1;index<=11;index++){
    const resourceKey='custom-'+index;
    const computeClass={...segment.computeClass,resource:'custom' as const,resourceKey};
    op.operator.cost.compute.push({...segment,segmentId:resourceKey,computeClass});
    hw.hardware.computeCapabilities.push({kind:'peak',computeClass,operationsPerSecond:400});
  }
  await page.goto('/');
  await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({name:'roofline-paged.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.getByRole('button',{name:'分析此配置 ↗',exact:true}).click();
  const panel=page.locator('.studio-inspector .roofline-study');
  await panel.getByLabel('扫描 Roofline 参数拐点',{exact:true}).check();
  await panel.getByLabel('Roofline扫描变量',{exact:true}).selectOption('parameter:M');
  await panel.getByLabel('Roofline扫描最大值',{exact:true}).fill('41');
  await study(page);

  const result=panel.locator('.roofline-study-results'),samples=result.locator('.roofline-samples');
  await expect(result.locator('pre')).toHaveCount(0);
  await expect(samples.locator('tbody tr')).toHaveCount(0);
  await expect(result.getByRole('navigation',{name:'计算分类分页'})).toContainText('1–10 / 12');
  await panel.getByRole('button',{name:'下一页计算分类',exact:true}).click();
  await expect(result.getByRole('navigation',{name:'计算分类分页'})).toContainText('11–12 / 12');
  await expect(result.locator('.roofline-transition')).toHaveCount(4);
  // Use the selector to inspect one class at any integer, independent of the class page.
  const series=await panel.getByLabel('筛选Roofline分类',{exact:true}).locator('option').filter({hasText:'custom-11 '}).getAttribute('value');
  if(!series)throw Error('Missing final compute class');
  await panel.getByLabel('筛选Roofline分类',{exact:true}).selectOption(series);
  await samples.locator(':scope > summary').click();
  await expect(samples.locator('tbody tr')).toHaveCount(20);
  await samples.getByRole('button',{name:'下一页整数样本',exact:true}).click();
  await samples.getByRole('button',{name:'下一页整数样本',exact:true}).click();
  await expect(samples.locator('tbody tr')).toHaveCount(1);
  const finalSample=samples.getByRole('button',{name:'查看样本 41 运算强度依据',exact:true});
  await finalSample.click();
  await expect(panel.locator('.roofline-source-panel')).toContainText('按原固定整数 41 后台复核');
  await samples.locator('tbody details > summary').click();
  await expect(samples.locator('pre')).toContainText('"value": 41');
  await samples.locator(':scope > summary').click();
  await expect(samples.locator('tbody tr')).toHaveCount(0);

  const downloads:string[]=[];
  page.on('download',file=>downloads.push(file.suggestedFilename()));
  const deliver=()=>page.evaluate(()=>{(window as Window&{rooflineHeldExports?:Array<()=>void>}).rooflineHeldExports?.shift()?.();});
  const held=()=>page.evaluate(()=>(window as Window&{rooflineHeldExports?:Array<()=>void>}).rooflineHeldExports?.length??0);
  const exportButton=panel.getByRole('button',{name:'导出 Roofline 研究 JSON',exact:true});
  await exportButton.click();
  await expect.poll(held).toBe(1);
  await panel.getByRole('button',{name:'取消 Roofline 导出',exact:true}).click();
  await expect(panel.getByText('Roofline 导出已取消，可用当前结果重试。',{exact:true})).toBeVisible();
  await exportButton.click();
  await expect.poll(held).toBe(2);
  await deliver();
  expect(downloads).toHaveLength(0);
  const waiting=page.waitForEvent('download');
  await deliver();
  const file=await(await waiting).path();
  if(!file)throw Error('Missing downloaded Roofline report');
  const report=RooflineStudyResult.parse(JSON.parse(readFileSync(file,'utf8')));
  expect(report.samples.map(sample=>sample.value)).toEqual(Array.from({length:41},(_,index)=>index+1));
  expect(report.base.observations).toHaveLength(12);
  expect(report.samples.at(-1)?.observations).toHaveLength(12);
  expect(report.scenario).toEqual(project.scenarios[0]);

  await exportButton.click();
  await expect.poll(held).toBe(1);
  await panel.getByLabel('Roofline扫描最大值',{exact:true}).fill('42');
  await expect(result).toHaveCount(0);
  await deliver();
  expect(downloads).toEqual(['roofline-study.json']);
});
