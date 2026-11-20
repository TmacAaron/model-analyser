import { test,expect,type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { AssetDocument,CommitResponse,GraphTemplate,ProjectDocument } from '@model-analyser/contracts';
import { makeUpgradeProject } from '../../scripts/upgrade-project.js';
import { analyzeScenario } from '@model-analyser/core';
import { canvasEditProject } from '../canvas-fixtures.js';
import { opaqueNode,referencedNode } from '../../apps/web/src/graph-editing.js';

test.setTimeout(60000);
const editor=(page:Page)=>page.getByLabel('资产定义 JSON',{exact:true});
const status=(page:Page)=>page.locator('.editor:not(.project-editor) .save-state');
async function publish(page:Page,a:AssetDocument){const draftId=randomUUID(),draft={documentType:'asset_draft',schemaVersion:1,draftId,assetId:a.assetId,assetKind:a.definition.kind,baseRevision:null,draftGeneration:1,updatedAt:new Date().toISOString(),candidate:a};let response=await page.request.post('/api/v1/drafts',{data:{requestId:randomUUID(),draft}});expect(response.ok()).toBe(true);response=await page.request.post('/api/v1/commit',{data:{requestId:randomUUID(),draftId,draftGeneration:1,expectedRevision:null}});const body=await response.json() as {ok:boolean;data:unknown};expect(body.ok,JSON.stringify(body)).toBe(true);return CommitResponse.parse(body.data).asset;}
async function read(page:Page,id:string){const response=await page.request.get('/api/v1/asset?id='+encodeURIComponent(id));return AssetDocument.parse((await response.json() as {data:unknown}).data);}
async function newGraph(page:Page,kind:'module'|'model',name:string){await page.getByLabel('新资产类型',{exact:true}).selectOption(kind);await page.getByRole('button',{name:kind==='model'?'＋ 新建模型':'＋ 新建模块',exact:true}).click();await expect(status(page)).toContainText('草稿已保存');await expect(page.getByLabel('结构配置编辑器')).toBeVisible();await page.getByLabel('结构资产名称',{exact:true}).fill(name);}

test('the canvas inserts and replaces fixed modules, edits their internal graph, and updates both configurations',async({page})=>{
  const graph=GraphTemplate.parse({nodes:[],inputs:[],outputs:[],edges:[],dependencies:[],states:[],tensors:[],storages:[]});
  const module=(name:string,child:GraphTemplate['nodes'][number])=>AssetDocument.parse({
    documentType:'asset',schemaVersion:1,assetId:randomUUID(),revision:1,name,
    tags:[],parameters:[],sources:[],definition:{kind:'module',graph:{...graph,nodes:[child]}},
  });
  const internal=await publish(page,module('Canvas reusable leaf',opaqueNode(graph)));
  const wrapper=await publish(page,module('Canvas reusable wrapper',referencedNode(graph,internal)));
  const project=canvasEditProject();
  project.projectId=randomUUID();
  project.scenarios.push({...structuredClone(project.scenarios[0]!),scenarioId:'other',name:'另一配置'});
  const saved=async()=>ProjectDocument.parse((await (await page.request.get('/api/v1/project?id='+project.projectId)).json()).data);
  const saveState=page.locator('.studio-save');
  const openStructure=()=>page.getByRole('button',{name:'编辑结构',exact:true}).click();
  const apply=()=>page.getByRole('button',{name:'应用结构修改',exact:true}).click();
  await page.goto('/');
  await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({name:'canvas-edit.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
  await expect(page.locator('.model-studio')).toHaveAttribute('data-workspace-id',project.projectId);
  await expect(saveState).toContainText('修订 1');

  await page.locator('[data-node-id="b"]').press('Space');
  await openStructure();
  const box=page.getByLabel('结构配置编辑器',{exact:true});
  await expect(box.getByLabel('节点名称',{exact:true})).toHaveValue('Projection B');
  await box.getByLabel('插入模块或算子',{exact:true}).selectOption(wrapper.assetId);
  await box.getByRole('button',{name:'插入引用节点',exact:true}).click();
  await expect(box.getByLabel('节点名称',{exact:true})).toHaveValue(wrapper.name);
  await page.getByRole('button',{name:'推理配置',exact:true}).click();
  await openStructure();
  await expect(box.getByLabel('节点名称',{exact:true})).toHaveValue(wrapper.name);
  expect((await saved()).projectRevision).toBe(1);
  await apply();
  await expect(saveState).toContainText('修订 2');
  const afterInsert=await saved();
  expect(afterInsert.assetSnapshots).toEqual(expect.arrayContaining([...project.assetSnapshots,internal,wrapper]));
  expect(afterInsert.scenarios[0]!.model).toEqual(afterInsert.scenarios[1]!.model);

  const wrapperNode=page.locator('[data-node-id="module_1"]');
  await wrapperNode.press('Enter');
  await expect(page.getByLabel('模块路径')).toContainText('module_1');
  await openStructure();
  await box.getByRole('button',{name:'添加自定义节点',exact:true}).click();
  await box.getByLabel('节点名称',{exact:true}).fill('Local three-second step');
  await box.getByLabel('自定义节点固定秒',{exact:true}).fill('3');
  await apply();
  await expect(saveState).toContainText('修订 3');
  const afterEdit=await saved();
  for(const scenario of afterEdit.scenarios){
    const result=await analyzeScenario(scenario,afterEdit.assetSnapshots);
    expect(result.status,JSON.stringify(result)).toBe('available');
    if(result.status==='available')expect(result.result.total.seconds).toMatchObject({status:'available',quantity:{value:6}});
  }
  expect(await read(page,wrapper.assetId)).toEqual(wrapper);

  await page.getByLabel('模块路径').getByRole('button').first().click();
  await wrapperNode.press('Space');
  await openStructure();
  await box.getByLabel('插入模块或算子',{exact:true}).selectOption(internal.assetId);
  await box.getByRole('button',{name:'替换所选引用',exact:true}).click();
  await expect(box).toContainText(internal.assetId);
  await apply();
  await expect(saveState).toContainText('修订 4');
  await box.getByLabel('删除节点 module_1',{exact:true}).click();
  await page.getByRole('dialog',{name:'确认删除结构节点'}).getByRole('button',{name:'确认删除节点',exact:true}).click();
  await apply();
  await expect(saveState).toContainText('修订 5');
  await expect(wrapperNode).toHaveCount(0);
  await page.reload();
  await expect(saveState).toContainText('修订 5');
  const final=await saved();
  expect(final.scenarios[0]!.model).toEqual(final.scenarios[1]!.model);
  expect(final.assetSnapshots).toEqual(expect.arrayContaining(project.assetSnapshots));
});

test('table-created repeated modules bind parameters, persist and compute through a portable project and expandable hierarchy',async({page})=>{
  const suffix=randomUUID().slice(0,8),base=makeUpgradeProject().project,hardware=AssetDocument.parse({...base.assetSnapshots.find(a=>a.definition.kind==='hardware'),assetId:'table:hardware:'+suffix,name:'Table hardware '+suffix});await publish(page,hardware);await page.goto('/?legacy=1');await newGraph(page,'module','Table module '+suffix);const box=page.getByLabel('结构配置编辑器');await box.locator('.graph-parameters > summary').click();await box.getByRole('button',{name:'添加资产参数',exact:true}).click();await box.getByLabel('参数默认值 0',{exact:true}).fill('2');await box.getByRole('button',{name:'添加自定义节点',exact:true}).click();await box.getByLabel('节点名称',{exact:true}).fill('Repeated two seconds');await box.getByLabel('自定义节点固定秒',{exact:true}).fill('2');await box.getByLabel('重复节点',{exact:true}).check();await box.getByLabel('重复次数表达方式',{exact:true}).selectOption('symbol');await box.getByLabel('重复次数参数',{exact:true}).selectOption('P_1');await box.getByRole('button',{name:'添加自定义节点',exact:true}).click();await box.getByLabel('节点名称',{exact:true}).fill('Three-second tail');await box.getByLabel('自定义节点固定秒',{exact:true}).fill('3');await box.getByLabel('依赖起点',{exact:true}).selectOption('custom_1');await box.getByLabel('依赖终点',{exact:true}).selectOption('custom_2');await box.getByRole('button',{name:'添加依赖',exact:true}).click();await expect(status(page)).toContainText('已保存 · 修订');const module=AssetDocument.parse(JSON.parse(await editor(page).inputValue()) as unknown),savedModule=await read(page,module.assetId);
  await newGraph(page,'model','Table model '+suffix);await box.getByLabel('插入模块或算子',{exact:true}).selectOption(module.assetId);await box.getByRole('button',{name:'插入引用节点',exact:true}).click();await expect(box.getByLabel('节点参数 P_1数值',{exact:true})).toBeVisible();await box.getByLabel('节点参数 P_1数值',{exact:true}).fill('3');await expect(status(page)).toContainText('已保存 · 修订');const model=AssetDocument.parse(JSON.parse(await editor(page).inputValue()) as unknown),savedModel=await read(page,model.assetId);await page.reload();await page.locator('.asset-list').getByRole('button',{name:new RegExp('Table model '+suffix)}).click();await expect(box).toContainText('子定义 · Table module '+suffix);await expect(box.getByLabel('节点参数 P_1数值',{exact:true})).toHaveValue('3');
  await page.getByRole('button',{name:'◇ 项目与方案',exact:true}).click();await page.getByRole('button',{name:'＋ 新建项目',exact:true}).click();const save=page.locator('.project-editor .save-state');await expect(save).toContainText('已保存 · 修订 1');await page.getByLabel('新增方案模型',{exact:true}).selectOption(model.assetId);await page.getByLabel('新增方案硬件',{exact:true}).selectOption(hardware.assetId);await page.getByRole('button',{name:'添加方案',exact:true}).click();await expect(save).toContainText('已保存 · 修订 2');await page.getByRole('button',{name:'计算理论结果',exact:true}).click();await expect(page.locator('.analysis-cards')).toContainText('9 s');await page.getByRole('button',{name:'展开模型结构',exact:true}).click();await page.locator('.structure-containers > summary').click();const tree=page.getByLabel('模型包含层级树');await expect(tree).toContainText('4 个叶节点');await tree.locator('.structure-tree-branch > div > .structure-tree-branch > summary').first().click();await expect(tree).toContainText('custom_1');await page.locator('.structure-panel').screenshot({path:'test-results/table-model-hierarchy.png'});
  const library=[savedModel,savedModule,hardware],s={...base.scenarios[0]!,model:{assetId:model.assetId,revision:savedModel.revision,kind:'model' as const},bindings:[],deviceTopology:{devices:[{deviceId:base.scenarios[0]!.deviceTopology.devices[0]!.deviceId,hardware:{assetId:hardware.assetId,revision:1,kind:'hardware' as const}}],groups:base.scenarios[0]!.deviceTopology.groups}};const portable=ProjectDocument.parse({...base,projectId:'table:portable:'+suffix,scenarios:[s],assetSnapshots:library}),result=await analyzeScenario(portable.scenarios[0]!,portable.assetSnapshots);expect(result.status,JSON.stringify(result)).toBe('available');if(result.status!=='available')throw Error();expect(result.result.total.seconds).toMatchObject({status:'available',quantity:{value:9}});
});

test('cyclic dependencies and empty labels autosave only as recoverable drafts, then repair and delete incident links',async({page})=>{
  const suffix=randomUUID().slice(0,8);await page.goto('/?legacy=1');await newGraph(page,'module','Cycle table '+suffix);const box=page.getByLabel('结构配置编辑器');await box.getByRole('button',{name:'添加自定义节点',exact:true}).click();await box.getByRole('button',{name:'添加自定义节点',exact:true}).click();await box.getByLabel('依赖起点',{exact:true}).selectOption('custom_1');await box.getByLabel('依赖终点',{exact:true}).selectOption('custom_2');await box.getByRole('button',{name:'添加依赖',exact:true}).click();await expect(status(page)).toContainText('已保存 · 修订');const original=AssetDocument.parse(JSON.parse(await editor(page).inputValue()) as unknown),formal=await read(page,original.assetId);await box.getByLabel('依赖起点',{exact:true}).selectOption('custom_2');await box.getByLabel('依赖终点',{exact:true}).selectOption('custom_1');await box.getByLabel('新增依赖类型',{exact:true}).selectOption('synchronization');await box.getByRole('button',{name:'添加依赖',exact:true}).click();await expect(status(page)).toContainText('草稿已保存');await expect(box.locator('.graph-diagnostics')).toContainText('dependency_cycle');expect((await read(page,original.assetId)).revision).toBe(formal.revision);await box.getByLabel('结构资产名称',{exact:true}).fill('');await expect(status(page)).toContainText('草稿已保存');await expect(box).toBeVisible();await page.reload();await page.locator('.draft-section button').filter({hasText:original.assetId.slice(0,12)}).click();await expect(box.getByLabel('结构资产名称',{exact:true})).toHaveValue('');await expect(box.locator('.graph-diagnostics')).toContainText('dependency_cycle');await box.getByLabel('结构资产名称',{exact:true}).fill('Cycle table '+suffix);await box.getByLabel('删除依赖 dependency_2',{exact:true}).click();await expect(status(page)).toContainText('已保存 · 修订');await box.getByLabel('删除节点 custom_1',{exact:true}).click();const dialog=page.getByRole('dialog',{name:'确认删除结构节点'});await expect(dialog).toContainText('1 条控制/同步依赖');await dialog.getByRole('button',{name:'确认删除节点',exact:true}).click();await expect(status(page)).toContainText('已保存 · 修订');const repaired=await read(page,original.assetId);if(repaired.definition.kind!=='module')throw Error();expect(repaired.definition.graph.nodes.map(n=>n.nodeId)).toEqual(['custom_2']);expect(repaired.definition.graph.dependencies).toEqual([]);await box.screenshot({path:'test-results/table-graph-editor.png'});
});

test('tensor connections and port mappings retain shared objects, and builtin edits create a user copy',async({page})=>{
  const suffix=randomUUID().slice(0,8),graph={inputs:[],outputs:[],edges:[],dependencies:[],states:[],storages:[{storageId:'backing',name:'Shared backing',category:'activation',sharingDomain:'instance',allocation:{kind:'bytes',value:{kind:'literal',quantity:{value:8,unit:'byte'}}}}],tensors:[{tensorId:'T',name:'T',shape:[{axisId:'x',semantic:'custom',size:{kind:'literal',quantity:{value:4,unit:'count'}}}],dtype:{category:'float',bits:16,format:'BF16'},storageId:'backing'}],nodes:['source','consumer'].map((id,i)=>({nodeId:id,name:id,phases:['prefill','decode'],portBindings:[{portId:i?'in':'out',tensorId:'T'}],stateBindings:[],body:{kind:'opaque',inputs:i?[{portId:'in',tensorId:'T'}]:[],outputs:i?[]:[{portId:'out',tensorId:'T'}],cost:{compute:[],memoryAccess:[],temporaryStorageIds:[],timing:{kind:'fixed',seconds:1,description:'One second'}}}}))},asset=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'table:data:'+suffix,revision:1,name:'Data table '+suffix,tags:[],sources:[],parameters:[],definition:{kind:'module',graph}});await publish(page,asset);await page.goto('/?legacy=1');await page.locator('.asset-list').getByRole('button',{name:new RegExp(asset.name)}).click();const box=page.getByLabel('结构配置编辑器');await box.locator('.graph-links > summary').filter({hasText:'张量数据连接'}).click();await box.getByLabel('数据起点端口',{exact:true}).selectOption(JSON.stringify({kind:'node',nodeId:'source',portId:'out'}));await box.getByLabel('数据终点端口',{exact:true}).selectOption(JSON.stringify({kind:'node',nodeId:'consumer',portId:'in'}));await box.getByLabel('数据连接张量',{exact:true}).selectOption('T');await box.getByRole('button',{name:'添加数据边',exact:true}).click();await expect(status(page)).toContainText('已保存 · 修订 2');await box.getByLabel('删除节点 source',{exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'确认删除节点',exact:true}).click();await expect(status(page)).toContainText('已保存 · 修订 3');const after=await read(page,asset.assetId);if(after.definition.kind!=='module')throw Error();expect(after.definition.graph.edges).toEqual([]);expect(after.definition.graph.storages).toHaveLength(1);expect(after.definition.graph.tensors).toHaveLength(1);
  const scan=await page.request.get('/api/v1/assets'),all=await scan.json() as {data:{assetId:string;name:string;origin:string;kind:string}[]},builtin=all.data.find(a=>a.origin==='builtin'&&a.kind==='model')!;const before=await read(page,builtin.assetId);await page.locator('.asset-list').getByRole('button',{name:new RegExp(builtin.name)}).click();await box.getByLabel('结构资产名称',{exact:true}).fill('Builtin structure copy '+suffix);await expect(status(page)).toContainText('已保存 · 修订 1');const copy=AssetDocument.parse(JSON.parse(await editor(page).inputValue()) as unknown);expect(copy.assetId).not.toBe(before.assetId);expect(await read(page,builtin.assetId)).toEqual(before);
});

test('repeat formulas keep fixed revisions, reject a wrong unit and compute edited bindings',async({page})=>{
  const suffix=randomUUID().slice(0,8),base=makeUpgradeProject().project,formula=(unit:'operation'|'count')=>AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'table:'+unit+':'+suffix,revision:1,name:'Repeat '+unit+' '+suffix,tags:[],parameters:[],sources:[],definition:{kind:'formula',formula:{inputs:{x:{unit:'count',integerRequired:true,min:1}},expression:'2 * x',output:{unit,integerRequired:true,nonNegative:true},description:'Synthetic two times x'}}}),wrong=formula('operation'),count=formula('count');await publish(page,wrong);await publish(page,count);await page.goto('/?legacy=1');await newGraph(page,'model','Formula repeat '+suffix);const box=page.getByLabel('结构配置编辑器');await box.getByRole('button',{name:'添加自定义节点',exact:true}).click();await box.getByLabel('重复节点',{exact:true}).check();await box.getByLabel('重复次数表达方式',{exact:true}).selectOption('formula');await box.getByLabel('重复次数公式',{exact:true}).selectOption(wrong.assetId);await expect(box.getByRole('alert')).toContainText('输出单位需要 count');let release=()=>{},arrived=()=>{};const paused=new Promise<void>(resolve=>{release=resolve;}),requested=new Promise<void>(resolve=>{arrived=resolve;});await page.route('**/api/v1/asset?**',async route=>{if(new URL(route.request().url()).searchParams.get('id')!==count.assetId){await route.continue();return;}const response=await route.fetch();arrived();await paused;await route.fulfill({response});});await box.getByLabel('重复次数公式',{exact:true}).selectOption(count.assetId);await requested;try{await box.getByLabel('节点名称',{exact:true}).fill('Edited while formula was loading');}finally{release();}await expect(box.getByLabel('重复次数.x数值',{exact:true})).toBeVisible();await expect(box.getByLabel('节点名称',{exact:true})).toHaveValue('Edited while formula was loading');await box.getByLabel('重复次数.x数值',{exact:true}).fill('3');await expect(status(page)).toContainText('已保存 · 修订');const candidate=AssetDocument.parse(JSON.parse(await editor(page).inputValue()) as unknown),saved=await read(page,candidate.assetId),scenario={...base.scenarios[0]!,model:{assetId:saved.assetId,revision:saved.revision,kind:'model' as const},bindings:[]},result=await analyzeScenario(scenario,[saved,count,...base.assetSnapshots.filter(a=>a.definition.kind==='hardware')]);expect(result.status,JSON.stringify(result)).toBe('available');if(result.status!=='available')throw Error();expect(result.result.total.seconds).toMatchObject({status:'available',quantity:{value:6}});await page.reload();await page.locator('.asset-list').getByRole('button',{name:new RegExp(candidate.name)}).click();await expect(box.getByLabel('重复次数.x数值',{exact:true})).toHaveValue('3');await expect(box).toContainText('当前固定 r1');await page.unrouteAll({behavior:'wait'});
});
