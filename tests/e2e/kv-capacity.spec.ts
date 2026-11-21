import { expect,test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ProjectDocument,QuantizationDefinition } from '@model-analyser/contracts';
import { estimateKvCapacity } from '@model-analyser/core';
import { makeQwenProject } from '../../scripts/model-project.js';
import { makeGqaProject } from '../../scripts/gqa-project.js';

test('shows the configured KV bytes and budget in the canvas before exposing advanced scan controls',async({page})=>{
  const project=makeQwenProject({kind:'decode',batchSize:1,contextTokensPerRequest:2,queryTokensPerRequest:1,steps:1});
  project.projectId=randomUUID();
  const base=project.scenarios[0];
  if(!base)throw Error('Missing Qwen configuration');
  base.name='BF16 KV';
  const quantized={...structuredClone(base),scenarioId:'fp8-kv-fixture',name:'FP8 KV',quantizationOverrides:[
    QuantizationDefinition.parse({selector:{kind:'subtree',rootNodeId:'$model'},state:{
      payloadBits:8,packingUnitElements:1,alignmentBytes:1,auxiliaries:[],
    }}),
  ]};
  project.scenarios.push(quantized);
  const expected=await estimateKvCapacity(base,project.assetSnapshots);
  if(expected.status!=='available'||expected.report.budget.status!=='available')throw Error('Missing independent budget fixture');
  await page.addInitScript(()=>{
    const NativeWorker=globalThis.Worker;
    let heldFirstCapacityResult=false;
    globalThis.Worker=class extends NativeWorker{
      constructor(url:string|URL,options?:WorkerOptions){
        super(url,options);
        if(!heldFirstCapacityResult&&String(url).includes('kv-capacity-worker-')){
          heldFirstCapacityResult=true;
          this.addEventListener('message',event=>event.stopImmediatePropagation());
        }
      }
    };
  });
  await page.goto('/');
  await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({
    name:'kv-capacity.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.getByRole('button',{name:'容量',exact:true}).click();
  const panel=page.getByRole('region',{name:'KV 缓存容量',exact:true});
  await panel.getByRole('button',{name:'取消 KV 计算',exact:true}).click();
  await expect(panel).toContainText('KV 预算计算已取消');
  await panel.getByRole('button',{name:'重算 KV 预算',exact:true}).click();
  await expect(panel).toContainText('114,688 B / token');
  await expect(panel).toContainText(new Intl.NumberFormat('zh-CN').format(expected.report.budget.tokensPerRequest)+' token / 请求');
  await expect(panel).toContainText('所有物理设备合计 336 KiB · 每请求 3 token');
  await expect(panel.getByLabel('容量求解变量',{exact:true})).toHaveCount(0);
  await panel.getByText('逐卡显存与缓存分配',{exact:true}).click();
  await expect(panel.getByRole('row',{name:/^gpu0/})).toContainText('112 KiB');

  await page.getByRole('tab',{name:/^FP8 KV/}).click();
  await expect(panel).toContainText('57,344 B / token');
  await expect(panel).toContainText('所有物理设备合计 168 KiB · 每请求 3 token');
  await panel.getByText('高级参数扫描',{exact:true}).click();
  await expect(panel.getByLabel('容量求解变量',{exact:true})).toBeVisible();
  const saved=await page.request.get('/api/v1/project?id='+project.projectId);
  const stored=ProjectDocument.parse((await saved.json()).data);
  expect(stored.projectRevision).toBe(1);
  expect(stored.scenarios).toEqual(project.scenarios);
});

test('shows the tighter per-request budget when the two-card configuration replicates its KV cache',async({page})=>{
  const {project}=await makeGqaProject('tp-heads');
  const {project:replicated}=await makeGqaProject('tp-kv-replicated');
  const first=project.scenarios[0],second=replicated.scenarios[0];
  if(!first||!second)throw Error('Missing two-card fixture');
  project.projectId=randomUUID();
  first.name='Two-card sharded KV';
  project.scenarios.push({...second,scenarioId:'replicated-kv',name:'Two-card replicated KV'});
  await page.goto('/');
  await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({
    name:'kv-layout-cases.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await page.getByRole('button',{name:'容量',exact:true}).click();
  const panel=page.getByRole('region',{name:'KV 缓存容量',exact:true});
  await expect(panel).toContainText('96 token / 请求');
  await expect(panel).toContainText('16 B / token');
  await panel.getByText('逐卡显存与缓存分配',{exact:true}).click();
  await expect(panel.getByRole('row',{name:/^gpu0/})).toContainText('24 B');
  await expect(panel.getByRole('row',{name:/^gpu1/})).toContainText('256 B');
  await page.getByRole('tab',{name:/^Two-card replicated KV/}).click();
  await expect(panel).toContainText('44 token / 请求');
  await expect(panel).toContainText('32 B / token');
  await expect(panel).toContainText('约束设备 gpu0、gpu1');
});
