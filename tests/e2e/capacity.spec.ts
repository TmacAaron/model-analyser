import { test,expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ProjectDocument,CapacitySearchResult,DeviceId } from '@model-analyser/contracts';
import { validateCapacitySearch } from '../../packages/contracts/src/capacity-validation.js';
import { makeSerialGatherProject } from '../../scripts/serial-gather-project.js';
import { c01Project } from '../model-fixtures.js';
test('background capacity search enumerates rounding-safe ranges, exports evidence and supports cancellation without editing the scenario',async({page})=>{
  const project=ProjectDocument.parse(JSON.parse(readFileSync('examples/contracts/project.json','utf8')) as unknown);project.projectId=randomUUID();project.name='Capacity '+project.projectId.slice(0,8);
  await page.goto('/?legacy=1&workspace=projects');await page.getByLabel('导入项目文件').setInputFiles({name:'project.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});await expect(page.locator('.project-editor .save-state')).toContainText('已保存 · 修订 1');
  const panel=page.locator('.capacity-panel');await page.getByLabel('容量求解变量',{exact:true}).selectOption('parameter:M');await page.getByLabel('容量搜索最大值',{exact:true}).fill('100');await page.getByRole('button',{name:'搜索容量',exact:true}).click();await expect(panel.locator('.capacity-summary')).toContainText('区间内最大可容纳值：80');await expect(panel.locator('tbody tr')).toHaveCount(40);await expect(panel.getByRole('img',{name:'容量搜索显存曲线',exact:true})).toBeVisible();await expect(page.locator('.project-editor .save-state')).toContainText('已保存 · 修订 1');
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出容量搜索 JSON',exact:true}).click();const file=await download,path='test-results/capacity-'+project.projectId+'.json';await file.saveAs(path);const r=CapacitySearchResult.parse(JSON.parse(readFileSync(path,'utf8')) as unknown);expect(r.capacityStatus).toMatchObject({kind:'solved',maximum:80});expect(r.points[79]).toMatchObject({value:80,fit:'fits',memory:[{peakBytes:{status:'available',quantity:{value:4096}}}]});expect(r.points[80]).toMatchObject({value:81,fit:'exceeds'});expect(r.baseScenario).toEqual(project.scenarios[0]);await panel.screenshot({path:'test-results/capacity-panel.png'});
  await page.getByLabel('容量搜索最大值',{exact:true}).fill('512');await expect(panel).toContainText('旧容量搜索已失效');await page.getByRole('button',{name:'搜索容量',exact:true}).click();await expect(panel.getByRole('status')).toContainText('已完成');await page.getByRole('button',{name:'取消搜索',exact:true}).click();await expect(panel.locator('.capacity-summary')).toContainText('搜索已取消，未证明最大容量');
  await page.locator('.project-json summary').click();const editor=page.getByRole('textbox',{name:'项目定义 JSON'}),current=ProjectDocument.parse(JSON.parse(await editor.inputValue()) as unknown);const scenario=current.scenarios[0];if(!scenario)throw Error();scenario.workload.batchSize++;await editor.fill(JSON.stringify(current,null,2));await expect(panel).toContainText('旧容量搜索已失效');await expect(panel.locator('.capacity-summary')).toHaveCount(0);
});

test('keeps all 512 canvas capacity samples in the chart and downloadable evidence while browsing or cancelling a download',async({page})=>{
  test.setTimeout(90000);
  await page.addInitScript(()=>{
    const NativeWorker=window.Worker;
    const held:(()=>void)[]=[];
    Object.assign(window,{capacityHeldExports:held});
    window.Worker=class extends NativeWorker{
      constructor(url:string|URL,options?:WorkerOptions){
        super(url,options);
        if(!String(url).includes('capacity-worker-'))return;
        this.addEventListener('message',event=>{
          if(event.data?.kind!=='exported')return;
          event.stopImmediatePropagation();
          held.push(()=>this.onmessage?.call(this,event));
        });
      }
    };
  });
  const project=c01Project();
  project.projectId=randomUUID();
  await page.goto('/');
  await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({name:'long-capacity.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.getByRole('button',{name:'容量',exact:true}).click();
  const panel=page.locator('.studio-inspector .capacity-panel'),max=panel.getByLabel('容量搜索最大值',{exact:true});
  await panel.getByLabel('容量求解变量',{exact:true}).selectOption('parameter:M');
  await max.fill('512');
  await panel.getByRole('button',{name:'搜索容量',exact:true}).click();
  const summary=panel.locator('.capacity-summary');
  await expect(summary).toContainText('已计算 512 点');
  await expect(summary).toContainText('区间内最大可容纳值：80');

  const chart=panel.getByRole('img',{name:'容量搜索显存曲线'});
  const glyphPaths=chart.locator('[data-dense-capacity] > path');
  await expect(glyphPaths).toHaveCount(4);
  expect(await glyphPaths.evaluateAll(paths=>paths.map(path=>(path.getAttribute('d')?.match(/M/g)??[]).length))).toEqual([512,80,432,0]);
  const rows=panel.locator('.capacity-table tbody > tr');
  await expect(rows).toHaveCount(40);
  await expect(panel.locator('pre')).toHaveCount(0);
  await panel.getByRole('button',{name:'下一页容量样本',exact:true}).click();
  await expect(rows.first().locator('td').first()).toHaveText('41');
  await panel.getByLabel('定位容量整数',{exact:true}).fill('512');
  await panel.getByRole('button',{name:'定位容量样本',exact:true}).click();
  await expect(rows).toHaveCount(32);
  await expect(rows.last()).toBeFocused();
  const sample=panel.getByRole('button',{name:'查看整数 512 gpu0 峰值依据',exact:true});
  await sample.click();
  const proof=panel.getByRole('region',{name:'整数点来源复核',exact:true});
  await expect(proof).toContainText('已按原扫描固定输入后台复核');
  await expect(proof).toContainText('原始 24832 byte');

  const downloads:string[]=[];
  page.on('download',file=>downloads.push(file.suggestedFilename()));
  const deliver=()=>page.evaluate(()=>{(window as Window&{capacityHeldExports?:Array<()=>void>}).capacityHeldExports?.shift()?.();});
  const held=()=>page.evaluate(()=>(window as Window&{capacityHeldExports?:Array<()=>void>}).capacityHeldExports?.length??0);
  const exportButton=panel.getByRole('button',{name:'导出容量搜索 JSON',exact:true});
  await exportButton.click();
  await expect.poll(held).toBe(1);
  await panel.getByRole('button',{name:'取消容量导出',exact:true}).click();
  await expect(panel.getByText('容量导出已取消，可用当前结果重试。')).toBeVisible();
  await exportButton.click();
  await expect.poll(held).toBe(2);
  await deliver();
  expect(downloads).toHaveLength(0);
  const waiting=page.waitForEvent('download');
  await deliver();
  const file=await(await waiting).path();
  if(!file)throw Error('Missing completed capacity export');
  const report=CapacitySearchResult.parse(JSON.parse(readFileSync(file,'utf8')));
  expect(validateCapacitySearch(report)).toEqual([]);
  expect(report.points.map(point=>point.value)).toEqual(Array.from({length:512},(_,index)=>index+1));
  expect(report.baseScenario).toEqual(project.scenarios[0]);
  const last=report.points.at(-1);
  if(last?.status!=='available')throw Error('Missing final sample evidence');
  await expect(proof.locator('.scalar-source-panel code').first()).toHaveText(last.inputHash);

  await exportButton.click();
  await expect.poll(held).toBe(1);
  await max.fill('511');
  await expect(summary).toHaveCount(0);
  await deliver();
  expect(downloads).toEqual(['model-analyser-capacity.json']);
});

test('pages physical devices for one point and keeps the final device linked to its own capacity source',async({page})=>{
  const project=makeSerialGatherProject(c01Project());
  project.projectId=randomUUID();
  const topology=project.scenarios[0]?.deviceTopology,first=topology?.devices[0];
  if(!topology||!first)throw Error('Missing distributed fixture devices');
  for(let index=1;index<=11;index++){
    const deviceId=DeviceId.parse('z-idle-'+String(index).padStart(2,'0'));
    topology.devices.push({...first,deviceId});
  }
  await page.goto('/');
  await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({name:'many-devices.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.getByRole('button',{name:'容量',exact:true}).click();
  const panel=page.locator('.studio-inspector .capacity-panel');
  await panel.getByLabel('容量搜索最大值',{exact:true}).fill('1');
  await panel.getByRole('button',{name:'搜索容量',exact:true}).click();
  const pager=panel.getByRole('navigation',{name:'设备分页',exact:true});
  await expect(pager).toContainText('1–12 / 13');
  await expect(panel.getByRole('button',{name:/查看整数 1 .* 峰值依据/})).toHaveCount(12);
  await pager.getByRole('button',{name:'下一页设备',exact:true}).click();
  await expect(pager).toContainText('13–13 / 13');
  await panel.getByRole('button',{name:'查看整数 1 z-idle-11 峰值依据',exact:true}).click();
  const proof=panel.getByRole('region',{name:'整数点来源复核',exact:true});
  await expect(proof.getByRole('heading',{name:'z-idle-11 整数点生命周期峰值 · 依据',exact:true})).toBeVisible();
  await expect(proof).toContainText('原始 0 byte');
});
