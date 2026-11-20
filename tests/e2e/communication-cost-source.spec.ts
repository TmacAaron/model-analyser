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
 const endpoints=communication.getByRole('region',{name:'通信端点布局'});
 await expect(endpoints).toContainText('源端 Y · 分片');
 await expect(endpoints).toContainText('目标端 Yg · 复制');
 const gpu1=communication.getByRole('article').filter({has:page.getByRole('heading',{name:'gpu1',exact:true})});
 const source=gpu1.locator('details').filter({has:page.locator('summary').filter({hasText:'源端布局'})});
 await source.locator('summary').click();
 await expect(source).toContainText('[4, 8) · 有效 4 · 分配 4');
 await expect(gpu1.locator('summary').filter({hasText:'目标端布局'})).toContainText('32 个有效元素 · 32 个分配元素');
 await communication.getByText('统一消息的公式与组总量',{exact:true}).click();
 await expect(communication).toContainText('rows * cols');
 const bindings=communication.getByRole('region',{name:'实际参数绑定链'});
 await expect(bindings.getByRole('table',{name:'通信算式的参数输入'})).toContainText('每成员发送量');
 await expect(bindings.locator('tr').filter({hasText:'每成员发送量'}).first()).toContainText('4 count');
 const download=page.waitForEvent('download');
 await communication.getByRole('button',{name:'导出此页通信来源',exact:true}).click();
 const file=await(await download).path();if(!file)throw Error('Missing communication export');
 const cli=await promisify(execFile)(process.execPath,['--import','tsx','scripts/verify-leaf-cost-source.ts',file]);
 expect(JSON.parse(cli.stdout)).toMatchObject({kind:'communication_cost_source',schemaVersion:3,operation:'all_gather',quantity:{value:.017,unit:'second'},parameterBindingGraph:{complete:true,roots:4}});
});

test('switches the actual Decode workload binding for a nonuniform communication',async({page})=>{
 const project=makeSerialGatherProject(c01Project()),scenario=project.scenarios[0]!;
 const declaration=scenario.parallelPlan.communications[0]!;
 if(scenario.workload.kind!=='decode'||declaration.sendBytesPerMember.kind!=='formula')throw Error('Missing Decode communication fixture');
 scenario.workload={...scenario.workload,contextTokensPerRequest:2,queryTokensPerRequest:1,steps:3};
 scenario.bindings=[...scenario.bindings.filter(item=>item.parameterKey!=='M'),{parameterKey:'M',value:{kind:'symbol',name:'contextTokensPerRequest'}}];
 const dynamic=structuredClone(declaration.sendBytesPerMember);
 dynamic.call.bindings['rows']={kind:'symbol',name:'contextTokensPerRequest'};
 declaration.perDevicePayloads=scenario.deviceTopology.devices.map((device,index)=>({deviceId:device.deviceId,
  sendBytes:index?{kind:'literal',quantity:{value:48,unit:'byte'}}:dynamic,
  receiveBytes:{kind:'literal',quantity:{value:index?16:48,unit:'byte'}},trafficFactor:index?1:4}));
 const inspector=await inspect(page,project);
 const steps=inspector.getByLabel('来源步骤',{exact:true});
 await steps.selectOption('0');
 await inspector.getByLabel('成本来源范围',{exact:true}).selectOption('communication:0');
 await inspector.getByLabel('成本来源指标',{exact:true}).selectOption('send:0');
 const communication=inspector.getByRole('region',{name:'通信运算来源'});
 await communication.getByRole('button',{name:'复核此通信的实际运算',exact:true}).click();
 await expect(communication).toContainText('已复核原指标 不可用');
 await expect(communication).toContainText('组总发送 64 byte');
 await expect(communication.locator('article').filter({hasText:'gpu0'})).toContainText('发送量 × 4 = 64 byte');
 await expect(communication.locator('article').filter({hasText:'gpu1'})).toContainText('16 + 48 = 64 byte');
 await expect(communication).toContainText('64 ÷ 1000 = 0.064 s');
 const endpoints=communication.getByRole('region',{name:'通信端点布局'});
 await expect(endpoints).toContainText('row=2 × col=8');
 const context=communication.getByRole('row').filter({hasText:'contextTokensPerRequest'});
 await expect(context).toContainText('2 count');
 await steps.selectOption('2');
 await expect(context).toContainText('4 count');
 await expect(communication).toContainText('组总发送 80 byte');
 await expect(communication.locator('article').filter({hasText:'gpu1'})).toContainText('32 + 48 = 80 byte');
 await expect(communication).toContainText('128 ÷ 1000 = 0.128 s');
 await expect(endpoints).toContainText('row=4 × col=8');
});
