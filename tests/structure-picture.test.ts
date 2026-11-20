import {it,expect} from 'vitest';
import {instantiateModel} from '@model-analyser/core';
import {AssetDocument} from '@model-analyser/contracts';
import {canvasEditProject} from './canvas-fixtures.js';
import {runtimeScaleProject} from '../scripts/runtime-scale-project.js';
import {structurePictureIndex} from '../apps/web/src/structure-picture-layout.js';
it('uses actual control dependencies, not source node order, when assigning compatibility graph ranks',()=>{
 const p=canvasEditProject(),s=p.scenarios[0]!,model=p.assetSnapshots.find(a=>a.assetId===s.model.assetId)!;if(model.definition.kind!=='model')throw Error();const edited=AssetDocument.parse({...model,definition:{...model.definition,graph:{...model.definition.graph,dependencies:[{edgeId:'reverse',fromNodeId:'b',toNodeId:'a',kind:'control'}]}}}),r=instantiateModel(s,p.assetSnapshots.map(a=>a===model?edited:a));if(r.status!=='available')throw Error();const index=structurePictureIndex(r.resolved);expect(index.ordered).toEqual(['b','a']);expect(index.ranks.get('b')).toBe(0);expect(index.ranks.get('a')).toBe(1);expect(index.links).toEqual([{from:'b',to:'a',control:true}]);
});
it('preserves all actual chain edges and ranks on the budget-bound connected graph without a per-node scan of all edges',()=>{
 const p=runtimeScaleProject('chain'),r=instantiateModel(p.scenarios[0]!,p.assetSnapshots);if(r.status!=='available')throw Error();const index=structurePictureIndex(r.resolved);expect(index.ordered).toHaveLength(9999);expect(index.links).toHaveLength(9998);for(let i=0;i<9999;i++)expect(index.ranks.get('leaves['+i+']')).toBe(i);expect(index.links.every(link=>!link.control)).toBe(true);
});
