import { createElement } from 'react';
import { describe,it,expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { instantiateModel,analyzeScenario,computeInputHash } from '@model-analyser/core';
import { NodeId,AssetDocument,ProjectDocument } from '@model-analyser/contracts';
import { readFileSync } from 'node:fs';
import { traceNodeFormulas } from '../apps/web/src/formula-trace.js';
import { resolvedInterface,canonicalInspectorStorage } from '../apps/web/src/resolved-inspector.js';
import { ResolvedNodeInspector } from '../apps/web/src/resolved-inspector-view.js';
import { evaluateFusionTask } from '../apps/web/src/fusion-worker.js';
import { c01Project,echo } from './model-fixtures.js';
import { makeDecodeProject } from '../scripts/decode-project.js';
import { makeFusedProject } from '../scripts/fused-project.js';
function resolve(f:ReturnType<typeof echo>){const r=instantiateModel(f.scenario,f.assets);if(r.status!=='available')throw Error(JSON.stringify(r));return r.resolved;}
describe('resolved canvas details and exact evaluation evidence',()=>{
  it('uses the complete repeat boundary and each materialized slice, including independent stacked outputs',()=>{
    for(const wiring of ['chain','independent'] as const){const f=echo(wiring),r=resolve(f),wrapper=resolvedInterface(r,f.scenario.model,f.assets,'block'),first=resolvedInterface(r,f.scenario.model,f.assets,'block[0]');expect(wrapper?.inputs[0]?.tensorId).toBe('X');expect(wrapper?.outputs[0]?.tensorId).toBe('Y');expect(first?.outputs[0]?.tensorId).not.toBe('Y');const tensor=r.graph.tensors.find(t=>t.tensorId===wrapper?.outputs[0]?.tensorId);expect(tensor?.shape.map(a=>a.size.kind==='literal'?a.size.quantity.value:null)).toEqual(wiring==='independent'?[3,4]:[4]);expect(r.graph.tensors.find(t=>t.tensorId===first?.outputs[0]?.tensorId)?.shape).toHaveLength(1);}
  });
  it('resolves module interfaces without using their first leaf, and shows logical and quantized storage precision separately',()=>{
    const p=c01Project(),s=p.scenarios[0]!;s.quantizationOverrides=[{selector:{kind:'subtree',rootNodeId:NodeId.parse('$model')},weight:{payloadBits:4,packingUnitElements:2,alignmentBytes:16,auxiliaries:[]}}];const attempt=instantiateModel(s,p.assetSnapshots);if(attempt.status!=='available')throw Error(JSON.stringify(attempt));const r=attempt.resolved,ports=resolvedInterface(r,s.model,p.assetSnapshots,'module');expect(ports?.inputs).toHaveLength(2);expect(ports?.outputs).toHaveLength(1);expect(ports).toEqual(resolvedInterface(r,s.model,p.assetSnapshots,'$model'));const weight=r.graph.storages.find(s=>s.category==='weight')!;expect(canonicalInspectorStorage(r,weight.storageId)?.allocation).toMatchObject({kind:'tensor',quantization:{payloadBits:4}});const html=renderToStaticMarkup(createElement(ResolvedNodeInspector,{resolved:r,model:s.model,assets:p.assetSnapshots,nodeId:"module",leafIds:r.containers.find(c=>c.nodeId==='module')!.leafNodeIds}));expect(html).toContain('量化 payload 4 bit');expect(html).toContain('bf16 · 16 bit');expect(html).toContain('乘法 / 累加精度');expect(html).toContain('实际参数值与来源');
  });
  it('records the values and units actually used after overrides without changing calculation identity',async()=>{
    const p=c01Project(),s=p.scenarios[0]!;s.numericOverrides=[{target:{kind:'scenario',scenarioId:s.scenarioId},field:'parameter',parameterKey:'M',value:{value:5,unit:'count'}}];const a=await analyzeScenario(s,p.assetSnapshots);expect(a.status).toBe('available');if(a.status!=='available')return;expect(a.result.parameterTrace?.find(p=>p.nodeId==='module/op'&&p.parameterKey==='M')).toMatchObject({value:{value:5},unit:'count',source:{kind:'node_override'}});expect(a.result.inputHash).toBe(await computeInputHash(s,p.assetSnapshots));
  });
  it('uses a nested repeated module frame and follows its own formula closure',()=>{
    const f=echo('independent');if(f.op.definition.kind!=='operator'||f.model.definition.kind!=='model')throw Error();const op=f.op.definition.operator,{inputs,outputs,tensors,storages,states}=op;
    const module=AssetDocument.parse({...f.op,assetId:'nested-module',definition:{kind:'module',graph:{inputs,outputs,tensors,storages,states,nodes:[{nodeId:'inner /[]',name:'inner',phases:['prefill','decode'],portBindings:[...inputs,...outputs],stateBindings:[],body:{kind:'opaque',inputs,outputs,cost:op.cost}}],edges:[{edgeId:'in',from:{kind:'graph_input',portId:'x'},to:{kind:'node',nodeId:'inner /[]',portId:'x'},tensorId:'X'},{edgeId:'out',from:{kind:'node',nodeId:'inner /[]',portId:'y'},to:{kind:'graph_output',portId:'y'},tensorId:'Y'}],dependencies:[]}}});f.assets.push(module);f.model.definition.graph.nodes[0]!.body={kind:'module',asset:{assetId:module.assetId,revision:1,kind:'module'},bindings:[]};const r=resolve(f);expect(resolvedInterface(r,f.scenario.model,f.assets,'block')?.outputs[0]?.tensorId).toBe('Y');expect(resolvedInterface(r,f.scenario.model,f.assets,'block[1]')?.outputs[0]?.tensorId).not.toBe('Y');const inner=r.graph.nodes.find(n=>n.nodeId.startsWith('block[1]/'))!;expect(resolvedInterface(r,f.scenario.model,f.assets,inner.nodeId)?.outputs).toEqual(inner.body.kind==='opaque'?inner.body.outputs:[]);
    const p=c01Project();expect(traceNodeFormulas(p.scenarios[0]!.model,'module',p.assetSnapshots).formulas.some(a=>a.definition.kind==='formula'&&a.definition.formula.expression==='2 * M * N * K')).toBe(true);
  });
  it('retains actual parameter traces for an explicit distributed analysis',async()=>{
    const p=ProjectDocument.parse(JSON.parse(readFileSync('examples/computed/serial-gather-project.json','utf8'))),s=p.scenarios[0]!,a=await analyzeScenario(s,p.assetSnapshots);expect(a.status).toBe('available');if(a.status!=='available')return;expect(a.result.distributed).toBeDefined();expect(a.result.parameterTrace?.find(p=>p.nodeId==='module/op'&&p.parameterKey==='M')).toMatchObject({value:{value:4},unit:'count'});expect(a.result.inputHash).toBe(await computeInputHash(s,p.assetSnapshots));
  });
  it('records per-call growing decode parameters and leaves sequence values to the actual steps',async()=>{
    const p=makeDecodeProject(c01Project()),s=p.scenarios[0]!;s.workload={kind:'decode',batchSize:1,queryTokensPerRequest:1,contextTokensPerRequest:2,steps:3};const a=await analyzeScenario(s,p.assetSnapshots);expect(a.status).toBe('available');if(a.status!=='available')return;expect(a.result.parameterTrace).toBeUndefined();expect(a.result.decode?.steps.map(step=>step.result.parameterTrace?.find(p=>p.nodeId==='$model'&&p.parameterKey==='C')?.value.value)).toEqual([2,3,4]);
  });
  it('validates the exact full selection, deduplicates candidates and preserves rejection diagnostics',()=>{
    const p=makeFusedProject(c01Project()),s=p.scenarios[0]!;s.fusionGroups=[];const r=instantiateModel(s,p.assetSnapshots);if(r.status!=='available')throw Error();const task={kind:'candidates' as const,scenario:s,assets:p.assetSnapshots,resolved:r.resolved};expect(evaluateFusionTask({...task,selections:[['A','B'],['A','B']]})).toMatchObject({kind:'candidates',candidates:[{nodeIds:['A','B']}]});expect(evaluateFusionTask({...task,selections:[['A','B','missing']]})).toMatchObject({kind:'candidates',candidates:[]});s.fusionGroups=[{groupId:'bad',memberNodeIds:[NodeId.parse('missing')],eliminatedTensorIds:[],extraCost:{compute:[],memoryAccess:[],temporaryStorageIds:[],timing:{kind:'fixed',seconds:0,description:'none'}},timeStrategy:{kind:'sum_members'}}];expect(evaluateFusionTask({kind:'validate',scenario:s,assets:p.assetSnapshots})).toMatchObject({kind:'error',message:expect.any(String)});
  });
});
