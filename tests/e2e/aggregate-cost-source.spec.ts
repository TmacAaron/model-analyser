import {test,expect,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {ProjectDocument} from '@model-analyser/contracts';
import {c01Project} from '../model-fixtures.js';
import {makeDecodeProject} from '../../scripts/decode-project.js';

async function inspect(page:Page,project:ProjectDocument){
 project.projectId=randomUUID();
 await page.goto('/');
 await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({name:'aggregate-source.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
 await expect(page.locator('.model-studio')).toHaveAttribute('data-workspace-id',project.projectId);
 await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
 await page.getByRole('button',{name:'分析此配置 ↗',exact:true}).click();
 await expect(page.locator('.analysis-cards')).toBeVisible();
 const inspector=page.locator('.cost-source-inspector');
 await inspector.locator(':scope > summary').click();
 return inspector;
}

test('downloads an independently replayable module aggregate and opens its exact leaf work',async({page})=>{
 const inspector=await inspect(page,c01Project());
 await inspector.getByLabel('成本来源范围',{exact:true}).selectOption('module:module');
 const metric=inspector.getByLabel('成本来源指标',{exact:true});
 await metric.selectOption('executed:0');
 const aggregate=inspector.getByRole('region',{name:'聚合运算来源'});
 await aggregate.getByRole('button',{name:'复核此指标的聚合运算',exact:true}).click();
 await expect(aggregate).toContainText('0 + 1024 = 1024 operation');
 const download=page.waitForEvent('download');
 await aggregate.getByRole('button',{name:'导出此页聚合来源',exact:true}).click();
 const file=await(await download).path();if(!file)throw Error('Missing aggregate download');
 const cli=await promisify(execFile)(process.execPath,['--import','tsx','scripts/verify-leaf-cost-source.ts',file]);
 expect(JSON.parse(cli.stdout)).toMatchObject({kind:'aggregate_cost_source',operation:'ordered_sum',quantity:{value:1024,unit:'operation'}});
 await aggregate.getByRole('button',{name:'查看此项来源',exact:true}).click();
 await expect(inspector.getByLabel('成本来源范围',{exact:true})).toHaveValue('node:module/op');
 await expect(metric).toHaveValue('executed:0');
 await inspector.getByRole('button',{name:'复核此叶指标的精确表达式',exact:true}).click();
 await expect(inspector.locator('.leaf-cost-source')).toContainText('已复核原叶指标：1024 operation');
});

test('opens an actual growing Decode step from its model aggregate without borrowing the sequence value',async({page})=>{
 const inspector=await inspect(page,makeDecodeProject(c01Project()));
 await inspector.getByLabel('成本来源指标',{exact:true}).selectOption('hbm');
 const aggregate=inspector.getByRole('region',{name:'聚合运算来源'});
 await aggregate.getByRole('button',{name:'复核此指标的聚合运算',exact:true}).click();
 await expect(aggregate).toContainText('已复核原指标 24 byte');
 const third=aggregate.locator('article').filter({hasText:'步骤 3'});
 await expect(third).toContainText('Context 4');
 await expect(third).toContainText('14 + 10 = 24 byte');
 await third.getByRole('button',{name:'查看此项来源',exact:true}).click();
 await expect(inspector.getByLabel('来源步骤',{exact:true})).toHaveValue('2');
 await aggregate.getByRole('button',{name:'复核此指标的聚合运算',exact:true}).click();
 await expect(aggregate).toContainText('已复核原指标 10 byte');
 await expect(aggregate).toContainText('算子 update');
});
