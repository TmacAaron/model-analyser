import {test,expect,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {NodeId,type ProjectDocument} from '@model-analyser/contracts';
import {makeNativeCollectiveProject} from '../../scripts/native-collective-project.js';
import {makeSerialGatherProject} from '../../scripts/serial-gather-project.js';
import {c01Project} from '../model-fixtures.js';

async function inspect(page:Page,project:ProjectDocument){
 project.projectId=randomUUID();
 await page.goto('/');
 await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({name:'communication-source.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
 await expect(page.locator('.model-studio')).toHaveAttribute('data-workspace-id',project.projectId);
 await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
 await page.getByRole('button',{name:'分析此配置 ↗',exact:true}).click();
 await expect(page.locator('.analysis-cards')).toBeVisible();
 const inspector=page.locator('.cost-source-inspector');
 await inspector.locator(':scope > summary').click();
 return inspector;
}

test('drills from a serial communication barrier to the native equation and validates its exported override',async({page})=>{
 const project=makeNativeCollectiveProject(c01Project());
 project.scenarios[0]!.numericOverrides=[{target:{kind:'node',nodeId:NodeId.parse('gather-Y')},field:'communication_bandwidth',value:{value:2000,unit:'byte_per_second'}}];
 const inspector=await inspect(page,project);
 await inspector.getByRole('button',{name:'复核此指标的聚合运算',exact:true}).click();
 await inspector.locator('.aggregate-cost-source article').filter({hasText:'通信 gather-Y'}).getByRole('button',{name:'查看此项来源',exact:true}).click();
 await expect(inspector.getByLabel('成本来源范围',{exact:true})).toHaveValue('communication:0');
 const communication=inspector.getByRole('region',{name:'通信运算来源'});
 await communication.getByRole('button',{name:'复核此通信的实际运算',exact:true}).click();
 await expect(communication).toContainText('32 ÷ 2000 = 0.016 s');
 await expect(communication).toContainText('0.016 + 0.001 = 0.017 s');
 await expect(communication).toContainText('1000 byte/s · 0.001 s/轮 → 2000 byte/s');
 await communication.getByText('统一消息的公式与组总量',{exact:true}).click();
 await expect(communication).toContainText('rows * cols');
 const download=page.waitForEvent('download');
 await communication.getByRole('button',{name:'导出此页通信来源',exact:true}).click();
 const file=await(await download).path();if(!file)throw Error('Missing communication export');
 const cli=await promisify(execFile)(process.execPath,['--import','tsx','scripts/verify-leaf-cost-source.ts',file]);
 expect(JSON.parse(cli.stdout)).toMatchObject({kind:'communication_cost_source',operation:'all_gather',quantity:{value:.017,unit:'second'}});
});

test('opens rank evidence for an unavailable uniform value and shows the actual group sums',async({page})=>{
 const project=makeSerialGatherProject(c01Project()),scenario=project.scenarios[0]!;
 scenario.parallelPlan.communications[0]!.perDevicePayloads=scenario.deviceTopology.devices.map((device,index)=>({deviceId:device.deviceId,
  sendBytes:{kind:'literal',quantity:{value:index?48:16,unit:'byte'}},receiveBytes:{kind:'literal',quantity:{value:index?16:48,unit:'byte'}},trafficFactor:index?1:4}));
 const inspector=await inspect(page,project);
 await inspector.getByLabel('成本来源范围',{exact:true}).selectOption('communication:0');
 await inspector.getByLabel('成本来源指标',{exact:true}).selectOption('send:0');
 const communication=inspector.getByRole('region',{name:'通信运算来源'});
 await communication.getByRole('button',{name:'复核此通信的实际运算',exact:true}).click();
 await expect(communication).toContainText('已复核原指标 不可用');
 await expect(communication).toContainText('组总发送 64 byte');
 await expect(communication.locator('article').filter({hasText:'gpu0'})).toContainText('发送量 × 4 = 64 byte');
 await expect(communication.locator('article').filter({hasText:'gpu1'})).toContainText('16 + 48 = 64 byte');
 await expect(communication).toContainText('64 ÷ 1000 = 0.064 s');
});
