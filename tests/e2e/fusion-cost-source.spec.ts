import {expect,test,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {makeFusedProject} from '../../scripts/fused-project.js';
import {c01Project} from '../model-fixtures.js';
import type {ProjectDocument} from '@model-analyser/contracts';
import {scopedFusionTimingProject} from '../fusion-timing-fixture.js';

async function analyze(page:Page,project:ProjectDocument){
 project.projectId=randomUUID();
 await page.goto('/');
 await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({name:'fusion-source.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
 await expect(page.locator('.model-studio')).toHaveAttribute('data-workspace-id',project.projectId);
 await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
 await page.getByRole('button',{name:'分析此配置 ↗',exact:true}).click();
 await expect(page.locator('.analysis-cards')).toBeVisible();
 return page.locator('.cost-source-inspector');
}

test('opens active fusion traffic, drills to an actual retained member access and exports its group proof',async({page})=>{
 const inspector=await analyze(page,makeFusedProject(c01Project()));
 await page.getByRole('button',{name:'查看融合 pair HBM 来源',exact:true}).click();
 const fusion=inspector.getByRole('region',{name:'融合运算来源'});
 await fusion.getByRole('button',{name:'复核此融合的实际运算',exact:true}).click();
 await expect(fusion).toContainText('已复核融合指标 4 byte');
 await expect(fusion).toContainText('取消 1 个内部张量的物化 · 移除 2 项实际访问或临时分配');
 await expect(fusion).toContainText('sT · readT');
 const download=page.waitForEvent('download');
 await fusion.getByRole('button',{name:'导出此页融合来源',exact:true}).click();
 const file=await(await download).path();
 if(!file)throw Error('Missing group proof');
 const cli=await promisify(execFile)(process.execPath,['--import','tsx','scripts/verify-leaf-cost-source.ts',file]);
 expect(JSON.parse(cli.stdout)).toMatchObject({kind:'fusion_cost_source',schemaVersion:2,operation:'sum_devices',quantity:{value:4,unit:'byte'}});
 await fusion.locator('article').filter({hasText:'设备 · $fusion:pair · gpu0'}).getByRole('button',{name:'查看此项方程',exact:true}).click();
 await fusion.getByRole('button',{name:'复核此融合的实际运算',exact:true}).click();
 await expect(fusion).toContainText('按成员顺序累加，再计入附加成本');
 await fusion.locator('article').filter({hasText:'成员 · B · gpu0'}).getByRole('button',{name:'查看此项方程',exact:true}).click();
 const local=inspector.getByRole('region',{name:'逐卡运算来源'});
 await local.getByRole('button',{name:'复核此设备的局部方程',exact:true}).click();
 await expect(local).toContainText('已复核逐卡指标 2 byte');
 await expect(local).toContainText('writeY');
});

test('uses actual Decode scope for the whole-fusion timing formula and validates the exported parameter chain',async({page})=>{
 const inspector=await analyze(page,scopedFusionTimingProject());
 await inspector.locator(':scope > summary').click();
 const step=inspector.getByLabel('来源步骤',{exact:true});
 await step.selectOption('0');
 await inspector.getByLabel('成本来源范围',{exact:true}).selectOption({label:'融合 $fusion:scope-proof / gpu0'});
 const proof=inspector.getByRole('region',{name:'融合运算来源'});
 await proof.getByRole('button',{name:'复核此融合的实际运算',exact:true}).click();
 await expect(proof).toContainText('已复核融合指标 0.006 second');
 const graph=proof.getByRole('table',{name:'融合耗时的参数输入'});
 await expect(graph).toContainText('2 count');
 await step.selectOption('2');
 await expect(proof).toContainText('已复核融合指标 0.012 second');
 await expect(graph).toContainText('3 count');
 await expect(graph).toContainText('4 count');
 await expect(proof.locator('.binding-candidates')).toContainText('覆盖 #0');
 const download=page.waitForEvent('download');
 await proof.getByRole('button',{name:'导出此页融合来源',exact:true}).click();
 const file=await(await download).path();
 if(!file)throw Error('Missing scoped fusion export');
 const cli=await promisify(execFile)(process.execPath,['--import','tsx','scripts/verify-leaf-cost-source.ts',file]);
 expect(JSON.parse(cli.stdout)).toMatchObject({kind:'fusion_cost_source',schemaVersion:2,operation:'formula_override',quantity:{value:.012,unit:'second'},parameterBindingGraph:{complete:true,roots:2}});
});

test('opens the exact fused work and HBM input used by the device Roofline',async({page})=>{
 const project=makeFusedProject(c01Project(),true);
 project.scenarios[0]!.fusionGroups[0]!.timeStrategy={kind:'override',description:'Explicit fused Roofline',
  timing:{kind:'roofline_bound',computeEfficiency:1,memoryEfficiency:1,computeMemoryOverlap:'ideal',launchSeconds:0}};
 const inspector=await analyze(page,project);
 await inspector.locator(':scope > summary').click();
 await inspector.getByLabel('成本来源范围',{exact:true}).selectOption({label:'融合 $fusion:pair / gpu0'});
 const metric=inspector.getByLabel('成本来源指标',{exact:true});
 const proof=inspector.getByRole('region',{name:'融合运算来源'});
 async function expandTiming(){
  await proof.getByRole('button',{name:'复核此融合的实际运算',exact:true}).click();
  await proof.getByText('查看融合 Roofline 计算步骤',{exact:true}).click();
 }
 await expandTiming();
 await proof.getByRole('button',{name:'查看本卡执行工作量来源',exact:true}).click();
 await expect(metric).toHaveValue('executed:0');
 await proof.getByRole('button',{name:'复核此融合的实际运算',exact:true}).click();
 await expect(proof).toContainText('已复核融合指标 6 operation');
 await proof.getByRole('button',{name:'关闭融合来源',exact:true}).click();
 await metric.selectOption('seconds');
 await expandTiming();
 await proof.getByRole('button',{name:'查看本卡 HBM 来源',exact:true}).click();
 await expect(metric).toHaveValue('hbm');
 await proof.getByRole('button',{name:'复核此融合的实际运算',exact:true}).click();
 await expect(proof).toContainText('已复核融合指标 4 byte');
});
