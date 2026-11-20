import { describe,it,expect } from 'vitest';
import { readFileSync,readdirSync } from 'node:fs';
import { z } from 'zod';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { AssetDocument,Scenario,ProjectDocument,AnalysisResult,CapacityStatus,MetricValue,NodeId,TensorId,NumericOverride } from '@model-analyser/contracts';
import { validateAssets,validateProject } from '../packages/contracts/src/validation.js';
import { validateScenario } from '../packages/contracts/src/scenario-validation.js';
import { validateResult } from '../packages/contracts/src/result-validation.js';
import { contractJsonSchema } from '../packages/contracts/src/json-schema.js';
const read=(path:string):unknown=>JSON.parse(readFileSync('examples/contracts/'+path,'utf8')) as unknown;
const project=()=>ProjectDocument.parse(read('project.json'));
const result=()=>AnalysisResult.parse(read('result.json'));
const scenario=()=>Scenario.parse(read('scenario.json'));
describe('complete examples and result boundaries',()=>{
  it('provides one valid specimen for every asset kind, and a portable project/result chain',()=>{
    const assets=readdirSync('examples/contracts/assets').map(f=>AssetDocument.parse(read('assets/'+f)));
    expect(new Set(assets.map(a=>a.definition.kind)).size).toBe(7);expect(validateAssets(assets)).toEqual([]);expect(validateProject(project())).toEqual([]);expect(validateResult(result())).toEqual([]);
  });
  it('rejects wrong result units and unknown fields with the same exported JSON Schema',()=>{
    const ajv=new Ajv2020({strict:false,inlineRefs:false,code:{optimize:false}});addFormats(ajv);const validate=ajv.compile(contractJsonSchema(AnalysisResult));
    const good=result(),wrong=structuredClone(good);if(wrong.total.seconds.status==='available')Reflect.set(wrong.total.seconds.quantity,'unit','byte');
    for(const input of [good,wrong,{...good,extra:0},{...good,phase:'training'}])expect(Boolean(validate(input))).toBe(AnalysisResult.safeParse(input).success);
    expect(AnalysisResult.safeParse(wrong).success).toBe(false);
  });
  it('does not turn unavailable node costs into a complete numeric sum or anonymous zero',()=>{
    const input=result();input.total.seconds=MetricValue.options[1].parse({status:'unavailable',diagnosticIds:['missing-hardware']});
    expect(validateResult(input).map(d=>d.code)).toContain('missing_reference');
    input.diagnostics.push({diagnosticId:'missing-hardware',severity:'error',code:'missing_reference',message:'No matching compute capability',location:{kind:'scenario',scenarioId:input.scenarioId}});
    expect(validateResult(input)).toEqual([]);expect(MetricValue.safeParse({status:'unavailable',diagnosticIds:[]}).success).toBe(false);
  });
  it('rejects a complete available aggregate when a contributing leaf is unavailable',()=>{
    const input=result(),node=input.nodes[0];if(!node)throw Error();node.cost.hbmBytes={status:'unavailable',diagnosticIds:['missing-hbm']};
    input.diagnostics.push({diagnosticId:'missing-hbm',severity:'error',code:'missing_hbm_estimate',message:'HBM estimate missing',location:{kind:'node',nodeId:node.nodeId}});
    expect(validateResult(input).filter(d=>d.code==='invalid_cost')).toHaveLength(2);
  });
  it('validates output arithmetic, scopes and timeline references independently of structure',()=>{
    const input=result(),point=input.roofline[0],peak=input.memory[0],entry=input.schedule[0];if(!point||!peak||!entry)throw Error();
    point.arithmeticIntensity={status:'available',operationsPerByte:999};entry.endSeconds=-1;
    expect(AnalysisResult.safeParse(input).success).toBe(false);entry.endSeconds=0;entry.startSeconds=1;entry.nodeId=NodeId.parse('missing');
    if(peak.peakBytes.status==='available')peak.peakBytes.quantity.value=1;
    expect(validateResult(input).map(d=>d.code)).toEqual(expect.arrayContaining(['invalid_cost','invalid_schedule','missing_reference']));
  });
  it('retains all capacity branches and rejects a solved value outside its declared interval',()=>{
    for(const candidate of [{kind:'solved',fixedVariables:[],solveVariable:'batch',maximum:32,searchRange:{min:1,max:64},limitingDeviceIds:['gpu0']},{kind:'point_only',description:'non-monotonic'},{kind:'unavailable',diagnosticIds:['capacity-missing']}])expect(CapacityStatus.safeParse(candidate).success).toBe(true);
    const input=result(),memory=input.memory[0];if(!memory)throw Error();memory.capacityStatus=CapacityStatus.parse({kind:'solved',fixedVariables:[],solveVariable:'batch',maximum:128,searchRange:{min:1,max:64},limitingDeviceIds:['gpu0']});expect(validateResult(input).map(d=>d.code)).toContain('invalid_capacity');
  });
  it('checks override target whitelist and units instead of accepting arbitrary patch paths',()=>{
    const input=scenario();input.numericOverrides.push(NumericOverride.parse({target:{kind:'storage',storageId:'sW'},field:'fixed_seconds',value:{value:5,unit:'byte'}}));
    expect(validateScenario(input,project().assetSnapshots).map(d=>d.code)).toEqual(expect.arrayContaining(['invalid_override','invalid_unit']));
    expect(NumericOverride.safeParse({target:{kind:'storage',storageId:'sW'},field:'allocation.dtype.bits',value:{value:4,unit:'count'}}).success).toBe(false);
  });
  it('checks physical mesh mapping and unresolved partial objects',()=>{
    const input=scenario();input.deviceTopology.groups[0]?.members.push(input.deviceTopology.devices[0]?.deviceId??(()=>{throw Error();})());
    expect(validateScenario(input,project().assetSnapshots).map(d=>d.code)).toContain('duplicate_id');
    input.parallelPlan.assignments.push({selector:{kind:'nodes',nodeIds:[NodeId.parse('module/op')]},phases:['decode'],tensorDistributions:[{tensorId:TensorId.parse('Y'),distribution:{kind:'partial',groupId:'tp',reduceOperation:'sum'}}],storageDistributions:[]});
    expect(validateScenario(input,project().assetSnapshots).map(d=>d.code)).toContain('unresolved_partial');
  });
  it('checks byte/second formula calls and negative or unsafe shape literals before execution',()=>{
    const p=project(),model=p.assetSnapshots.find(a=>a.definition.kind==='model');if(model?.definition.kind!=='model')throw Error();const storage=model.definition.graph.storages[0],axis=model.definition.graph.tensors[0]?.shape[0];if(!storage||!axis)throw Error();
    storage.allocation={kind:'bytes',value:{kind:'literal',quantity:{value:8,unit:'second'}}};axis.size={kind:'literal',quantity:{value:-1,unit:'count'}};
    expect(validateAssets([model],p.assetSnapshots).map(d=>d.code)).toEqual(expect.arrayContaining(['invalid_unit','invalid_shape']));
  });
});
