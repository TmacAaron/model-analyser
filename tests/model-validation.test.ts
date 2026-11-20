import {it,expect,vi,afterEach} from 'vitest';
import {analyzeScenario,instantiateModel} from '@model-analyser/core';
import {confirmConfigModel} from '../packages/contracts/src/config-import.js';
import {canonical} from '../packages/contracts/src/validation.js';
import {canvasEditProject} from './canvas-fixtures.js';
import {largeCanvasEditProject} from './canvas-edit-preparation-fixtures.js';
import {validationConfig,validationAscend,decodeOnlyFailure,decodeFailureFormula} from './model-validation-fixtures.js';
import {evaluateModelValidationTask,type ModelValidationTask} from '../apps/web/src/model-validation-worker.js';
import {runModelValidationTask} from '../apps/web/src/model-validation-task.js';
it('checks both requested execution endpoints on a9999-leaf graph and rejects unmatched IDs without returning a mutated scenario',()=>{
 const p=largeCanvasEditProject(),task:ModelValidationTask={taskId:'targets',kind:'targets',scenario:p.scenarios[0]!,assets:p.assetSnapshots,nodeIds:['leaves[9997]','tail']},before=canonical(p);expect(evaluateModelValidationTask(task)).toEqual({taskId:'targets',reply:{kind:'validated'}});expect(evaluateModelValidationTask({...task,nodeIds:['leaves[9998]','tail']}).reply).toMatchObject({kind:'error',message:expect.stringContaining('未匹配')});expect(canonical(p)).toBe(before);
});
it('config confirmation validates the two phases before returning a model that reproduces the independent624-operation reference',async()=>{
 const f=validationConfig(),before=canonical(f.asset),r=evaluateModelValidationTask({taskId:'config',kind:'config',asset:f.asset,library:f.library});if(r.reply.kind!=='asset')throw Error(JSON.stringify(r));expect(r.reply.asset.configImport?.status).toBe('confirmed');expect(canonical(f.asset)).toBe(before);const s={...f.base.scenarios[0]!,model:{assetId:r.reply.asset.assetId,revision:1,kind:'model' as const}},out=await analyzeScenario(s,[r.reply.asset,...f.library]);if(out.status!=='available')throw Error(JSON.stringify(out));expect(out.result.total.compute.find(c=>c.computeClass.resource==='matrix')?.usefulOperations).toMatchObject({status:'available',quantity:{value:624}});
});
it('a decode-only failure cannot be published merely because the prefill structure passed',()=>{
 const f=validationConfig(),asset=decodeOnlyFailure(confirmConfigModel(f.asset)),s={...f.base.scenarios[0]!,model:{assetId:asset.assetId,revision:1,kind:'model' as const},bindings:[],workload:{kind:'prefill' as const,batchSize:1,queryTokensPerRequest:1,pastTokensPerRequest:0}};f.library.push(decodeFailureFormula);expect(instantiateModel(s,[asset,...f.library]).status).toBe('available');expect(evaluateModelValidationTask({taskId:'two-phases',kind:'config',asset,library:f.library}).reply).toMatchObject({kind:'error',message:expect.stringMatching(/^decode 结构无法展开/)});
});
it('an invalid upgrade target returns diagnostics rather than a successful validation',()=>{
 const p=canvasEditProject();expect(evaluateModelValidationTask({taskId:'upgrade',kind:'model',scenario:p.scenarios[0]!,assets:p.assetSnapshots.filter(a=>a.definition.kind!=='operator')}).reply.kind).toBe('error');
});
it('Ascend confirmation preserves source and original input while producing the explicit32-byte selected storage',async()=>{
 const p=validationAscend(),s=p.scenarios[0]!,before=canonical(p),r=evaluateModelValidationTask({taskId:'ascend',kind:'ascend',project:p,scenarioId:s.scenarioId,importId:'validation-ascend',note:s.ascendQuantizationImports![0]!.confirmationNote});if(r.reply.kind!=='project')throw Error(JSON.stringify(r));expect(canonical(p)).toBe(before);expect(r.reply.project.quantizationSources).toEqual(p.quantizationSources);const out=await analyzeScenario(r.reply.project.scenarios[0]!,r.reply.project.assetSnapshots);if(out.status!=='available')throw Error(JSON.stringify(out));expect(out.result.quantizationApplications).toHaveLength(1);expect(out.result.quantizationApplications![0]).toMatchObject({beforeBytes:32,afterBytes:32});expect(evaluateModelValidationTask({taskId:'bad-ascend',kind:'ascend',project:p,scenarioId:s.scenarioId,importId:'validation-ascend',note:''}).reply.kind).toBe('error');
});
afterEach(()=>vi.unstubAllGlobals());
function fake(){let worker:{onmessage:((event:MessageEvent<unknown>)=>void)|null;terminate:ReturnType<typeof vi.fn>}|undefined;class FakeWorker{onmessage:((event:MessageEvent<unknown>)=>void)|null=null;onerror=null;postMessage(){}terminate=vi.fn();constructor(){worker=this;}}vi.stubGlobal('Worker',FakeWorker);return ()=>worker!;}
const targetTask=():ModelValidationTask=>{const p=canvasEditProject();return {taskId:'targets',kind:'targets',scenario:p.scenarios[0]!,assets:p.assetSnapshots,nodeIds:['a']};};
it('termination rejects pending work and an actual late validation cannot reach a caller',async()=>{
 const worker=fake(),controller=new AbortController(),t=targetTask(),pending=runModelValidationTask(t,controller.signal);controller.abort();await expect(pending).rejects.toThrow('取消');worker().onmessage?.({data:evaluateModelValidationTask(t)} as MessageEvent);expect(worker().terminate).toHaveBeenCalledTimes(1);
});
it.each(['malformed','wrong-task','wrong-phase'])('rejects %s validation replies',async kind=>{
 const worker=fake(),pending=runModelValidationTask(targetTask(),new AbortController().signal);worker().onmessage?.({data:kind==='malformed'?{}:{taskId:kind==='wrong-task'?'other':'targets',reply:kind==='wrong-phase'?{kind:'project',project:canvasEditProject()}:{kind:'validated'}}} as MessageEvent);await expect(pending).rejects.toThrow(/无效|阶段/);
});
