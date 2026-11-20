import { describe,it,expect } from 'vitest';
import { AssetDocument,ProjectDocument,Scenario,NodeId,TensorId,StorageId,StateId,type InstantiationResult } from '@model-analyser/contracts';
import { instantiateModel,topologicalOrder,evaluateCost } from '@model-analyser/core';
import { echo,c01Project } from './model-fixtures.js';
const base=c01Project();
const available=(result:InstantiationResult)=>{expect(result.status,JSON.stringify(result.diagnostics)).toBe('available');if(result.status!=='available')throw Error(JSON.stringify(result.diagnostics));return result.resolved;};
const literal=(value:number,unit='count')=>({kind:'literal',quantity:{value,unit}});
describe('model graph instantiation',()=>{
  it('expands C01 into one costed leaf and keeps one physical allocation for each bound storage',()=>{
    const scenario=base.scenarios[0];if(!scenario)throw Error();const graph=available(instantiateModel(scenario,base.assetSnapshots));
    expect(graph.graph.nodes.map(n=>n.nodeId)).toEqual(['module/op']);expect(graph.graph.storages.map(s=>s.storageId)).toEqual(['sX','sW','sY']);expect(graph.graph.tensors).toHaveLength(3);expect(graph.graph.edges).toHaveLength(3);
    const node=graph.graph.nodes[0];if(node?.body.kind!=='opaque')throw Error();const hw=base.assetSnapshots.find(a=>a.definition.kind==='hardware');if(hw?.definition.kind!=='hardware')throw Error();
    const evaluated=evaluateCost(node.body.cost,{phase:'decode',target:{kind:'node',nodeId:node.nodeId},deviceIds:scenario.deviceTopology.devices.map(d=>d.deviceId),aggregation:'per_device'},{symbols:{},assets:[]},hw.definition.hardware);
    expect(evaluated.cost.seconds.status==='available'&&evaluated.cost.seconds.quantity.value).toBe(4.48);
  });
  it('chains repeated interfaces, broadcasts other inputs and uses stable IDs independent of names',()=>{
    const {scenario,assets,model}=echo('chain');const first=available(instantiateModel(scenario,assets));expect(topologicalOrder(first.graph)).toEqual(['block[0]','block[1]','block[2]']);
    expect(first.graph.edges.filter(e=>e.from.kind==='node'&&e.to.kind==='node').map(e=>[e.from.kind==='node'?e.from.nodeId:'',e.to.kind==='node'?e.to.nodeId:''])).toEqual([['block[0]','block[1]'],['block[1]','block[2]']]);
    if(model.definition.kind!=='model'||!model.definition.graph.nodes[0])throw Error();model.definition.graph.nodes[0].name='Renamed';const second=available(instantiateModel(scenario,assets));expect(second.graph.nodes.map(n=>n.nodeId)).toEqual(first.graph.nodes.map(n=>n.nodeId));
  });
  it('preserves the independent repeat axis and joins output views without extra FLOPs or copies',()=>{
    const {scenario,assets}=echo('independent');const result=available(instantiateModel(scenario,assets));expect(result.graph.nodes.map(n=>n.nodeId)).toEqual(['block[0]','block[1]','block[2]','block/$outputs:y']);
    expect(result.graph.storages).toHaveLength(2);const view=result.graph.nodes.at(-1);expect(view?.body.kind==='opaque'&&view.body.cost.compute).toEqual([]);expect(result.graph.edges.filter(e=>e.to.kind==='node'&&e.to.nodeId==='block/$outputs:y')).toHaveLength(3);
  });
  it('applies per-instance parameter overrides and records their source',()=>{
    const {scenario,assets}=echo('chain');scenario.numericOverrides.push({target:{kind:'node',nodeId:NodeId.parse('block[1]')},field:'parameter',parameterKey:'P',value:{value:7,unit:'operation'}});
    const result=available(instantiateModel(scenario,assets));expect(result.parameters.find(p=>p.nodeId==='block[1]'&&p.parameterKey==='P')).toMatchObject({value:{kind:'integer',value:7},source:{kind:'node_override'}});
    const node=result.graph.nodes.find(n=>n.nodeId==='block[1]');expect(node?.body.kind==='opaque'&&node.body.cost.compute[0]?.usefulOperations).toEqual({kind:'literal',quantity:{value:7,unit:'operation'}});
  });
  it('rejects missing/incorrect bindings, shape mismatches and expansion-limit violations rather than returning zeros',()=>{
    const p=structuredClone(base),scenario=p.scenarios[0];if(!scenario)throw Error();scenario.bindings.push({parameterKey:'M',value:{kind:'literal',quantity:{value:4,unit:'byte'}}});expect(instantiateModel(scenario,p.assetSnapshots).status).toBe('unavailable');
    const example=echo('chain');expect(instantiateModel(example.scenario,example.assets,{maxNodes:2,maxDepth:64}).status).toBe('unavailable');
    if(example.op.definition.kind!=='operator')throw Error();const tensor=example.op.definition.operator.tensors[0];if(!tensor)throw Error();tensor.shape[0]={axisId:'d',semantic:'hidden',size:{kind:'literal',quantity:{value:8,unit:'count'}}};expect(instantiateModel(example.scenario,example.assets).status).toBe('unavailable');
  });
  it('does not count nodes from a different phase or accept active cyclic control dependencies',()=>{
    const example=echo();if(example.model.definition.kind!=='model')throw Error();const g=example.model.definition.graph,n=g.nodes[0];if(!n)throw Error();g.nodes.push({...structuredClone(n),nodeId:NodeId.parse('prefill-only'),phases:['prefill']});
    expect(available(instantiateModel(example.scenario,example.assets)).graph.nodes).toHaveLength(1);g.dependencies.push({edgeId:'cycle',fromNodeId:n.nodeId,toNodeId:n.nodeId,kind:'control'});expect(instantiateModel(example.scenario,example.assets).status).toBe('unavailable');
  });
  it('escapes local IDs so path characters do not collide with hierarchy or repeat suffixes',()=>{
    const {scenario,assets,model}=echo();if(model.definition.kind!=='model')throw Error();const n=model.definition.graph.nodes[0];if(!n)throw Error();n.nodeId=NodeId.parse('a/b[0]');for(const e of model.definition.graph.edges){if(e.from.kind==='node')e.from.nodeId=n.nodeId;if(e.to.kind==='node')e.to.nodeId=n.nodeId;}
    expect(available(instantiateModel(scenario,assets)).graph.nodes[0]?.nodeId).toBe('a%2Fb%5B0%5D');
  });
  it('binds two state readers to one parent allocation without erasing their separate reads',()=>{
    const example=echo();if(example.op.definition.kind!=='operator'||example.model.definition.kind!=='model')throw Error();
    const op=example.op.definition.operator,g=example.model.definition.graph;
    op.outputs=[];op.tensors=op.tensors.filter(t=>t.tensorId==='X');op.storages=op.storages.filter(s=>s.storageId==='sX').map(s=>({...s,category:'state'}));op.cost.compute=[];op.cost.memoryAccess=op.cost.memoryAccess.filter(a=>a.mode==='read');
    op.states=[{stateId:StateId.parse('local-state'),name:'shared reader',stateKind:'kv',storageIds:[StorageId.parse('sX')],creator:{kind:'initialized'},readers:[{kind:'node',nodeId:NodeId.parse('$self'),portId:'x'}],writers:[],updatePolicy:{kind:'static'}}];
    g.inputs=[];g.outputs=[];g.tensors=g.tensors.filter(t=>t.tensorId==='X');g.storages=g.storages.filter(s=>s.storageId==='sX').map(s=>({...s,category:'state'}));g.edges=[];
    const localState=op.states[0];if(!localState)throw Error();g.states=[{...localState,stateId:StateId.parse('parent-state'),name:'parent',readers:[]}];
    const node=g.nodes[0];if(!node)throw Error();node.portBindings=[{portId:'x',tensorId:TensorId.parse('X')}];node.stateBindings=[{localStateId:StateId.parse('local-state'),parentStateId:StateId.parse('parent-state')}];
    g.nodes=[{...structuredClone(node),nodeId:NodeId.parse('A')},{...structuredClone(node),nodeId:NodeId.parse('B')}];
    const result=available(instantiateModel(example.scenario,example.assets));expect(result.graph.storages).toHaveLength(1);expect(result.graph.states).toHaveLength(1);expect(result.graph.states[0]?.readers.map(r=>r.nodeId)).toEqual(['A','B']);
    let reads=0;for(const leaf of result.graph.nodes){if(leaf.body.kind!=='opaque')throw Error();const c=evaluateCost(leaf.body.cost,{phase:'decode',target:{kind:'node',nodeId:leaf.nodeId},deviceIds:example.scenario.deviceTopology.devices.map(d=>d.deviceId),aggregation:'per_device'},{symbols:{},assets:[]});if(c.cost.logicalReadBytes.status!=='available')throw Error();reads+=c.cost.logicalReadBytes.quantity.value;}expect(reads).toBe(16);
    if(!g.states[0])throw Error();g.states[0].stateKind='recurrent';expect(instantiateModel(example.scenario,example.assets).status).toBe('unavailable');
  });
  it('keeps recurrent read/write state outside the single-step dependency DAG',()=>{
    const example=echo();if(example.op.definition.kind!=='operator'||example.model.definition.kind!=='model')throw Error();const op=example.op.definition.operator,g=example.model.definition.graph;
    op.tensors.forEach(t=>t.storageId=StorageId.parse('sX'));op.storages=op.storages.filter(s=>s.storageId==='sX').map(s=>({...s,category:'state'}));op.cost.memoryAccess.forEach(a=>a.storageId=StorageId.parse('sX'));
    op.states=[{stateId:StateId.parse('s'),name:'recurrent',stateKind:'recurrent',storageIds:[StorageId.parse('sX')],creator:{kind:'initialized'},readers:[{kind:'node',nodeId:NodeId.parse('$self'),portId:'x'}],writers:[{kind:'node',nodeId:NodeId.parse('$self'),portId:'y'}],updatePolicy:{kind:'replace'}}];
    const localState=op.states[0];if(!localState)throw Error();g.inputs=[];g.outputs=[];g.edges=[];g.tensors.forEach(t=>t.storageId=StorageId.parse('sX'));g.storages=g.storages.filter(s=>s.storageId==='sX').map(s=>({...s,category:'state'}));g.states=[{...localState,readers:[],writers:[]}];
    const node=g.nodes[0];if(!node)throw Error();node.stateBindings=[{localStateId:StateId.parse('s'),parentStateId:StateId.parse('s')}];
    const result=available(instantiateModel(example.scenario,example.assets));expect(result.graph.edges).toEqual([]);expect(topologicalOrder(result.graph)).toEqual(['block']);expect(result.graph.states[0]?.writers).toHaveLength(1);
  });
  it('remaps opaque chain costs to the actual carried storage objects',()=>{
    const example=echo('chain');if(example.model.definition.kind!=='model'||example.op.definition.kind!=='operator')throw Error();const node=example.model.definition.graph.nodes[0];if(!node)throw Error();node.body={kind:'opaque',inputs:example.op.definition.operator.inputs,outputs:example.op.definition.operator.outputs,cost:{...example.op.definition.operator.cost,compute:[]}};
    const result=available(instantiateModel(example.scenario,example.assets)),middle=result.graph.nodes[1];if(middle?.body.kind!=='opaque')throw Error();expect(middle.body.cost.memoryAccess.map(a=>a.storageId)).toEqual(['block[0]::%24output%3Ay','block[1]::%24output%3Ay']);
  });
  it('orders branch dependencies and rejects unmatched parameter overrides',()=>{
    const example=echo();if(example.model.definition.kind!=='model')throw Error();const g=example.model.definition.graph;
    g.inputs=[];g.outputs=[];g.tensors=[];g.storages=[];g.edges=[];g.nodes=['prepare','A','B','join'].map(id=>({nodeId:NodeId.parse(id),name:id,phases:['decode'],portBindings:[],stateBindings:[],body:{kind:'opaque',inputs:[],outputs:[],cost:{compute:[],memoryAccess:[],temporaryStorageIds:[],timing:{kind:'fixed',seconds:1,description:'Synthetic branch'}}}}));
    g.dependencies=[['prepare','A'],['prepare','B'],['A','join'],['B','join']].map(([from,to],i)=>({edgeId:String(i),fromNodeId:NodeId.parse(from),toNodeId:NodeId.parse(to),kind:'control'}));
    if(!g.dependencies[0])throw Error();g.dependencies[0].kind='synchronization';const resolved=available(instantiateModel(example.scenario,example.assets));expect(topologicalOrder(resolved.graph)).toEqual(['prepare','A','B','join']);expect(resolved.graph.dependencies[0]?.kind).toBe('synchronization');
    example.scenario.numericOverrides.push({target:{kind:'node',nodeId:NodeId.parse('missing')},field:'parameter',parameterKey:'P',value:{value:2,unit:'operation'}});expect(instantiateModel(example.scenario,example.assets).status).toBe('unavailable');
  });
  it('budgets empty repeated containers even when they produce no costed leaf nodes',()=>{
    const example=echo('chain');const module=AssetDocument.parse({...example.op,assetId:'empty',parameters:[],definition:{kind:'module',graph:{inputs:[],outputs:[],nodes:[],edges:[],dependencies:[],tensors:[],storages:[],states:[]}}});example.assets.push(module);
    if(example.model.definition.kind!=='model')throw Error();const g=example.model.definition.graph;g.inputs=[];g.outputs=[];g.edges=[];g.tensors=[];g.storages=[];g.nodes=[{nodeId:NodeId.parse('empty-repeat'),name:'empty',phases:['decode'],portBindings:[],stateBindings:[],repeat:{axis:'i',count:{kind:'literal',quantity:{value:8,unit:'count'}},wiring:'independent',carry:[]},body:{kind:'module',asset:{assetId:module.assetId,revision:1,kind:'module'},bindings:[]}}];
    const result=instantiateModel(example.scenario,example.assets,{maxNodes:8,maxDepth:64});expect(result.status).toBe('unavailable');expect(result.diagnostics[0]?.code).toBe('expansion_limit');
  });
});
