import {it,expect} from 'vitest';
import {instantiateModel} from '@model-analyser/core';
import {makeQwenProject} from '../scripts/model-project.js';
import {makeDeepSeekAssets} from '../scripts/deepseek-model.js';
import {makeFusedProject} from '../scripts/fused-project.js';
import {projectCanvasGraph} from '../apps/web/src/canvas-graph.js';
import {projectCanvasView} from '../apps/web/src/canvas-projection.js';
import {c01Project,echo} from './model-fixtures.js';
it('keeps one opaque call inspectable and allows explicit cross-call operator selection without changing the graph',()=>{
 const p=echo('chain'),a=instantiateModel(p.scenario,p.assets);if(a.status!=='available')throw Error();const before=JSON.stringify(a.resolved);
 expect(projectCanvasGraph(a.resolved,'block[0]').nodes.filter(n=>n.kind==='operator').map(n=>n.id)).toEqual(['block[0]']);
 expect(projectCanvasGraph(a.resolved,'block',[],true).nodes.filter(n=>n.kind==='operator').map(n=>n.id)).toEqual(['block[0]','block[1]','block[2]']);expect(JSON.stringify(a.resolved)).toBe(before);
});

it('projects the authored Qwen attention as one node with one real input and preserves its nested arithmetic edges',()=>{
 const p=makeQwenProject({kind:'prefill',batchSize:1,pastTokensPerRequest:0,queryTokensPerRequest:4,chunkTokens:4}),s=p.scenarios[0]!,a=instantiateModel(s,p.assetSnapshots);
 if(a.status!=='available')throw Error(JSON.stringify(a));
 const before=JSON.stringify(a.resolved),id='decoder[0]/$view:attention';
 const group=projectCanvasView(a.resolved,s,{scope:'decoder[0]',expandOperatorCalls:false}).graph;
 expect(group.nodes.find(node=>node.id===id)?.leafIds).toHaveLength(7);
 expect(group.nodes.some(node=>node.id==='decoder[0]/qk')).toBe(false);
 expect(group.edges.filter(edge=>edge.from==='decoder[0]/input-norm'&&edge.to===id)).toHaveLength(1);
 const inner=projectCanvasView(a.resolved,s,{scope:id,expandOperatorCalls:false}).graph;
 expect(inner.nodes.some(node=>node.id==='decoder[0]/qk')).toBe(true);
 expect(inner.edges.some(edge=>edge.from==='decoder[0]/qk'&&edge.to==='decoder[0]/softmax')).toBe(true);
 expect(JSON.stringify(a.resolved)).toBe(before);
});

it('replaces only fused members, then shows the original internal tensor relation on entry',()=>{
 const p=makeFusedProject(c01Project()),s=p.scenarios[0]!,a=instantiateModel(s,p.assetSnapshots);
 if(a.status!=='available')throw Error(JSON.stringify(a));
 const outer=projectCanvasView(a.resolved,s,{scope:'$model',expandOperatorCalls:false}).graph;
 const fusion=outer.nodes.find(node=>node.viewGroup?.kind==='fusion');
 expect(fusion?.leafIds).toEqual(['A','B']);
 expect(outer.nodes.some(node=>node.id==='A'||node.id==='B')).toBe(false);
 expect(outer.edges).toHaveLength(2);
 expect(outer.edges.find(edge=>edge.to===fusion?.id)?.tensorIds).toEqual(['X']);
 expect(outer.edges.find(edge=>edge.from===fusion?.id)?.tensorIds).toEqual(['Y']);
 const inner=projectCanvasView(a.resolved,s,{scope:fusion!.id,expandOperatorCalls:false}).graph;
 expect(inner.nodes.filter(node=>node.kind==='operator').map(node=>node.id)).toEqual(['A','B']);
 expect(inner.edges.find(edge=>edge.from==='A'&&edge.to==='B')?.tensorIds).toEqual(['T']);
});
it('preserves Qwen residual fan-out and opens one actual invocation of the repeated decoder',()=>{
 const p=makeQwenProject({kind:'prefill',batchSize:1,pastTokensPerRequest:0,queryTokensPerRequest:4,chunkTokens:4}),a=instantiateModel(p.scenarios[0]!,p.assetSnapshots);if(a.status!=='available')throw Error(JSON.stringify(a));
 const root=projectCanvasGraph(a.resolved);expect(root.nodes.find(n=>n.id==='decoder')?.repeatCount).toBe(28);
 const g=projectCanvasGraph(a.resolved,'decoder');expect(g.nodes.some(n=>n.id==='decoder[1]')).toBe(false);expect(g.nodes.some(n=>n.id==='decoder[0]/input-norm')).toBe(true);
 const residual=g.edges.find(e=>e.to==='decoder[0]/attention-residual'&&e.from.startsWith('$input:'));expect(residual).toBeDefined();expect(g.edges.some(e=>e.from===residual?.from&&e.to==='decoder[0]/input-norm')).toBe(true);
 expect(g.edges.some(e=>e.from==='decoder[0]/attention-residual'&&e.to==='decoder[0]/mlp-residual')).toBe(true);
 expect(projectCanvasGraph(a.resolved,'decoder[27]').nodes.some(n=>n.id==='decoder[27]/input-norm')).toBe(true);
});
it('keeps actual routed and shared expert branches separate until their declared merge',()=>{
 const p=makeQwenProject({kind:'prefill',batchSize:1,pastTokensPerRequest:0,queryTokensPerRequest:4,chunkTokens:4}),assets=makeDeepSeekAssets(),model=assets.find(a=>a.definition.kind==='model')!;const a=instantiateModel({...p.scenarios[0]!,model:{assetId:model.assetId,revision:model.revision,kind:'model'}},[...assets,...p.assetSnapshots.filter(a=>a.definition.kind==='hardware')]);if(a.status!=='available')throw Error(JSON.stringify(a));
 const g=projectCanvasGraph(a.resolved,'moe');expect(projectCanvasGraph(a.resolved).nodes.find(n=>n.id==='moe')?.repeatCount).toBe(26);const routed=g.nodes.find(n=>n.id.endsWith('/expert-down')),shared=g.nodes.find(n=>n.name.toLowerCase().includes('shared')&&n.id.endsWith('down'));expect(routed).toBeDefined();expect(shared).toBeDefined();expect(g.edges.some(e=>e.from===routed?.id)).toBe(true);expect(g.edges.some(e=>e.from===shared?.id)).toBe(true);expect(g.edges.some(e=>e.from===routed?.id&&e.to===shared?.id)).toBe(false);
});
