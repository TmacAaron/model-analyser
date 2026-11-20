import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { AssetDocument,Scenario,ProjectDocument,AnalysisResult,CapacitySearchRequest,Quantity,MetricValue,ComputeClass } from '@model-analyser/contracts';
import { validateAssets,validateProject } from '../packages/contracts/src/validation.js';
import { validateResult } from '../packages/contracts/src/result-validation.js';

const literal=(value:number,unit:z.infer<typeof Quantity>['unit'])=>({kind:'literal' as const,quantity:{value,unit}});
const symbol=(name:string)=>({kind:'symbol' as const,name});
const ref=(assetId:string,kind:z.infer<typeof AssetDocument>['definition']['kind'])=>({assetId,revision:1,kind});
const bf16={category:'float',bits:16,format:'bf16'} as const,fp32={category:'float',bits:32,format:'fp32'} as const;
const computeClass=ComputeClass.parse({arithmetic:'float',inputDtypes:[bf16,bf16],multiplyDtype:bf16,accumulateDtype:fp32,resource:'matrix'});
const parameters=['M','N','K'].map((key,i)=>({key,name:key,type:'integer',unit:'count',min:1,default:{kind:'integer',value:[4,8,16][i]}}));
const shell={documentType:'asset',schemaVersion:1,revision:1,tags:['contract-example'],sources:[{kind:'note',text:'Synthetic C01 contract example, not a production hardware/model preset.'}]};
const gemm=AssetDocument.parse(JSON.parse(await readFile('assets/builtin/formula/gemm.json','utf8')) as unknown);
const bytes=AssetDocument.parse({...shell,assetId:'example:formula:matrix-bytes',name:'BF16 矩阵 bytes',parameters:[],definition:{kind:'formula',formula:{inputs:{rows:{unit:'count',integerRequired:true,min:1},cols:{unit:'count',integerRequired:true,min:1}},expression:'rows * cols * 2',output:{unit:'byte',integerRequired:true,nonNegative:true},description:'C01 BF16 matrix storage bytes'}}});
const shape=(rows:string,cols:string)=>[{axisId:'row',semantic:'custom',size:symbol(rows)},{axisId:'col',semantic:'custom',size:symbol(cols)}];
const tensors=[['X','M','K'],['W','K','N'],['Y','M','N']].map(([id,rows,cols])=>({tensorId:id,name:id,shape:shape(rows??'',cols??''),dtype:bf16,storageId:'s'+id}));
const storages=tensors.map(t=>({storageId:t.storageId,name:t.name,category:t.tensorId==='W'?'weight':'activation',allocation:{kind:'tensor',shape:t.shape,dtype:bf16},sharingDomain:t.tensorId==='W'?'instance':'request'}));
const inputs=[{portId:'x',tensorId:'X'},{portId:'w',tensorId:'W'}],outputs=[{portId:'y',tensorId:'Y'}];
const timing={kind:'roofline_bound',computeEfficiency:1,memoryEfficiency:1,computeMemoryOverlap:'ideal',launchSeconds:0};
const operations={kind:'formula',call:{formula:ref(gemm.assetId,'formula'),bindings:{M:symbol('M'),N:symbol('N'),K:symbol('K')}}};
const memoryAccess=[['X','M','K'],['W','K','N'],['Y','M','N']].map(([id,rows,cols])=>({accessId:'access'+id,storageId:'s'+id,mode:id==='Y'?'write':'read',logicalBytes:{kind:'formula',call:{formula:ref(bytes.assetId,'formula'),bindings:{rows:symbol(rows??''),cols:symbol(cols??'')}}},hbmEstimate:{kind:'factor',value:1}}));
const op=AssetDocument.parse({...shell,assetId:'example:operator:gemm',name:'C01 GEMM',parameters,definition:{kind:'operator',operator:{category:'linear',inputs,outputs,tensors,storages,states:[],phases:['prefill','decode'],cost:{compute:[{segmentId:'matmul',computeClass,usefulOperations:operations,executedOperations:operations}],memoryAccess,temporaryStorageIds:[],timing}}}});
const graph=(id:string,asset:AssetDocument,kind:'operator'|'module')=>({inputs,outputs,tensors,storages,states:[],dependencies:[],nodes:[{nodeId:id,name:id,phases:['prefill','decode'],portBindings:[...inputs,...outputs],stateBindings:[],body:{kind,asset:ref(asset.assetId,kind),bindings:['M','N','K'].map(parameterKey=>({parameterKey,value:symbol(parameterKey)}))}}],edges:[
  ...inputs.map(p=>({edgeId:p.portId,from:{kind:'graph_input',portId:p.portId},to:{kind:'node',nodeId:id,portId:p.portId},tensorId:p.tensorId})),
  {edgeId:'y',from:{kind:'node',nodeId:id,portId:'y'},to:{kind:'graph_output',portId:'y'},tensorId:'Y'},
]});
const module=AssetDocument.parse({...shell,assetId:'example:module:gemm',name:'C01 GEMM module',parameters,definition:{kind:'module',graph:graph('op',op,'operator')}});
const model=AssetDocument.parse({...shell,assetId:'example:model:gemm',name:'C01 GEMM model',parameters,definition:{kind:'model',family:'synthetic',variant:'C01',graph:graph('module',module,'module')}});
const hardware=AssetDocument.parse({...shell,assetId:'example:hardware:c01',name:'C01 人工硬件',parameters:[],definition:{kind:'hardware',hardware:{capacityBytes:4096,computeCapabilities:[{computeClass,kind:'peak',operationsPerSecond:1000}],memoryCapabilities:[{key:'hbm',kind:'peak',bytesPerSecond:100}],communicationDefaults:[]}}});
const parallel=AssetDocument.parse({...shell,assetId:'example:parallel:replicated',name:'复制布局样例',parameters:[],definition:{kind:'parallel',plan:{assignments:[{selector:{kind:'nodes',nodeIds:['module/op']},phases:['decode'],tensorDistributions:[{tensorId:'X',distribution:{kind:'replicated',groupId:'tp'}}],storageDistributions:[]}],communications:[],assumptions:['Example selector and group are bound by the consuming scenario.']}}});
const quantization=AssetDocument.parse({...shell,assetId:'example:quantization:w4',name:'C02 W4 group32',parameters:[],definition:{kind:'quantization',quantization:{selector:{kind:'nodes',nodeIds:['module/op']},weight:{payloadBits:4,packingUnitElements:1,alignmentBytes:1,auxiliaries:[{name:'scale',dtype:{category:'float',bits:16,format:'fp16'},count:{kind:'group',groupSize:32}}]}}}});
const assets=[gemm,bytes,op,module,model,hardware,parallel,quantization];
const scenario=Scenario.parse({scenarioId:'example:scenario:c01',name:'C01',model:ref(model.assetId,'model'),bindings:[],workload:{kind:'decode',batchSize:1,contextTokensPerRequest:0,queryTokensPerRequest:1,steps:1},deviceTopology:{devices:[{deviceId:'gpu0',hardware:ref(hardware.assetId,'hardware')}],groups:[{groupId:'tp',members:['gpu0']}]},parallelPlan:{assignments:[],communications:[],assumptions:[]},executionPlan:{kind:'serial'},quantizationOverrides:[],numericOverrides:[],fusionGroups:[]});
const project=ProjectDocument.parse({documentType:'project',schemaVersion:1,projectId:'example:project:c01',projectRevision:1,name:'C01 portable snapshot',scenarios:[scenario],assetSnapshots:assets,measurements:[{measurementId:'example:measurement:c01',scenarioId:scenario.scenarioId,inputHash:'example-input-hash-not-computed',target:{kind:'model'},phase:'decode',deviceIds:['gpu0'],interval:'one call',count:1,time:{kind:'single',seconds:5},source:{kind:'manual'}}],viewState:{nodes:[]}});
const provenance={assetRefs:assets.map(a=>ref(a.assetId,a.definition.kind)),formulaRefs:[ref(gemm.assetId,'formula'),ref(bytes.assetId,'formula')],parameterSources:['M','N','K'].map(parameterKey=>({parameterKey,source:'asset_default'})),assumptions:['HBM factor=1; synthetic hardware; ideal compute-memory overlap.']};
const metric=(value:number,unit:z.infer<typeof Quantity>['unit'])=>MetricValue.parse({status:'available',quantity:{value,unit},basis:'theoretical',provenance,diagnosticIds:[]});
const scope={phase:'decode',target:{kind:'model'},deviceIds:['gpu0'],aggregation:'per_device'};
const cost={scope,compute:[{computeClass,usefulOperations:metric(1024,'operation'),executedOperations:metric(1024,'operation')}],logicalReadBytes:metric(384,'byte'),logicalWriteBytes:metric(64,'byte'),hbmBytes:metric(448,'byte'),communications:[],seconds:metric(4.48,'second')};
const result=AnalysisResult.parse({engineVersion:'contract-example-only',inputHash:'example-input-hash-not-computed',scenarioId:scenario.scenarioId,phase:'decode',scope,total:cost,nodes:[{nodeId:'module/op',cost:{...cost,scope:{...scope,target:{kind:'node',nodeId:'module/op'}}}}],modules:[{nodeId:'module',leafNodeIds:['module/op'],cost:{...cost,scope:{...scope,target:{kind:'module',nodeId:'module'}}}}],memory:[{deviceScope:{kind:'per_device',deviceId:'gpu0'},categoryBreakdown:[{category:'weight',bytes:metric(256,'byte')},{category:'activation',bytes:metric(192,'byte')}],peakBytes:metric(448,'byte'),peakPoint:{kind:'time',seconds:0,nodeId:'module/op'},capacityBytes:4096,capacityStatus:{kind:'point_only',description:'Hand-calculated point; capacity solving has not run.'}}],schedule:[{nodeId:'module/op',deviceScope:{kind:'per_device',deviceId:'gpu0'},streamId:'serial',startSeconds:0,endSeconds:4.48}],roofline:[{scope,computeClass,operations:metric(1024,'operation'),trafficBytes:metric(448,'byte'),arithmeticIntensity:{status:'available',operationsPerByte:16/7},computeCeiling:metric(1000,'operation_per_second'),memoryBandwidth:metric(100,'byte_per_second'),roofPerformance:metric(100*16/7,'operation_per_second'),actualOrPredictedPerformance:metric(1024/4.48,'operation_per_second'),trafficBasis:'estimated_hbm'}],diagnostics:[]});
for(const issues of [validateAssets(assets),validateProject(project),validateResult(result)])if(issues.length)throw Error(JSON.stringify(issues));
await mkdir('examples/contracts/assets',{recursive:true});
for(const asset of assets)await writeFile(`examples/contracts/assets/${asset.definition.kind}-${asset.assetId.split(':').at(-1)}.json`,JSON.stringify(asset,null,2)+'\n');
for(const [name,value] of Object.entries({scenario,project,result}))await writeFile(`examples/contracts/${name}.json`,JSON.stringify(value,null,2)+'\n');
await writeFile('examples/contracts/capacity-request.json',JSON.stringify(CapacitySearchRequest.parse({variable:{kind:'parameter',parameterKey:'M'},searchRange:{min:1,max:100}}),null,2)+'\n');
await writeFile('examples/contracts/hand-calculations.json',JSON.stringify({
  C01:{M:4,N:8,K:16,operations:1024,readBytes:384,writeBytes:64,weightBytes:256,logicalBytes:448,seconds:4.48,measurementSeconds:5,mfu:0.2048,estimatedMbu:0.896},
  C02:{elements128:{payloadBytes:64,scaleBytes:8,totalBytes:72},elements130Tight:{payloadBytes:65,scaleBytes:10,totalBytes:75},elements130Padded32:{payloadBytes:80,scaleBytes:10,totalBytes:90}},
  C03:{batch:2,history:16,kvHeads:2,headDim:4,logicalKvBytes:1024,shardedPerDeviceBytes:512,replicatedPerDeviceBytes:1024,physicalDeviceCount:2},
  C04:{stateBytes:64,readers:2,batch:3,residentBytes:192,readBytes:384},
  C05:{serialSeconds:0.0085,streamsSeconds:0.0065,serialWorkspaceBytes:3*2**30,streamsWorkspaceBytes:5*2**30},
  C06:{description:'See tests/project.test.ts, store.test.ts and scan.test.ts for revision/recovery verification.'},
},null,2)+'\n');
console.log('Generated and validated seven asset kinds, C01 project/result, and C01–C06 hand-calculation inputs.');
