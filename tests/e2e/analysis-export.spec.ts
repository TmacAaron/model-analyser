import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {expect,test,type Page} from '@playwright/test';
import {AnalysisResult,ProjectDocument} from '@model-analyser/contracts';
import {c01Project} from '../model-fixtures.js';

type ExportProbe={held:Array<()=>void>;started:number};
type ResultProbe={mode:'wrong-hash'|'malformed'|'hold'|'normal';held:Array<()=>void>};

async function openWorkspace(page:Page,project:ProjectDocument){
  project.projectId=randomUUID();
  await page.goto('/');
  await page.getByLabel('导入模型工作区',{exact:true}).setInputFiles({name:'analysis-export.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
  await expect(page.locator('.model-studio')).toHaveAttribute('data-workspace-id',project.projectId);
  await expect(page.locator('.studio-save')).toContainText('已保存 · 修订 1');
}

async function open(page:Page,project:ProjectDocument){
  await openWorkspace(page,project);
  await page.getByRole('button',{name:'分析此配置 ↗',exact:true}).click();
  await expect(page.locator('.analysis-cards')).toBeVisible({timeout:45000});
}

test('exports the complete maximum-size model with its original input and numeric values',async({page,browser})=>{
  test.setTimeout(120000);
  await page.addInitScript(()=>{
    const OriginalWorker=window.Worker;
    const parse=JSON.parse,decode=TextDecoder.prototype.decode;
    JSON.parse=function(...args:Parameters<typeof JSON.parse>){
      const start=performance.now(),value=parse(...args);
      if(typeof args[0]==='string'&&args[0].length>1000000)document.documentElement.dataset.analysisLastLargeParseMs=String(performance.now()-start);
      return value;
    };
    TextDecoder.prototype.decode=function(...args:Parameters<TextDecoder['decode']>){
      const start=performance.now(),value=decode.apply(this,args);
      if(args[0]&&args[0].byteLength>1000000)document.documentElement.dataset.analysisLastLargeDecodeMs=String(performance.now()-start);
      return value;
    };
    window.Worker=class extends OriginalWorker{
      constructor(url:string|URL,options?:WorkerOptions){
        super(url,options);
        if(!String(url).includes('analysis-worker-'))return;
        this.addEventListener('message',event=>{
          const start=performance.now(),attempt=event.data?.attempt??event.data;
          const transferredBytes=event.data?.payload instanceof ArrayBuffer?event.data.payload.byteLength:0;
          if(!transferredBytes&&(attempt?.status!=='available'||!Array.isArray(attempt.result?.nodes)))return;
          requestAnimationFrame(()=>requestAnimationFrame(()=>{
            const now=performance.now(),data=document.documentElement.dataset;
            data.analysisResultTwoFrameMs=String(now-start);
            data.analysisClickThroughResultMs=String(now-Number(data.analysisStart));
            data.analysisTransferBytes=String(transferredBytes);
          }));
        });
      }
    };
  });
  const raw=await readFile('examples/runtime-baseline/synthetic-chain-9999.json','utf8');
  await openWorkspace(page,ProjectDocument.parse(JSON.parse(raw)));
  const analyze=page.getByRole('button',{name:'分析此配置 ↗',exact:true});
  await analyze.evaluate(el=>el.addEventListener('click',()=>{
    document.documentElement.dataset.analysisStart=String(performance.now());
  },{once:true}));
  await analyze.click();
  await expect(page.locator('.analysis-cards')).toBeVisible({timeout:45000});
  const measurementOptions=await page.getByLabel('测量目标',{exact:true}).locator('option').count();
  const rooflineOptions=await page.getByLabel('Roofline范围',{exact:true}).locator('option').count();
  const button=page.getByRole('button',{name:'导出结果 JSON',exact:true});
  await button.evaluate(el=>el.addEventListener('click',()=>{
    const start=performance.now();
    requestAnimationFrame(()=>requestAnimationFrame(()=>el.setAttribute('data-export-two-frame-ms',String(performance.now()-start))));
  },{once:true}));
  const download=page.waitForEvent('download');
  await button.click();
  const file=await download,path=await file.path();
  if(!path)throw Error('Missing analysis download');
  const bytes=await readFile(path),result=AnalysisResult.parse(JSON.parse(bytes.toString('utf8')));
  expect(file.suggestedFilename()).toBe('model-analyser-result.json');
  expect(result.nodes).toHaveLength(9999);
  expect(result.total.seconds).toMatchObject({quantity:{value:expect.closeTo(.009999,12),unit:'second'}});
  expect(result.total.hbmBytes).toMatchObject({quantity:{value:159984,unit:'byte'}});
  const baseline=JSON.parse(await readFile('examples/runtime-baseline/observations.json','utf8')) as {results:{case:string;operation:string;summary:{inputHash:string}}[]};
  expect(result.inputHash).toBe(baseline.results.find(r=>r.case==='synthetic-chain-9999'&&r.operation==='analyze')?.summary.inputHash);
  const afterTwoFrames=Number(await button.getAttribute('data-export-two-frame-ms'));
  expect(afterTwoFrames).toBeGreaterThan(0);
  const resultToTwoFrames=Number(await page.locator('html').getAttribute('data-analysis-result-two-frame-ms'));
  const analyzeToTwoFrames=Number(await page.locator('html').getAttribute('data-analysis-click-through-result-ms'));
  const transferredBytes=Number(await page.locator('html').getAttribute('data-analysis-transfer-bytes'));
  const largeDecode=Number(await page.locator('html').getAttribute('data-analysis-last-large-decode-ms'));
  const largeParse=Number(await page.locator('html').getAttribute('data-analysis-last-large-parse-ms'));
  expect(transferredBytes).toBeGreaterThan(0);
  expect(resultToTwoFrames).toBeGreaterThan(0);
  expect(analyzeToTwoFrames).toBeGreaterThan(resultToTwoFrames);
  await writeFile('test-results/analysis-export-observation.json',JSON.stringify({chrome:browser.version(),bytes:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex'),transferredBytes,analysisThroughResultTwoFramesMilliseconds:analyzeToTwoFrames,
    resultToTwoAnimationFramesMilliseconds:resultToTwoFrames,clickToTwoAnimationFramesMilliseconds:afterTwoFrames,
    largeDecodeMilliseconds:largeDecode,largeParseMilliseconds:largeParse,measurementOptions,rooflineOptions},null,2));

  expect(measurementOptions).toBeLessThanOrEqual(101);
  expect(rooflineOptions).toBeLessThanOrEqual(101);
  for(const [label,searchLabel] of [['测量目标','查找测量目标'],['Roofline范围','查找 Roofline 范围']] as const){
    const select=page.getByLabel(label,{exact:true}),search=page.getByLabel(searchLabel,{exact:true});
    const lastTarget='node:leaves[9998]',lastOption=select.locator(`option[value="${lastTarget}"]`);
    await expect(lastOption).toHaveCount(0);
    await search.fill('leaves[9998]');
    await expect(lastOption).toHaveCount(1);
    await select.selectOption(lastTarget);
    await search.fill('no-matching-target');
    await expect(search.locator('..').getByRole('status')).toHaveText('没有匹配的范围');
    await expect(select).toHaveValue(lastTarget);
    await expect(select.locator('option')).toHaveCount(1);
  }
  await expect(page.getByRole('button',{name:'记录并绑定当前输入',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'计算 Roofline 拐点',exact:true})).toBeEnabled();
});

test('cancel and configuration changes discard stale exports and retry reuses the current result',async({page})=>{
  await page.addInitScript(()=>{
    const OriginalWorker=window.Worker,probe:ExportProbe={held:[],started:0};
    Object.assign(window,{analysisExportProbe:probe});
    window.Worker=class extends OriginalWorker{
      constructor(url:string|URL,options?:WorkerOptions){
        super(url,options);
        if(!String(url).includes('analysis-worker-'))return;
        probe.started++;
        this.addEventListener('message',event=>{
          if(event.data?.kind!=='exported')return;
          event.stopImmediatePropagation();
          probe.held.push(()=>this.onmessage?.call(this,event));
        });
      }
    };
  });
  const project=c01Project(),base=project.scenarios[0];
  if(!base)throw Error('Missing test configuration');
  project.scenarios.push({...base,scenarioId:base.scenarioId+':export-other',name:'另一个导出配置',workload:{...base.workload,batchSize:base.workload.batchSize+1}});
  await open(page,project);
  const probe=()=>page.evaluate(()=>{
    const state=(window as Window&{analysisExportProbe?:ExportProbe}).analysisExportProbe;
    if(!state)throw Error('Missing analysis export observer');
    const {held,started}=state;
    return {held:held.length,started};
  });
  const release=()=>page.evaluate(()=>{(window as Window&{analysisExportProbe?:ExportProbe}).analysisExportProbe?.held.shift()?.();});
  const button=page.getByRole('button',{name:'导出结果 JSON',exact:true});
  const cancel=page.getByRole('button',{name:'取消结果导出',exact:true});
  const downloads:string[]=[];
  page.on('download',file=>downloads.push(file.suggestedFilename()));
  await button.click();
  await expect.poll(probe).toEqual({held:1,started:1});
  await page.getByRole('button',{name:'显示单位设置',exact:true}).click();
  await expect(page.getByLabel('时间显示单位',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'关闭显示单位设置',exact:true}).click();
  await cancel.click();
  await expect(page.getByText('已取消结果导出。',{exact:true})).toBeVisible();
  await expect(page.locator('.analysis-cards')).toBeVisible();
  await page.getByRole('button',{name:'重试结果导出',exact:true}).click();
  await expect.poll(probe).toEqual({held:2,started:1});
  await release();
  await expect(cancel).toBeVisible();
  expect(downloads).toHaveLength(0);
  const retry=page.waitForEvent('download');
  await release();
  const path=await(await retry).path();
  if(!path)throw Error('Missing retried analysis export');
  expect(AnalysisResult.parse(JSON.parse(await readFile(path,'utf8'))).scenarioId).toBe(base.scenarioId);

  await button.click();
  await expect.poll(probe).toEqual({held:1,started:1});
  await page.getByRole('tab',{name:/另一个导出配置/}).click();
  await expect(cancel).toHaveCount(0);
  await release();
  expect(downloads).toHaveLength(1);
  await expect(page.locator('.analysis-cards')).toBeVisible();
  await button.click();
  await expect.poll(probe).toEqual({held:1,started:2});
  const second=page.waitForEvent('download');
  await release();
  const other=await(await second).path();
  if(!other)throw Error('Missing second configuration export');
  expect(AnalysisResult.parse(JSON.parse(await readFile(other,'utf8'))).scenarioId).toBe(base.scenarioId+':export-other');
});

test('rejects a mismatched or malformed analysis completion and a late completion from a terminated worker',async({page})=>{
  await page.addInitScript(()=>{
    const OriginalWorker=window.Worker,probe:ResultProbe={mode:'wrong-hash',held:[]};
    Object.assign(window,{analysisResultProbe:probe});
    window.Worker=class extends OriginalWorker{
      constructor(url:string|URL,options?:WorkerOptions){
        super(url,options);
        if(!String(url).includes('analysis-worker-'))return;
        this.addEventListener('message',event=>{
          const reply=event.data;
          if(reply?.kind!=='analyzed'||probe.mode==='normal'||!(reply.payload instanceof ArrayBuffer))return;
          const attempt=JSON.parse(new TextDecoder().decode(reply.payload));
          if(attempt?.status!=='available')return;
          event.stopImmediatePropagation();
          const result={...attempt.result,...(probe.mode==='malformed'?{nodes:null}:{inputHash:'0'.repeat(64)})};
          const payload=new TextEncoder().encode(JSON.stringify({status:'available',result})).buffer;
          const completion=new MessageEvent('message',{data:{kind:'analyzed',taskId:reply.taskId,payload}});
          const call=()=>this.onmessage?.call(this,completion);
          if(probe.mode==='hold')probe.held.push(call);
          else call();
        });
      }
    };
  });
  const setMode=(mode:ResultProbe['mode'])=>page.evaluate(mode=>{
    const probe=(window as Window&{analysisResultProbe?:ResultProbe}).analysisResultProbe;
    if(!probe)throw Error('Missing analysis result observer');
    probe.mode=mode;
  },mode);
  await openWorkspace(page,c01Project());
  await page.getByRole('button',{name:'分析此配置 ↗',exact:true}).click();
  const panel=page.locator('.analysis-panel'),alert=panel.getByRole('alert'),cards=panel.locator('.analysis-cards');
  await expect(alert).toContainText('分析结果与当前配置、输入哈希或引擎版本不同');
  await expect(cards).toHaveCount(0);
  const run=panel.getByRole('button',{name:'计算理论结果',exact:true});
  await setMode('malformed');
  await run.click();
  await expect(alert).toContainText('分析线程返回了无效结果');
  await expect(cards).toHaveCount(0);
  await setMode('hold');
  await run.click();
  await expect.poll(()=>page.evaluate(()=>(window as Window&{analysisResultProbe?:ResultProbe}).analysisResultProbe?.held.length)).toBe(1);
  await panel.getByRole('button',{name:'取消理论分析',exact:true}).click();
  await setMode('normal');
  await run.click();
  await expect(cards).toBeVisible();
  await page.evaluate(()=>{(window as Window&{analysisResultProbe?:ResultProbe}).analysisResultProbe?.held.shift()?.();});
  await expect(cards).toBeVisible();
  await expect(alert).toHaveCount(0);
});
