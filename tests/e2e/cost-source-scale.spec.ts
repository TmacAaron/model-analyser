import {expect,test,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {runtimeScaleProject} from '../../scripts/runtime-scale-project.js';

const count=9999;
test.setTimeout(180000);

async function openInspector(page:Page){
 return page.evaluate(async()=>{
  const summary=document.querySelector<HTMLElement>('.cost-source-inspector > summary');
  if(!summary)throw Error('Missing cost source summary');
  const start=performance.now();
  summary.click();
  await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
  return {
   milliseconds:performance.now()-start,
   options:document.querySelectorAll('.cost-source-inspector select[aria-label="成本来源范围"] option').length,
   collapsedParameterRows:document.querySelectorAll('.cost-source-inspector .evaluated-parameters:not([open]) tbody tr').length,
   collapsedHardwarePre:document.querySelectorAll('.cost-source-inspector details:not([open]) pre').length,
  };
 });
}

test('keeps source inspection bounded on a real 9,999-leaf result and finds a late leaf exactly',async({page})=>{
 const project=runtimeScaleProject('operator',count);
 project.projectId=randomUUID();
 const op=project.assetSnapshots.find(asset=>asset.definition.kind==='operator');
 if(!op)throw Error('Missing synthetic operator');
 op.parameters.push({key:'Width',name:'Width',type:'integer',unit:'count',default:{kind:'integer',value:7}});
 await page.goto('/');
 await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({name:'large-sources.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
 await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
 await page.getByRole('button',{name:'分析此配置 ↗',exact:true}).click();
 await expect(page.locator('.analysis-cards')).toBeVisible({timeout:120000});
 const inspector=page.locator('.cost-source-inspector');
 const observations=[];
 for(let i=0;i<3;i++){
  observations.push(await openInspector(page));
  await expect(inspector.getByLabel('成本来源范围',{exact:true})).toHaveValue('model');
  if(i<2){
   await inspector.locator(':scope > summary').click();
   await expect(inspector.locator('.cost-source-content')).toHaveCount(0);
  }
 }
 console.log('Cost source open observations',JSON.stringify(observations));
 for(const observation of observations)expect(observation).toMatchObject({options:100,collapsedParameterRows:0,collapsedHardwarePre:0});
 await inspector.locator('.evaluated-parameters > summary').click();
 const parameters=inspector.locator('.evaluated-parameters');
 await expect(parameters.locator('summary')).toContainText(String(count));
 await expect(parameters.locator('tbody tr').first()).toContainText('7 count');
 await expect(parameters.locator('tbody tr')).toHaveCount(20);
 await parameters.getByRole('button',{name:'下一页参数',exact:true}).click();
 await expect(parameters.locator('tbody tr')).toHaveCount(20);
 await expect(parameters.locator('tbody tr').first()).toContainText('leaves[20]:Width');
 await parameters.locator('summary').click();
 await expect(parameters.locator('tbody tr')).toHaveCount(0);
 const scope=inspector.getByLabel('成本来源范围',{exact:true}),search=inspector.getByLabel('查找成本来源范围',{exact:true});
 await search.fill('leaves[9998]');
 await scope.selectOption('node:leaves[9998]');
 await expect(inspector.locator('.metric-source-proof h4').first()).toContainText('leaves[9998]');
 await expect(inspector.locator('.source-value')).toContainText('0.000001 second');
 await search.fill('no matching source');
 await expect(scope.locator('option')).toHaveCount(1);
 await expect(scope).toHaveValue('node:leaves[9998]');
});
