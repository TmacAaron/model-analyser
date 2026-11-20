import { test,expect,type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ParallelResolution,ProjectDocument } from '@model-analyser/contracts';
import { analyzeScenario } from '@model-analyser/core';
import { validateParallelResolution } from '../../packages/contracts/src/parallel-validation.js';
import { makeNativeCollectiveProject } from '../../scripts/native-collective-project.js';
import { c01Project } from '../model-fixtures.js';

async function open(page:Page,project:ProjectDocument){
  project.projectId=randomUUID();
  await page.goto('/');
  await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({
    name:'canvas-layout.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await expect(page.getByLabel('当前模型',{exact:true})).toHaveValue(project.scenarios[0]!.model.assetId);
}

test('opens selected module layouts and native communication on the model canvas',async({page})=>{
  const project=makeNativeCollectiveProject(c01Project());
  await open(page,project);
  await page.locator('[data-node-id="module"]').press('Space');
  await page.getByRole('button',{name:'查看所选节点设备布局',exact:true}).click();
  const section=page.locator('.studio-inspector .canvas-layout-evidence');
  const scope=section.getByLabel('布局范围',{exact:true}),evidence=section.getByLabel('布局证据',{exact:true});
  await expect(scope).toHaveValue('selected');
  const tensor=section.locator('details > summary').filter({hasText:'module/op → Y'});
  await expect(tensor).toHaveCount(1);
  await tensor.click();
  await expect(section).toContainText('gpu0');
  await expect(section).toContainText('gpu1');
  await expect(section).toContainText('col [0, 4)');
  await expect(section).toContainText('col [4, 8)');
  const hash=await section.locator('code').first().textContent();
  await evidence.selectOption('compute');
  await section.getByText('module/op · 局部成本',{exact:true}).click();
  await expect(section).toContainText('2.88 s');
  await evidence.selectOption('communication');
  await expect(section).toContainText('当前范围没有显式通信记录');
  await page.locator('[data-node-id="gather-Y"]').press('Space');
  await expect(section.getByText(/all_gather · gather-Y/)).toBeVisible();
  await section.getByText(/all_gather · gather-Y/).click();
  await expect(section).toContainText('32 B');
  await section.getByText('通信前分片',{exact:true}).click();
  await expect(section).toContainText('col [4, 8)');
  await expect(section.locator('code').first()).toHaveText(hash??'');
  const response=await page.request.get('/api/v1/project?id='+project.projectId);
  expect(ProjectDocument.parse((await response.json()).data).projectRevision).toBe(1);
});

test('exports the active distributed Decode step and discards a queued export from the previous step',async({page})=>{
  await page.addInitScript(()=>{
    const NativeWorker=window.Worker,held:(()=>void)[]=[];
    Object.assign(window,{canvasLayoutDownloads:held});
    window.Worker=class extends NativeWorker{
      constructor(url:string|URL,options?:WorkerOptions){
        super(url,options);
        if(!String(url).includes('analysis-worker-'))return;
        this.addEventListener('message',event=>{
          if(event.data?.kind!=='exported'||event.data.selection?.kind!=='layout')return;
          event.stopImmediatePropagation();
          held.push(()=>this.onmessage?.call(this,event));
        });
      }
    };
  });
  const project=makeNativeCollectiveProject(c01Project()),scenario=project.scenarios[0]!;
  if(scenario.workload.kind!=='decode')throw Error('Expected native Decode fixture');
  scenario.workload.steps=3;
  const reference=await analyzeScenario(scenario,project.assetSnapshots);
  if(reference.status!=='available'||!reference.result.decode)throw Error('Expected distributed Decode result');
  const previous=reference.result.decode.steps[1]?.result.distributed?.layout;
  const current=reference.result.decode.steps[2]?.result.distributed?.layout;
  if(!previous||!current)throw Error('Missing actual step layouts');
  expect(current.inputHash).not.toBe(previous.inputHash);
  await open(page,project);
  await page.getByRole('button',{name:'并行方式',exact:true}).click();
  await page.getByRole('button',{name:'分析设备布局与通信',exact:true}).click();
  const section=page.locator('.studio-inspector .canvas-layout-evidence');
  const step=section.getByLabel('布局 Decode 步骤',{exact:true}),exportButton=section.getByRole('button',{name:'导出完整布局 JSON',exact:true});
  const held=()=>page.evaluate(()=>(window as Window&{canvasLayoutDownloads?:Array<()=>void>}).canvasLayoutDownloads?.length??0);
  const deliver=()=>page.evaluate(()=>{(window as Window&{canvasLayoutDownloads?:Array<()=>void>}).canvasLayoutDownloads?.shift()?.();});
  const downloads:string[]=[];
  page.on('download',file=>downloads.push(file.suggestedFilename()));
  await step.selectOption('1');
  await expect(section).toContainText(previous.inputHash.slice(0,20));
  await exportButton.click();
  await expect.poll(held).toBe(1);
  await step.selectOption('2');
  await expect(section).toContainText('实际 Decode 步骤 3');
  await expect(section).toContainText(current.inputHash.slice(0,20));
  await deliver();
  expect(downloads).toHaveLength(0);
  await exportButton.click();
  await expect.poll(held).toBe(1);
  const waiting=page.waitForEvent('download');
  await deliver();
  const file=await waiting;
  expect(file.suggestedFilename()).toBe('decode-step-3-layout.json');
  const path=await file.path();
  if(!path)throw Error('Missing downloaded layout');
  const exported=ParallelResolution.parse(JSON.parse(await readFile(path,'utf8')));
  expect(validateParallelResolution(exported)).toEqual([]);
  expect(exported).toEqual(current);
});
