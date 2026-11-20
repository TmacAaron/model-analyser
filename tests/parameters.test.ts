import { it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ProjectDocument,NodeId,ParameterBinding,ParameterDef } from '@model-analyser/contracts';
import { bindParameters } from '@model-analyser/core';
import { fixture } from './fixtures.js';
import { echo } from './model-fixtures.js';
import { instantiateModel } from '@model-analyser/core';
import { validateAssets } from '../packages/contracts/src/validation.js';
const project=ProjectDocument.parse(JSON.parse(readFileSync('examples/contracts/project.json','utf8')) as unknown);
function setup(){const scenario=project.scenarios[0];if(!scenario)throw Error();const asset=fixture();asset.parameters=[ParameterDef.parse({key:'n',name:'n',type:'integer',unit:'count',min:1,max:16,default:{kind:'integer',value:4}})];return {scenario:structuredClone(scenario),asset};}
it('model workload defaults follow the phase and preserve explicit binding/override priority and provenance',()=>{
  const {model,assets,scenario}=echo();if(model.definition.kind!=='model')throw Error();model.parameters=[ParameterDef.parse({key:'B',name:'batch',type:'integer',unit:'count',min:1,default:{kind:'integer',value:1}})];model.definition.workloadBindings=[{phase:'decode',parameterKey:'B',value:{kind:'symbol',name:'batchSize'}},{phase:'prefill',parameterKey:'B',value:{kind:'symbol',name:'queryTokensPerRequest'}}];scenario.bindings=[];
  const run=()=>{const r=instantiateModel(scenario,assets);expect(r.status,JSON.stringify(r.diagnostics)).toBe('available');if(r.status!=='available')throw Error();return r.resolved.parameters.find(p=>p.nodeId==='$model'&&p.parameterKey==='B');};
  scenario.workload={kind:'decode',batchSize:3,contextTokensPerRequest:0,queryTokensPerRequest:1,steps:1};expect(run()).toMatchObject({value:{value:3},source:{kind:'asset_workload_binding',phase:'decode'}});
  scenario.workload={kind:'prefill',batchSize:3,pastTokensPerRequest:0,queryTokensPerRequest:7};expect(run()).toMatchObject({value:{value:7},source:{phase:'prefill'}});
  scenario.bindings=[ParameterBinding.parse({parameterKey:'B',value:{kind:'literal',quantity:{value:5,unit:'count'}}})];expect(run()).toMatchObject({value:{value:5},source:{kind:'scenario_override'}});
  scenario.numericOverrides=[{target:{kind:'scenario',scenarioId:scenario.scenarioId},field:'parameter',parameterKey:'B',value:{value:9,unit:'count'}}];expect(run()?.value).toMatchObject({value:9});
  expect(validateAssets(assets).filter(d=>d.severity==='error')).toEqual([]);
  for(const bad of [{phase:'decode',parameterKey:'B',value:{kind:'symbol',name:'pastTokensPerRequest'}},{phase:'decode',parameterKey:'unknown',value:{kind:'symbol',name:'batchSize'}},{phase:'decode',parameterKey:'B',value:{kind:'literal',quantity:{value:1,unit:'byte'}}}]){const copy=structuredClone(model);if(copy.definition.kind!=='model')throw Error();copy.definition.workloadBindings=[bad as typeof model.definition.workloadBindings[number]];expect(validateAssets([copy],assets).some(d=>d.severity==='error')).toBe(true);}
  model.definition.workloadBindings.push(model.definition.workloadBindings[0]!);expect(validateAssets([model],assets).some(d=>d.severity==='error')).toBe(true);
});
it('parameter priority is project fallback, asset default, scenario binding/override, then node override',()=>{
  const {scenario,asset}=setup(),id=NodeId.parse('$model');scenario.numericOverrides=[{target:{kind:'project'},field:'parameter',parameterKey:'n',value:{value:2,unit:'count'}}];
  expect(bindParameters(asset,[],{},[],scenario,id,true).parameters[0]).toMatchObject({value:{value:4},source:{kind:'asset_default'}});
  const bindings=[ParameterBinding.parse({parameterKey:'n',value:{kind:'symbol',name:'batchSize'}})];
  expect(bindParameters(asset,bindings,{batchSize:{value:8,unit:'count'}},[],scenario,id,true).parameters[0]).toMatchObject({value:{value:8},source:{kind:'scenario_override'}});
  scenario.numericOverrides.push({target:{kind:'scenario',scenarioId:scenario.scenarioId},field:'parameter',parameterKey:'n',value:{value:10,unit:'count'}},{target:{kind:'node',nodeId:id},field:'parameter',parameterKey:'n',value:{value:12,unit:'count'}});
  expect(bindParameters(asset,bindings,{batchSize:{value:8,unit:'count'}},[],scenario,id,true).symbols['n']).toEqual({value:12,unit:'count'});
});
it('a project fallback supplies a missing required parameter but invalid units/ranges are never coerced',()=>{
  const {scenario,asset}=setup();if(!asset.parameters[0])throw Error();delete asset.parameters[0].default;
  expect(()=>bindParameters(asset,[],{},[],scenario,NodeId.parse('$model'),true)).toThrow('缺少必需参数');
  scenario.numericOverrides=[{target:{kind:'project'},field:'parameter',parameterKey:'n',value:{value:3,unit:'count'}}];expect(bindParameters(asset,[],{},[],scenario,NodeId.parse('$model'),true).parameters[0]).toMatchObject({value:{value:3},source:{kind:'project_default'}});
  const bad=[ParameterBinding.parse({parameterKey:'n',value:{kind:'literal',quantity:{value:3,unit:'second'}}})];expect(()=>bindParameters(asset,bad,{},[],scenario,NodeId.parse('$model'),true)).toThrow('需要 count');
});
it('keeps boolean/enum bindings typed and rejects numerical substitutions or duplicate bindings',()=>{
  const {scenario,asset}=setup();asset.parameters=[ParameterDef.parse({key:'flag',name:'flag',type:'boolean',unit:'scalar',default:{kind:'boolean',value:true}}),ParameterDef.parse({key:'mode',name:'mode',type:'enum',unit:'scalar',choices:['fast','slow'],default:{kind:'enum',value:'slow'}})];
  const bindings=[ParameterBinding.parse({parameterKey:'mode',value:{kind:'enum',value:'fast'}})];expect(bindParameters(asset,bindings,{},[],scenario,NodeId.parse('leaf')).parameters.map(p=>p.value)).toEqual([{kind:'boolean',value:true},{kind:'enum',value:'fast'}]);
  expect(()=>bindParameters(asset,[...bindings,...bindings],{},[],scenario,NodeId.parse('leaf'))).toThrow('重复');
  expect(()=>bindParameters(asset,[ParameterBinding.parse({parameterKey:'mode',value:{kind:'literal',quantity:{value:1,unit:'scalar'}}})],{},[],scenario,NodeId.parse('leaf'))).toThrow('不接受数值表达式');
});
