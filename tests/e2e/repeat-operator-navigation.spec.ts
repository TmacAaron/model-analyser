import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {c01Project,echo} from '../model-fixtures.js';
test('opaque repeated calls stay open at their actual node and explicitly expose cross-call fusion selection',async({page})=>{
 const f=echo('chain'),p={...c01Project(),projectId:randomUUID(),scenarios:[f.scenario],assetSnapshots:f.assets};await page.goto('/');await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({name:'repeat.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(p))});await expect(page.locator('.model-studio')).toHaveAttribute('data-workspace-id',p.projectId);await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');await page.locator('[data-node-id="block"]').press('Enter');
 await expect(page.getByLabel('查看重复模块实例',{exact:true})).toHaveValue('block[0]');await expect(page.locator('.studio-node-path')).toHaveText('block[0]');await expect(page.locator('.canvas-node.operator')).toHaveCount(1);
 await page.getByLabel('查看重复模块实例',{exact:true}).selectOption('block[2]');await expect(page.locator('.studio-node-path')).toHaveText('block[2]');await expect(page.locator('[data-node-id="block[0]"]')).toHaveCount(0);
 await page.getByLabel('跨调用选择算子',{exact:true}).check();await expect(page.locator('.canvas-node.operator')).toHaveCount(3);await page.getByLabel('跨调用选择算子',{exact:true}).uncheck();await expect(page.locator('.canvas-node.operator')).toHaveCount(1);await expect(page.locator('.studio-node-path')).toHaveText('block[0]');
 const response=await page.request.get('/api/v1/project?id='+p.projectId);expect((await response.json()).data).toEqual(p);
});
