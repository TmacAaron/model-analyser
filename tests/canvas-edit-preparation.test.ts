import {it,expect,vi,afterEach} from 'vitest';
import {analyzeScenario,instantiateModel} from '@model-analyser/core';
import {AssetDocument,FusionGroup} from '@model-analyser/contracts';
import {canonical} from '../packages/contracts/src/validation.js';
import {canvasEditProject} from './canvas-fixtures.js';
import {largeCanvasEditProject} from './canvas-edit-preparation-fixtures.js';
import {evaluateCanvasEditTask,type CanvasEditTask} from '../apps/web/src/canvas-edit-worker.js';
import {runCanvasEditTask} from '../apps/web/src/canvas-edit-task.js';
function task():Extract<CanvasEditTask,{kind:'prepare'}>{const p=canvasEditProject(),s=p.scenarios[0]!,asset=p.assetSnapshots.find(a=>a.assetId===s.model.assetId)!;return {taskId:'test-task',kind:'prepare',project:p,modelRef:s.model,intent:{asset,fromId:'a',toId:'b',kind:'data',outputPort:'y',inputPort:'x'},library:[]};}
it('background preparation preserves immutable sources and fully validates both affected configurations before returning a publishable plan',async()=>{
 const t=task();t.project.scenarios.push({...structuredClone(t.project.scenarios[0]!),scenarioId:'second',name:'Second'});const before=canonical(t.project),r=evaluateCanvasEditTask(t);expect(r.reply.kind).toBe('prepared');expect(canonical(t.project)).toBe(before);if(r.reply.kind!=='prepared')throw Error();const {plan}=r.reply;expect(plan.project.scenarios[0]!.model).toEqual(plan.project.scenarios[1]!.model);expect(plan.project.assetSnapshots).toEqual(expect.arrayContaining(t.project.assetSnapshots));expect(plan.records).toHaveLength(2);for(const row of plan.records){expect(row.draftSaved).toBe(false);expect(row.committed).toBe(false);expect(row.draft.candidate).toEqual(row.asset);}for(const scenario of plan.project.scenarios){const a=await analyzeScenario(scenario,plan.project.assetSnapshots);expect(a.status).toBe('available');if(a.status==='available')expect(a.result.total.seconds).toMatchObject({status:'available',quantity:{value:2}});}
});
it('a cycle or a failing secondary configuration produces diagnostics rather than a plan',()=>{
 const t=task();if(t.intent.asset.definition.kind!=='model')throw Error();t.intent.kind='control';t.intent.asset=AssetDocument.parse({...t.intent.asset,definition:{...t.intent.asset.definition,graph:{...t.intent.asset.definition.graph,dependencies:[{edgeId:'reverse',fromNodeId:'b',toNodeId:'a',kind:'control'}]}}});expect(evaluateCanvasEditTask(t).reply).toMatchObject({kind:'error',message:expect.stringMatching(/环|cycle/)});
 const t2=task();t2.project.scenarios.push({...structuredClone(t2.project.scenarios[0]!),scenarioId:'invalid-second',name:'Invalid secondary',fusionGroups:[FusionGroup.parse({groupId:'invalid-fusion',memberNodeIds:['absent'],eliminatedTensorIds:[],extraCost:{compute:[],memoryAccess:[],temporaryStorageIds:[],timing:{kind:'fixed',seconds:0,description:'No extra work'}},timeStrategy:{kind:'sum_members'}})]});expect(evaluateCanvasEditTask(t2).reply.kind).toBe('error');
});
it('connection removal retains the precise requested edge instead of turning a retry into an added connection',()=>{
 const t=task();if(t.intent.asset.definition.kind!=='model')throw Error();t.intent.asset=AssetDocument.parse({...t.intent.asset,definition:{...t.intent.asset.definition,graph:{...t.intent.asset.definition.graph,dependencies:[{edgeId:'remove-me',fromNodeId:'a',toNodeId:'b',kind:'control'}]}}});t.intent.removeId='remove-me';const r=evaluateCanvasEditTask(t);if(r.reply.kind!=='prepared')throw Error(JSON.stringify(r));const s=r.reply.plan.project.scenarios[0]!,model=r.reply.plan.project.assetSnapshots.find(a=>a.assetId===s.model.assetId);expect(model?.definition.kind==='model'&&model.definition.graph.dependencies).toEqual([]);
});
it('reference discovery selects pinned versions only when the current library can verify that exact revision',()=>{
 const t=task(),catalog=t.project.assetSnapshots.map(a=>({assetId:a.assetId,revision:a.revision,kind:a.definition.kind})),r=evaluateCanvasEditTask({taskId:'refs',kind:'references',scenario:t.project.scenarios[0]!,assets:t.project.assetSnapshots,catalog});expect(r.reply.kind).toBe('references');if(r.reply.kind!=='references')throw Error();expect(r.reply.refs).toContainEqual(t.modelRef);expect(evaluateCanvasEditTask({taskId:'refs',kind:'references',scenario:t.project.scenarios[0]!,assets:t.project.assetSnapshots,catalog:[]}).reply).toEqual({kind:'references',refs:[]});
});
it('the real maximum fixture expands 9,999 leaves in each configuration and has only two directly editable template nodes',()=>{
 const p=largeCanvasEditProject();for(const s of p.scenarios){const r=instantiateModel(s,p.assetSnapshots);expect(r.status).toBe('available');if(r.status==='available')expect(r.resolved.graph.nodes).toHaveLength(9999);}const model=p.assetSnapshots.find(a=>a.assetId===p.scenarios[0]!.model.assetId);expect(model?.definition.kind==='model'&&model.definition.graph.nodes).toHaveLength(2);
});
afterEach(()=>vi.unstubAllGlobals());
it('cancel terminates a worker and ignores a late prepared reply before any caller can publish it',async()=>{
 const workers:{onmessage:((e:MessageEvent<unknown>)=>void)|null;onerror:(()=>void)|null;terminate:ReturnType<typeof vi.fn>}[]=[];
 class FakeWorker{onmessage:((e:MessageEvent<unknown>)=>void)|null=null;onerror:(()=>void)|null=null;terminate=vi.fn();postMessage(){}constructor(){workers.push(this);}}
 vi.stubGlobal('Worker',FakeWorker);const controller=new AbortController(),t=task(),pending=runCanvasEditTask(t,controller.signal);controller.abort();await expect(pending).rejects.toThrow(/取消/);expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);workers[0]!.onmessage?.({data:evaluateCanvasEditTask(t)} as MessageEvent);expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
});
it.each(['wrong-task','wrong-phase','malformed'])('rejects a %s reply rather than exposing a publication plan',async kind=>{
 let worker:{onmessage:((e:MessageEvent<unknown>)=>void)|null}|undefined;class FakeWorker{onmessage:((e:MessageEvent<unknown>)=>void)|null=null;onerror=null;postMessage(){}terminate(){}constructor(){worker=this;}}
 vi.stubGlobal('Worker',FakeWorker);const t=task(),pending=runCanvasEditTask(t,new AbortController().signal);worker!.onmessage?.({data:kind==='malformed'?{}:{taskId:kind==='wrong-task'?'other':t.taskId,reply:{kind:'references',refs:[]}}} as MessageEvent);await expect(pending).rejects.toThrow(/无效|阶段/);
});
