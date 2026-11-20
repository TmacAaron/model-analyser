import { test,expect } from '@playwright/test';
import { readFile,writeFile } from 'node:fs/promises';
import { randomUUID,createHash } from 'node:crypto';
import { ProjectDocument,AnalysisResult } from '@model-analyser/contracts';

test.setTimeout(180000);
test.use({viewport:{width:1440,height:1100}});

test('the actual maximum connected canvas fits, pans, edits and computes in a worker while preserving its fixed mathematical hash',async({page,browser})=>{
  const path='examples/runtime-baseline/synthetic-chain-9999.json',raw=await readFile(path,'utf8'),p=ProjectDocument.parse(JSON.parse(raw));p.projectId=randomUUID();await page.goto('/');await expect(page.locator('.canvas-node.module').first()).toBeVisible();
  await page.evaluate(()=>{const state={running:true,gaps:[] as number[],longTasks:[] as number[],supported:false};const w=window as typeof window&{runtimeObservation?:{state:typeof state;stop:()=>void}};let previous=performance.now();function frame(now:number){if(!state.running)return;state.gaps.push(now-previous);previous=now;requestAnimationFrame(frame);}let observer:PerformanceObserver|undefined;try{observer=new PerformanceObserver(list=>state.longTasks.push(...list.getEntries().map(e=>e.duration)));observer.observe({entryTypes:['longtask']});state.supported=true;}catch{/* Record unavailable instrumentation without substituting a zero peak. */}w.runtimeObservation={state,stop:()=>{state.running=false;observer?.disconnect();}};requestAnimationFrame(frame);});
  const start=await page.evaluate(()=>performance.now());
  await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({name:'maximum-chain.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(p))});
  await expect(page.getByLabel('当前模型',{exact:true})).toHaveValue(p.scenarios[0]!.model.assetId);
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
  await expect(page.locator('.canvas-node.module')).toHaveCount(1);
  await page.locator('.canvas-node.module').click();
  await page.getByLabel('跨调用选择算子',{exact:true}).check();
  const canvas=page.locator('.canvas-surface'),surface=canvas.locator(':scope > g');
  await expect(canvas).toHaveAttribute('data-node-count','10001');
  await expect(canvas).toHaveAttribute('data-edge-count','10000');
  await expect(canvas).toHaveAttribute('data-render-mode','detail');
  await expect(canvas.locator('[data-node-id="leaves[0]"]')).toBeVisible();
  const detailedNodes=await canvas.locator('.canvas-node').count(),detailedEdges=await canvas.locator('.canvas-edge').count();
  expect(detailedNodes).toBeGreaterThan(1);
  expect(detailedNodes).toBeLessThan(32);
  expect(detailedEdges).toBeGreaterThan(0);
  expect(detailedEdges).toBeLessThan(32);
  const expandedAt=await page.evaluate(()=>performance.now());
  await page.getByRole('button',{name:'适配全图',exact:true}).click();
  await expect(canvas).toHaveAttribute('data-render-mode','overview');
  const overview=canvas.locator('canvas');
  await expect(overview).toHaveAttribute('data-painted-nodes','10001');
  await expect(overview).toHaveAttribute('data-painted-edges','10000');
  await expect(canvas.locator('.canvas-node, .canvas-edge')).toHaveCount(0);
  const ink=await overview.evaluate((el:HTMLCanvasElement)=>{
    const ctx=el.getContext('2d');
    if(!ctx)throw Error('No overview drawing context');
    const {width,height}=el,scale=window.devicePixelRatio;
    const pixels=ctx.getImageData(0,0,width,height).data;
    let top=height,bottom=-1;
    for(let offset=3;offset<pixels.length;offset+=4){
      if(!pixels[offset])continue;
      const y=Math.floor(offset/(width*4));
      top=Math.min(top,y);bottom=Math.max(bottom,y);
    }
    const svg=el.closest('svg'),toolbar=el.closest('.model-canvas')?.querySelector('.canvas-tools');
    if(!toolbar||!svg)throw Error('Missing canvas or its toolbar');
    return {
      top:top/scale,bottom:bottom/scale,height:height/scale,
      toolbarBottom:toolbar.getBoundingClientRect().bottom-svg.getBoundingClientRect().top,
      transform:svg.querySelector(':scope > g')?.getAttribute('transform'),
    };
  });
  expect(ink.top,JSON.stringify(ink)).toBeGreaterThanOrEqual(ink.toolbarBottom+7);
  expect(ink.top,JSON.stringify(ink)).toBeLessThanOrEqual(ink.toolbarBottom+12);
  expect(ink.bottom,JSON.stringify(ink)).toBeGreaterThanOrEqual(ink.height-52);
  expect(ink.bottom,JSON.stringify(ink)).toBeLessThanOrEqual(ink.height-48);
  const bounds=await canvas.boundingBox();
  if(!bounds)throw Error('Missing canvas bounds');
  await writeFile('test-results/runtime-canvas-fit.json',JSON.stringify({
    inputPath:path,inputSha256:createHash('sha256').update(raw).digest('hex'),importThroughExpandedDOMMilliseconds:expandedAt-start,
    operators:9999,canvasNodes:10001,edges:10000,bounds,detailedNodes,detailedEdges,overviewInk:ink,
  },null,2));
  await page.screenshot({path:'test-results/runtime-maximum-canvas.png'});
  const old=await surface.getAttribute('transform');
  await page.mouse.move(bounds.x+bounds.width-20,bounds.y+bounds.height-30);
  await page.mouse.down({button:'middle'});
  await page.mouse.move(bounds.x+bounds.width-60,bounds.y+bounds.height-60,{steps:4});
  await page.mouse.up({button:'middle'});
  await expect(surface).not.toHaveAttribute('transform',old!);
  await page.getByRole('button',{name:'放大画布',exact:true}).click();
  await page.getByRole('button',{name:'适配全图',exact:true}).click();

  async function locate(id:string){
    await page.getByRole('button',{name:'查找节点',exact:true}).click();
    await page.getByLabel('查找画布节点',{exact:true}).fill(id);
    await page.getByRole('button',{name:'定位 '+id,exact:true}).click();
    await expect(canvas).toHaveAttribute('data-render-mode','detail');
    const target=canvas.locator('[data-node-id="'+id+'"]');
    await expect(target).toBeFocused();
    return target;
  }
  await locate('leaves[9998]');
  await expect(canvas.locator('[data-node-id="leaves[0]"]')).toHaveCount(0);
  await expect(canvas.getByRole('img',{name:/leaves\[9997\] → leaves\[9998\]/})).toBeAttached();
  const selected=await locate('leaves[0]');
  const first=await selected.boundingBox(),second=await canvas.locator('[data-node-id="leaves[1]"]').boundingBox();
  if(!first||!second)throw Error('Missing node bounds');
  await page.getByRole('button',{name:'框选算子',exact:true}).click();
  await page.mouse.move(first.x-12,first.y+12);
  await page.mouse.down();
  await page.mouse.move(second.x+second.width+12,second.y+second.height-12,{steps:4});
  await page.mouse.up();
  await expect(page.locator('.canvas-hint')).toContainText('已选 2 个节点');
  await expect(canvas.locator('.canvas-node.selected')).toHaveCount(2);
  await page.getByRole('button',{name:'移动画布',exact:true}).click();
  await selected.press('Space');
  await page.getByRole('button',{name:'定位选中节点',exact:true}).click();const initialPosition=/translate\(([-\d.]+),([-\d.]+)\)/.exec((await selected.getAttribute('transform'))??''),initialZoom=/scale\(([^)]+)\)/.exec((await surface.getAttribute('transform'))??'');if(!initialPosition||!initialZoom)throw Error('Missing actual canvas transform');const rect=await selected.boundingBox();if(!rect)throw Error();await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down();await page.mouse.move(rect.x+rect.width/2+35,rect.y+rect.height/2+20,{steps:4});await page.mouse.up();await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');await page.getByRole('button',{name:'分析此配置 ↗',exact:true}).click();await expect(page.getByRole('button',{name:'取消理论分析',exact:true})).toBeVisible();await page.getByRole('button',{name:'显示单位设置',exact:true}).click();await expect(page.getByLabel('时间显示单位',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'取消理论分析',exact:true})).toBeVisible();await page.getByRole('button',{name:'显示单位设置',exact:true}).click();await expect(page.locator('.analysis-cards')).toBeVisible();const waiting=page.waitForEvent('download');await page.getByRole('button',{name:'导出结果 JSON',exact:true}).click();const download=await waiting;await download.saveAs('test-results/runtime-chain-analysis.json');const result=AnalysisResult.parse(JSON.parse(await readFile('test-results/runtime-chain-analysis.json','utf8')));expect(result.nodes).toHaveLength(9999);expect(result.total.seconds).toMatchObject({status:'available',quantity:{value:expect.closeTo(.009999,12)}});expect(result.total.hbmBytes).toMatchObject({status:'available',quantity:{value:159984}});const baseline=JSON.parse(await readFile('examples/runtime-baseline/observations.json','utf8')) as {results:{case:string;operation:string;summary:{inputHash:string}}[]};expect(result.inputHash).toBe(baseline.results.find(r=>r.case==='synthetic-chain-9999'&&r.operation==='analyze')?.summary.inputHash);const portableWait=page.waitForEvent('download');await page.getByRole('button',{name:'导出',exact:true}).click();const portableFile=await portableWait;await portableFile.saveAs('test-results/runtime-chain-project.json');const portable=ProjectDocument.parse(JSON.parse(await readFile('test-results/runtime-chain-project.json','utf8'))),moved=portable.viewState.nodes.find(n=>n.nodeId==='leaves[0]');expect(moved).toBeDefined();expect(moved?.x).toBeCloseTo(Number(initialPosition[1])+35/Number(initialZoom[1]),2);expect(moved?.y).toBeCloseTo(Number(initialPosition[2])+20/Number(initialZoom[1]),2);await page.screenshot({path:'test-results/runtime-maximum-analysis.png'});const observation=await page.evaluate(()=>{const v=(window as typeof window&{runtimeObservation:{state:{gaps:number[];longTasks:number[];supported:boolean};stop:()=>void}}).runtimeObservation;v.stop();return {frames:v.state.gaps.length,maxAnimationFrameGapMilliseconds:Math.max(...v.state.gaps),longTaskObserverSupported:v.state.supported,longTaskCount:v.state.longTasks.length,maxLongTaskMilliseconds:v.state.longTasks.length?Math.max(...v.state.longTasks):null};});await writeFile('test-results/runtime-browser-observations.json',JSON.stringify({scope:'One observed Chrome flow on a shared desktop; includes startup, DOM/SVG and automation effects, not a frame SLA or pure software operation timing',inputPath:path,browserVersion:browser.version(),...observation},null,2));
});

test('canceling model expansion keeps configuration controls available and explicit retry restores the exact graph',async({page})=>{
  await page.goto('/');await expect(page.locator('.canvas-node.module').first()).toBeVisible();let release=()=>{},arrived=()=>{},heldOnce=false;const held=new Promise<void>(done=>{release=done;}),seen=new Promise<void>(done=>{arrived=done;});await page.route('**/assets/model-instantiation-worker-*.js',async route=>{if(!heldOnce){heldOnce=true;arrived();await held;}await route.continue().catch(()=>undefined);});
  try{const p=ProjectDocument.parse(JSON.parse(await readFile('examples/runtime-baseline/synthetic-chain-9999.json','utf8')));p.projectId=randomUUID();await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({name:'cancel-expansion.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(p))});await seen;await expect(page.getByRole('button',{name:'取消展开',exact:true})).toBeVisible();await expect(page.getByLabel('当前模型',{exact:true})).toBeEnabled();await page.getByRole('button',{name:'取消展开',exact:true}).click();await expect(page.getByRole('heading',{name:'模型展开已取消',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'分析此配置 ↗',exact:true})).toBeEnabled();await page.getByRole('button',{name:'重新展开模型',exact:true}).click();release();await page.unrouteAll({behavior:'wait'});await expect(page.locator('.canvas-node.module')).toHaveCount(1);await expect(page.locator('.canvas-status')).toContainText('9999 算子');await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');}finally{release();await page.unrouteAll({behavior:'wait'});}
});

test('a delayed old structure job cannot replace a different model selected while it is pending',async({page})=>{
  await page.goto('/');await expect(page.locator('.canvas-node.module').first()).toBeVisible();let release=()=>{},arrived=()=>{},heldOnce=false;const held=new Promise<void>(done=>{release=done;}),seen=new Promise<void>(done=>{arrived=done;});await page.route('**/assets/model-instantiation-worker-*.js',async route=>{if(!heldOnce){heldOnce=true;arrived();await held;}await route.continue().catch(()=>undefined);});
  try{const p=ProjectDocument.parse(JSON.parse(await readFile('examples/runtime-baseline/synthetic-chain-9999.json','utf8')));p.projectId=randomUUID();await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({name:'late-expansion.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(p))});await seen;await expect(page.getByRole('button',{name:'取消展开',exact:true})).toBeVisible();await page.getByLabel('当前模型',{exact:true}).selectOption('builtin:model:communication-study');await expect(page.locator('.canvas-status')).toBeVisible();await expect(page.locator('.canvas-status')).not.toContainText('9999 算子');release();await page.unrouteAll({behavior:'wait'});await expect(page.getByLabel('当前模型',{exact:true})).toHaveValue('builtin:model:communication-study');await expect(page.locator('.canvas-node')).not.toHaveCount(0);await expect(page.locator('[data-node-id="leaves"]')).toHaveCount(0);await expect(page.getByRole('heading',{name:'模型展开已取消',exact:true})).toHaveCount(0);}finally{release();await page.unrouteAll({behavior:'wait'});}
});

test('pending memory and quantization editors await the shared structure and retain independent input through cancel and retry',async({page})=>{
  await page.goto('/');await expect(page.locator('.canvas-node.module').first()).toBeVisible();let release=()=>{},arrived=()=>{},heldOnce=false;const held=new Promise<void>(done=>{release=done;}),seen=new Promise<void>(done=>{arrived=done;});await page.route('**/assets/model-instantiation-worker-*.js',async route=>{if(!heldOnce){heldOnce=true;arrived();await held;}await route.continue().catch(()=>undefined);});
  try{
    const p=ProjectDocument.parse(JSON.parse(await readFile('examples/runtime-baseline/synthetic-chain-9999.json','utf8')));p.projectId=randomUUID();await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({name:'pending-editors.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(p))});await seen;
    await expect(page.locator('.model-studio')).toHaveAttribute('data-workspace-id',p.projectId);
    await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
    await page.getByRole('button',{name:'量化',exact:true}).click();const quantization=page.locator('.ascend-import-editor');await expect(quantization).toContainText('模型结构就绪后可查看精确存储目标');await quantization.getByLabel('导入Ascend描述JSON',{exact:true}).setInputFiles({name:'pending-source.json',mimeType:'application/json',buffer:Buffer.from('{"unknown.weight":"FLOAT"}')});await expect(quantization.locator('.ascend-source-summary')).toContainText('1 个源条目');await expect(quantization.getByRole('button',{name:'确认映射并应用量化',exact:true})).toBeDisabled();await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');
    await page.getByRole('button',{name:'显存假设',exact:true}).click();const memory=page.locator('.module-peak-editor');await expect(memory).toContainText('模型结构就绪后可选择模块范围');await memory.getByLabel('模块私有峰值 byte',{exact:true}).fill('123');await memory.getByLabel('模块峰值来源',{exact:true}).fill('Unfinished budget preserved while structure is pending');await expect(memory.getByRole('button',{name:'添加模块峰值覆盖',exact:true})).toBeDisabled();await page.getByRole('button',{name:'取消展开',exact:true}).click();await expect(page.getByRole('heading',{name:'模型展开已取消',exact:true})).toBeVisible();await expect(memory.getByLabel('模块私有峰值 byte',{exact:true})).toHaveValue('123');await expect(page.getByLabel('当前模型',{exact:true})).toBeEnabled();await page.getByRole('button',{name:'重新展开模型',exact:true}).click();release();await page.unrouteAll({behavior:'wait'});await expect(page.locator('.canvas-status')).toContainText('9999 算子');await expect(memory).not.toContainText('模型结构就绪后可选择模块范围');await expect(memory.getByLabel('模块私有峰值 byte',{exact:true})).toHaveValue('123');await expect(memory.getByLabel('模块峰值来源',{exact:true})).toHaveValue('Unfinished budget preserved while structure is pending');await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 2');
    const waiting=page.waitForEvent('download');await page.getByRole('button',{name:'导出',exact:true}).click();const file=await waiting;await file.saveAs('test-results/runtime-pending-editors.json');const saved=ProjectDocument.parse(JSON.parse(await readFile('test-results/runtime-pending-editors.json','utf8')));expect(saved.quantizationSources?.[0]?.text).toBe('{"unknown.weight":"FLOAT"}');expect(saved.scenarios[0]?.quantizationOverrides).toEqual([]);expect(saved.scenarios[0]?.modulePeakOverrides??[]).toEqual([]);
  }finally{release();await page.unrouteAll({behavior:'wait'});}
});
