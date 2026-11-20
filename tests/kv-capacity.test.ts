import { describe,expect,it } from 'vitest';
import { DeviceTopology,StateSpec,StorageSpec } from '@model-analyser/contracts';
import { estimateKvCapacity } from '@model-analyser/core';
import { solveKvSlots } from '../packages/core/src/kv-capacity-slots.js';
import { makeDecodeProject } from '../scripts/decode-project.js';
import { makeDeepSeekProject,makeQwenProject } from '../scripts/model-project.js';
import { makeGqaProject } from '../scripts/gqa-project.js';
import { makeCompressionProject } from '../scripts/compression-project.js';
import { makeNamedParallelProject } from '../scripts/named-parallel-project.js';
import { c01Project } from './model-fixtures.js';

function stateTensor(windowed=false){
  const project=makeDecodeProject(c01Project(),windowed);
  const model=project.assetSnapshots.find(asset=>asset.definition.kind==='model');
  if(model?.definition.kind!=='model')throw Error('Missing synthetic cache model');
  const graph=model.definition.graph,cache=graph.storages.find(storage=>storage.storageId==='cache'),tensor=graph.tensors[0];
  if(!cache||!tensor)throw Error('Missing declared cache');
  cache.allocation={kind:'tensor',shape:tensor.shape,dtype:tensor.dtype};
  const scenario=project.scenarios[0];
  if(!scenario)throw Error('Missing synthetic configuration');
  return {scenario,assets:project.assetSnapshots,cache};
}

describe('KV capacity',()=>{
  it('reports the authored DCP slot limit and bytes per physical slot',async()=>{
    const {project}=await makeNamedParallelProject('dcp2');
    const result=await estimateKvCapacity(project.scenarios[0]!,project.assetSnapshots);
    expect(result).toMatchObject({status:'available',report:{budget:{status:'fixed'},
      fixedSlotsPerRequest:8,referenceTokensPerRequest:6,currentKvBytes:128,averageBytesPerToken:16}});
  });

  it('sizes the completed groups in the original dynamic compression preset',async()=>{
    const project=makeCompressionProject(2,'prefill');
    const result=await estimateKvCapacity(project.scenarios[0]!,project.assetSnapshots);
    expect(result).toMatchObject({status:'available',report:{
      rowProfile:{groupSizes:[2]},referenceTokensPerRequest:5,currentKvBytes:18,averageBytesPerToken:3.6,
      budget:{status:'available',tokensPerRequest:455,more:[{bytes:9}]},
    }});
  });

  it('sizes complete single-card KV storage using the peak from multi-stream execution',async()=>{
    const {project}=await makeGqaProject('tp-heads');
    const scenario=project.scenarios[0]!;
    scenario.deviceTopology={devices:scenario.deviceTopology.devices.slice(0,1),groups:[]};
    scenario.parallelPlan={assignments:[],communications:[],assumptions:[]};
    scenario.executionPlan={kind:'streams',assignments:[],extraDependencies:[],resourcePolicy:{kind:'ideal'}};
    const capacity=await estimateKvCapacity(scenario,project.assetSnapshots);
    if(capacity.status!=='available')throw Error(capacity.message);
    expect(capacity.report).toMatchObject({averageBytesPerToken:16,budget:{status:'available',more:[{bytes:16}]}});
    const device=capacity.report.devices[0]!;
    expect(device.nonKvBytes).toBeGreaterThan(0);
    expect(capacity.report.budget).toMatchObject({
      tokensPerRequest:Math.floor((device.capacityBytes-device.nonKvBytes!)/16),
    });
  });

  it('preserves real Qwen layer count, KV heads and BF16 width in the budget',async()=>{
    const p=makeQwenProject({kind:'decode',batchSize:1,queryTokensPerRequest:1,contextTokensPerRequest:2,steps:1});
    const result=await estimateKvCapacity(p.scenarios[0]!,p.assetSnapshots);
    if(result.status!=='available')throw Error(result.message);
    const {report}=result;
    const bytesPerToken=28*2*8*128*2;
    expect(report).toMatchObject({stateCount:28,storageCount:56,referenceTokensPerRequest:3,currentKvBytes:3*bytesPerToken,averageBytesPerToken:bytesPerToken});
    const row=report.devices[0];
    if(row?.nonKvBytes===undefined)throw Error('Missing device reserve');
    expect(report.budget).toMatchObject({
      status:'available',tokensPerRequest:Math.floor((row.capacityBytes-row.nonKvBytes)/bytesPerToken),
      more:[{deviceId:row.deviceId,bytes:bytesPerToken}],
    });
  });

  it('uses the declared MLA latent and RoPE cache widths instead of a GQA formula',async()=>{
    const p=makeDeepSeekProject('absorbed');
    const result=await estimateKvCapacity(p.scenarios[0]!,p.assetSnapshots);
    if(result.status!=='available')throw Error(result.message);
    const bytesPerToken=27*(512+64)*2;
    expect(result.report).toMatchObject({stateCount:27,referenceTokensPerRequest:3,averageBytesPerToken:bytesPerToken,currentKvBytes:3*bytesPerToken});
    expect(result.report.budget.status).toBe('available');
  });

  it('uses the actual TP layouts to distinguish sharded KV from replicated KV on the same two devices',async()=>{
    const cases=[
      {id:'tp-heads',bytes:24,perToken:16,reserve:256,maximum:96},
      {id:'tp-kv-replicated',bytes:48,perToken:32,reserve:320,maximum:44},
    ];
    for(const {id,bytes,perToken,reserve,maximum} of cases){
      const {project}=await makeGqaProject(id);
      const result=await estimateKvCapacity(project.scenarios[0]!,project.assetSnapshots);
      if(result.status!=='available')throw Error(result.message);
      expect(result.report.averageBytesPerToken).toBe(perToken);
      expect(result.report.devices.map(row=>[row.deviceId,row.kvBytes,row.nonKvBytes])).toEqual([['gpu0',bytes,reserve],['gpu1',bytes,reserve]]);
      expect(result.report.budget).toMatchObject({status:'available',tokensPerRequest:maximum});
    }
  });

  it('uses the actual final Decode reservation and quantized slot plateaus',async()=>{
    const {scenario,assets,cache}=stateTensor();
    if(cache.allocation.kind!=='tensor')throw Error('Missing synthetic tensor allocation');
    cache.allocation.quantization={payloadBits:4,packingUnitElements:4,alignmentBytes:4,auxiliaries:[
      {name:'scale',dtype:{category:'float',bits:16,format:'bf16'},count:{kind:'group',groupSize:4}},
    ]};
    const result=await estimateKvCapacity(scenario,assets);
    if(result.status!=='available')throw Error(result.message);
    expect(result.report).toMatchObject({decodeStep:2,referenceTokensPerRequest:5,currentKvBytes:8,averageBytesPerToken:1.6});
    expect(result.report.devices[0]).toMatchObject({capacityBytes:18,nonKvBytes:8,kvBytes:8});
    // 5–8 slots use 4 payload bytes and two FP16 scales. Nine slots allocate 8 + 6 bytes.
    expect(result.report.budget).toMatchObject({status:'available',tokensPerRequest:8,stride:1,more:[{bytes:0}]});
  });

  it('reports a windowed cache footprint without pretending it grows as an append-only cache',async()=>{
    const {scenario,assets}=stateTensor(true);
    const result=await estimateKvCapacity(scenario,assets);
    if(result.status!=='available')throw Error(result.message);
    expect(result.report).toMatchObject({
      referenceTokensPerRequest:3,currentKvBytes:6,averageBytesPerToken:2,
      budget:{status:'unavailable',reason:expect.stringContaining('窗口')},
    });
  });

  it('keeps other persistent buffers in the fixed non-KV reserve',async()=>{
    const {scenario,assets}=stateTensor();
    const model=assets.find(asset=>asset.definition.kind==='model');
    if(model?.definition.kind!=='model')throw Error('Missing synthetic model');
    model.definition.graph.storages.push(StorageSpec.parse({
      storageId:'recurrent',name:'Fixed recurrent state',category:'state',sharingDomain:'request',
      allocation:{kind:'bytes',value:{kind:'literal',quantity:{value:2,unit:'byte'}}},
    }));
    model.definition.graph.states.push(StateSpec.parse({
      stateId:'recurrent',name:'Separate persistent state',stateKind:'recurrent',storageIds:['recurrent'],
      creator:{kind:'initialized'},readers:[],writers:[],updatePolicy:{kind:'static'},
    }));
    const result=await estimateKvCapacity(scenario,assets);
    if(result.status!=='available')throw Error(result.message);
    expect(result.report.devices[0]).toMatchObject({kvBytes:10,otherStateBytes:2,nonKvBytes:10,capacityBytes:18});
    expect(result.report.budget).toMatchObject({status:'available',tokensPerRequest:4});
  });

  it('solves the tightest physical device and enforces the token-shard stride',()=>{
    const topology=DeviceTopology.parse({
      devices:['gpu0','gpu1'].map(deviceId=>({deviceId,hardware:{assetId:'example:hardware',revision:1,kind:'hardware'}})),
      groups:[{groupId:'pcp',members:['gpu0','gpu1'],mesh:{axes:[{axisId:'pcp',size:2}],coordinates:[
        {deviceId:'gpu0',coordinates:[0]},{deviceId:'gpu1',coordinates:[1]},
      ]}}],
    });
    const spec=StorageSpec.parse({storageId:'kv',name:'KV',category:'state',sharingDomain:'request',
      allocation:{kind:'tensor',shape:[{axisId:'token',semantic:'token',size:{kind:'literal',quantity:{value:4,unit:'count'}}}],
        dtype:{category:'float',bits:16,format:'bf16'}}});
    if(spec.allocation.kind!=='tensor')throw Error('Missing fixture allocation');
    const result=solveKvSlots([{
      spec:{...spec,allocation:spec.allocation},tokenAxis:'token',
      distribution:{kind:'sharded',groupId:'pcp',axes:[{tensorAxisId:'token',meshAxisId:'pcp'}],policy:{kind:'even'}},
    }],topology,[
      {deviceId:'gpu0',capacityBytes:14,nonKvBytes:8,currentKvBytes:4},
      {deviceId:'gpu1',capacityBytes:40,nonKvBytes:8,currentKvBytes:4},
    ],4);
    expect(result).toMatchObject({status:'available',tokensPerRequest:6,stride:2,limitingDeviceIds:['gpu0'],more:[{bytes:2},{bytes:2}]});
  });

  it('uses grouped cache plateaus and preserves the entire fixed ring reservation',()=>{
    const topology=DeviceTopology.parse({devices:[{deviceId:'gpu0',hardware:{assetId:'example:hardware',revision:1,kind:'hardware'}}],groups:[]});
    const storage=(storageId:string,length:number)=>{
      const spec=StorageSpec.parse({storageId,name:storageId,category:'state',sharingDomain:'request',
        allocation:{kind:'tensor',shape:[
          {axisId:'t',semantic:'token',size:{kind:'literal',quantity:{value:length,unit:'count'}}},
          {axisId:'d',semantic:'hidden',size:{kind:'literal',quantity:{value:2,unit:'count'}}},
        ],dtype:{category:'float',bits:16,format:'bf16'}}});
      if(spec.allocation.kind!=='tensor')throw Error('Missing test tensor');
      return {...spec,allocation:spec.allocation};
    };
    const ring={spec:storage('ring',2),tokenAxis:'t',rows:{kind:'fixed',rows:2}} as const;
    const rows=[ring,{spec:storage('latent',0),tokenAxis:'t',rows:{kind:'grouped',tokensPerRow:4}} as const];
    const device={deviceId:'gpu0',capacityBytes:26,nonKvBytes:10,currentKvBytes:8};
    expect(solveKvSlots(rows,topology,[device],3)).toMatchObject({status:'available',tokensPerRequest:11,more:[{bytes:4}]});
    expect(solveKvSlots(rows,topology,[{...device,capacityBytes:17}],3)).toMatchObject({status:'no_room',reason:'fixed_cache'});
    expect(solveKvSlots([ring],topology,[device],3)).toMatchObject({status:'fixed',more:[{bytes:0}]});
  });
});
