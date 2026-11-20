import { it,expect } from 'vitest';
import { AssetDocument,NodeId } from '@model-analyser/contracts';
import { validateAssets } from '../packages/contracts/src/validation.js';
import { instantiateModel } from '@model-analyser/core';
import { runtimeScaleProject,runtimeDepthProject } from '../scripts/runtime-scale-project.js';

it.each(['inline','operator','chain'] as const)('reaches the actual default expansion boundary for %s and rejects the next leaf rather than returning a partial graph',kind=>{
  const p=runtimeScaleProject(kind),r=instantiateModel(p.scenarios[0]!,p.assetSnapshots);expect(r.status,JSON.stringify(r.diagnostics)).toBe('available');if(r.status!=='available')throw Error();expect(r.resolved.graph.nodes).toHaveLength(9999);expect(r.resolved.containers.find(c=>c.nodeId==='$model')?.leafNodeIds).toHaveLength(9999);expect(r.resolved.graph.nodes[0]?.nodeId).toBe('leaves[0]');expect(r.resolved.graph.nodes.at(-1)?.nodeId).toBe('leaves[9998]');if(kind==='chain'){expect(r.resolved.graph.edges).toHaveLength(10000);expect(r.resolved.graph.storages).toHaveLength(10000);}
  const over=runtimeScaleProject(kind,10000),rejected=instantiateModel(over.scenarios[0]!,over.assetSnapshots);expect(rejected.status).toBe('unavailable');expect(rejected.diagnostics[0]?.code).toBe('expansion_limit');expect(rejected).not.toHaveProperty('resolved');
},30000);

it('accepts exactly 64 referenced assets and rejects depth65 using the declared guard',()=>{
  const allowed=runtimeDepthProject(64),r=instantiateModel(allowed.scenarios[0]!,allowed.assetSnapshots);expect(r.status,JSON.stringify(r.diagnostics)).toBe('available');if(r.status!=='available')throw Error();expect(r.resolved.graph.nodes).toHaveLength(1);expect(r.resolved.containers).toHaveLength(63);const over=runtimeDepthProject(65),rejected=instantiateModel(over.scenarios[0]!,over.assetSnapshots);expect(rejected.status).toBe('unavailable');expect(rejected.diagnostics[0]).toMatchObject({code:'expansion_limit',message:'引用深度超过预算'});
});

it('still diagnoses a real late back-edge in a long connected graph after validating its complete acyclic prefix',()=>{
  const p=runtimeScaleProject('chain'),r=instantiateModel(p.scenarios[0]!,p.assetSnapshots);expect(r.status).toBe('available');if(r.status!=='available')throw Error();const model=p.assetSnapshots.find(a=>a.definition.kind==='model')!;if(model.definition.kind!=='model')throw Error();const root=AssetDocument.parse({...model,definition:{...model.definition,graph:r.resolved.graph}}),g=root.definition.kind==='model'?root.definition.graph:undefined;if(!g)throw Error();expect(validateAssets([root],p.assetSnapshots).filter(d=>d.severity==='error')).toEqual([]);g.dependencies.push({edgeId:'late-cycle',fromNodeId:NodeId.parse('leaves[9998]'),toNodeId:NodeId.parse('leaves[0]'),kind:'synchronization'});expect(validateAssets([root],p.assetSnapshots).some(d=>d.code==='dependency_cycle'&&d.message.startsWith('单步依赖环'))).toBe(true);
},30000);
