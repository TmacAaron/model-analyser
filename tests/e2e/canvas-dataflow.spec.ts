import {test,expect} from '@playwright/test';
test.use({viewport:{width:1600,height:1100}});
test('Qwen residual keeps the same input fan-out and repeated decoders open one actual invocation',async({page})=>{
 await page.goto('/');await expect(page.getByRole('application',{name:'模型结构画布',exact:true})).toBeVisible();const model=page.getByLabel('当前模型',{exact:true});if(await model.inputValue()!=='builtin:model:qwen3-0.6b')await model.selectOption('builtin:model:qwen3-0.6b');await expect(model).toHaveValue('builtin:model:qwen3-0.6b');await expect(page.locator('.studio-save')).toContainText('已保存');
 const decoder=page.locator('[data-node-id="decoder"]');await expect(decoder).toContainText('28 ×');await decoder.press('Enter');
 const instance=page.getByLabel('查看重复模块实例',{exact:true});await expect(instance).toHaveValue('decoder[0]');await expect(page.locator('[data-node-id="decoder[1]/input-norm"]')).toHaveCount(0);
 const arrows=await page.getByRole('img').evaluateAll(elements=>elements.map(e=>e.getAttribute('aria-label')??''));
 const bypass=arrows.find(a=>a.includes('$input:')&&a.endsWith(' → decoder[0]/attention-residual'));expect(bypass).toBeDefined();
 const source=bypass!.split(' · ').at(-1)!.split(' → ')[0]!;expect(arrows.some(a=>a.endsWith(source+' → decoder[0]/input-norm'))).toBe(true);
 expect(arrows.some(a=>a.endsWith('decoder[0]/attention-residual → decoder[0]/mlp-residual'))).toBe(true);
 const attention=page.locator('[data-node-id="decoder[0]/$view:attention"]');
 await expect(attention).toContainText('GQA Attention');
 await expect(page.locator('[data-node-id="decoder[0]/qk"]')).toHaveCount(0);
 await attention.press('Enter');
 await expect(page.locator('[data-node-id="decoder[0]/qk"]')).toBeVisible();
 await expect(page.getByRole('img',{name:/decoder\[0\]\/qk → decoder\[0\]\/softmax$/})).toHaveCount(1);
 await page.getByRole('navigation',{name:'模块路径',exact:true}).getByRole('button',{name:'decoder[0]',exact:true}).click();
 await page.locator('[data-node-id="decoder[0]/input-norm"]').press('Space');await page.locator('[data-node-id="decoder[0]/mlp-residual"]').press('Shift+Space');await page.getByRole('button',{name:'定位选中节点',exact:true}).click();await page.screenshot({path:'test-results/canvas-residual-dataflow.png'});
 await instance.selectOption('decoder[27]');await expect(page.locator('[data-node-id="decoder[27]/input-norm"]')).toHaveCount(1);await expect(page.locator('[data-node-id="decoder[0]/input-norm"]')).toHaveCount(0);
});
test('MoE shows declared routing/shared fan-out and merge within one of26 actual decoder calls',async({page})=>{
 await page.goto('/');await expect(page.getByRole('application',{name:'模型结构画布',exact:true})).toBeVisible();await page.getByLabel('当前模型',{exact:true}).selectOption('builtin:model:deepseek-v2-lite-expanded');
 const repeat=page.locator('[data-node-id="moe"]');await expect(repeat).toContainText('26 ×');await repeat.press('Enter');await expect(page.getByLabel('查看重复模块实例',{exact:true})).toHaveValue('moe[0]');await expect(page.locator('[data-node-id="moe[1]"]')).toHaveCount(0);
 for(const [from,to] of [['post-norm','router'],['post-norm','shared-gate-up'],['combine','shared-add'],['shared-down','shared-add']])await expect(page.getByRole('img',{name:new RegExp('moe\\[0\\]/'+from+' → moe\\[0\\]/'+to+'$')})).toHaveCount(1);
 await page.locator('[data-node-id="moe[0]/post-norm"]').press('Space');await page.locator('[data-node-id="moe[0]/expert-down"]').press('Shift+Space');await page.getByRole('button',{name:'定位选中节点',exact:true}).click();await page.screenshot({path:'test-results/canvas-moe-dataflow.png'});
 await page.getByLabel('查看重复模块实例',{exact:true}).selectOption('moe[25]');await expect(page.locator('[data-node-id="moe[25]/router"]')).toHaveCount(1);await expect(page.locator('[data-node-id="moe[0]/router"]')).toHaveCount(0);
});
