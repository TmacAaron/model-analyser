import { describe,it,expect } from 'vitest';
import { analyzeScenario,instantiateModel,computeInputHash } from '@model-analyser/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NodeId,StateId,StorageId,type ProjectDocument } from '@model-analyser/contracts';
import { canvasAnalysisFocus,targetProblem,sourceTargetId,type AnalysisFocus } from '../apps/web/src/analysis-focus.js';
import { buildCostView,type CostSelection } from '../apps/web/src/cost-explorer.js';
import { StateRelations,relevantStates } from '../apps/web/src/state-relations-view.js';
import { ManualMeasurementEditor } from '../apps/web/src/manual-measurement-view.js';
import { makeStateProject } from '../scripts/state-project.js';
import { makeFusedProject } from '../scripts/fused-project.js';
import { c01Project,echo } from './model-fixtures.js';
const selected:CostSelection={scope:'$model',step:'all',devices:'all',level:'execution',metric:'seconds',order:'original',query:''};
async function report(p:ProjectDocument){const a=await analyzeScenario(p.scenarios[0]!,p.assetSnapshots);if(a.status!=='available')throw Error(JSON.stringify(a));return a.result;}
describe('canvas selection context and persistent state access',()=>{
  it('keeps stable model, repeat wrapper and actual leaf identities without interpreting name or containment as a cost',()=>{const f=echo('chain'),a=instantiateModel(f.scenario,f.assets);if(a.status!=='available')throw Error();expect(canvasAnalysisFocus(a.resolved,'$model',[],'p:s').target).toEqual({kind:'model'});expect(canvasAnalysisFocus(a.resolved,'block',[],'p:s').target).toEqual({kind:'module',nodeId:'block'});expect(canvasAnalysisFocus(a.resolved,'block',['block[1]'],'p:s').target).toEqual({kind:'node',nodeId:'block[1]'});expect(canvasAnalysisFocus(a.resolved,'block',['block[0]','block[1]'],'p:s').target).toBeUndefined();});
  it('shows an exact selected leaf instead of the whole model, and preserves missing scopes as unavailable',async()=>{const f=echo('chain'),p=c01Project();p.assetSnapshots=f.assets;p.scenarios=[f.scenario];const r=await report(p),before=await computeInputHash(f.scenario,f.assets),view=buildCostView(r,f.scenario,{...selected,nodeId:'block[1]'});expect(view.rows.map(r=>r.id)).toEqual(['block[1]']);expect(view.scope).toBe('node:block[1]');expect(view.sum.value).toBe(1);expect(view.reference.value).toBe(1);expect(buildCostView(r,f.scenario,{...selected,scope:'block'}).sum.value).toBe(3);expect(buildCostView(r,f.scenario,{...selected,nodeId:'missing'}).sum.value).toBeNull();expect(buildCostView(r,f.scenario,{...selected,scope:'missing'}).reference.value).toBeNull();expect(buildCostView(r,f.scenario,{...selected,unavailableReason:'多个节点尚未指定完整范围'}).rows).toEqual([]);expect(await computeInputHash(f.scenario,f.assets)).toBe(before);});
  it('resolves exactly a complete fusion selection and blocks independent member measurements',async()=>{const p=makeFusedProject(c01Project()),s=p.scenarios[0]!,a=instantiateModel(s,p.assetSnapshots);if(a.status!=='available')throw Error();const focus=canvasAnalysisFocus(a.resolved,'$model',['A','B'],'p:s'),r=await report(p);expect(focus.target).toEqual({kind:'node',nodeId:r.fusions?.[0]?.evaluation.application.nodeId});expect(targetProblem(r,{kind:'node',nodeId:NodeId.parse('A')},true)).toContain('融合内部');expect(targetProblem(r,focus.target!,true)).toBeUndefined();expect(sourceTargetId(r,focus.target!)).toBe('fusion:'+r.fusions?.[0]?.evaluation.application.nodeId);expect(canvasAnalysisFocus(a.resolved,'$model',['A','missing'],'p:s').target).toBeUndefined();});
  it('finds one actual shared state from either reader and exposes all accessor IDs, not duplicate allocations',()=>{const p=makeStateProject('shared'),a=instantiateModel(p.scenarios[0]!,p.assetSnapshots);if(a.status!=='available')throw Error();for(const node of a.resolved.graph.nodes)expect(relevantStates(a.resolved,node.nodeId,[node.nodeId]).map(s=>s.stateId)).toEqual(['persistent']);const states=relevantStates(a.resolved,'layer[0]',['layer[0]/read']);expect(states).toHaveLength(1);expect(states[0]?.readers.map(p=>p.nodeId)).toEqual(['layer[0]/read','layer[1]/read']);const html=renderToStaticMarkup(createElement(StateRelations,{resolved:a.resolved,nodeId:'layer[0]',leafIds:['layer[0]/read']}));expect(html).toContain('调用前已初始化');expect(html).toContain('layer[1]/read');expect(html).toContain('static');expect(html).toContain('request');});
  it('does not merge different state IDs merely because names and storage coincide',()=>{const p=makeStateProject('shared'),a=instantiateModel(p.scenarios[0]!,p.assetSnapshots);if(a.status!=='available')throw Error();const first=a.resolved.graph.states[0]!;a.resolved.graph.states.push({...structuredClone(first),stateId:StateId.parse('different-state-id')});expect(relevantStates(a.resolved,'layer[0]/read',['layer[0]/read']).map(s=>s.stateId)).toEqual(['persistent','different-state-id']);});
  it('includes a state reached only through a two-hop storage alias while excluding equal-sized unrelated storage',()=>{
    const p=makeStateProject('shared'),a=instantiateModel(p.scenarios[0]!,p.assetSnapshots);
    if(a.status!=='available')throw Error('Missing fixture expansion');
    const {resolved}=a,{states,storages,nodes,tensors}=resolved.graph,state=states[0],leaf=nodes[0];
    const backing=storages.find(s=>s.storageId===state?.storageIds[0]);
    const tensor=tensors.find(t=>t.tensorId===leaf?.portBindings[0]?.tensorId);
    if(!state||!backing||!tensor||leaf?.body.kind!=='opaque')throw Error('Missing fixture state interface');
    const alias1=StorageId.parse('state-alias-1'),alias2=StorageId.parse('state-alias-2'),unrelated=StorageId.parse('unrelated-state');
    storages.push({...backing,storageId:alias1,allocation:{kind:'alias',targetStorageId:backing.storageId}},
      {...backing,storageId:alias2,allocation:{kind:'alias',targetStorageId:alias1}},{...backing,storageId:unrelated});
    tensor.storageId=alias2;
    leaf.body.cost.memoryAccess=[];
    state.readers=[];
    for(const frame of resolved.objectBindings)frame.states=[];
    states.push({...state,stateId:StateId.parse('other'),storageIds:[unrelated]});
    expect(relevantStates(resolved,leaf.nodeId,[leaf.nodeId]).map(item=>item.stateId)).toEqual([state.stateId]);
  });
  it('renders an unavailable selected target without silently enabling model measurement',async()=>{const p=c01Project(),r=await report(p),focus:AnalysisFocus={key:'missing',label:'missing selected node',target:{kind:'node',nodeId:NodeId.parse('missing')}};const html=renderToStaticMarkup(createElement(ManualMeasurementEditor,{scenario:p.scenarios[0]!,result:r,focus,onRecord:()=>{throw Error('SSR must never apply');}}));expect(html).toContain('当前结果没有此目标');expect(html).toContain('disabled=""');expect(html).toContain('value="node:missing" selected=""');});
});
