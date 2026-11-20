import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { ProjectDocument,Scenario,TensorSpec,StorageSpec,DeviceTopology,CommunicationDefinition,MetricScope } from '@model-analyser/contracts';
import { allocateDistributedStorage,evaluateCommunication,resolveParallelPlan,ENGINE_VERSION } from '@model-analyser/core';

const project=ProjectDocument.parse(JSON.parse(await readFile('examples/contracts/project.json','utf8')) as unknown),hardware=project.assetSnapshots.find(a=>a.definition.kind==='hardware');
if(!hardware)throw Error('Missing synthetic reference hardware');
const topology=DeviceTopology.parse({devices:[0,1,2,3].map(i=>({deviceId:'gpu'+i,hardware:{assetId:hardware.assetId,revision:hardware.revision,kind:'hardware'}})),groups:[
  {groupId:'tp',members:['gpu0','gpu1'],mesh:{axes:[{axisId:'tp',size:2}],coordinates:[{deviceId:'gpu0',coordinates:[0]},{deviceId:'gpu1',coordinates:[1]}]}},
  {groupId:'ring',members:['gpu0','gpu1','gpu2','gpu3']},
]});
const tensor=TensorSpec.parse({tensorId:'kv',name:'C03 ordinary BF16 KV',storageId:'kv-storage',dtype:{category:'float',bits:16,format:'bf16'},shape:[['kv',2],['batch',2],['token',16],['head',2],['dim',4]].map(([axisId,value])=>({axisId,semantic:'custom',size:{kind:'literal',quantity:{value,unit:'count'}}}))});
const storage=StorageSpec.parse({storageId:tensor.storageId,name:tensor.name,category:'state',sharingDomain:'device_group',allocation:{kind:'tensor',shape:tensor.shape,dtype:tensor.dtype}}),context={symbols:{},assets:project.assetSnapshots};
const sharded=allocateDistributedStorage(storage.storageId,[storage],{kind:'sharded',groupId:'tp',axes:[{tensorAxisId:'head',meshAxisId:'tp'}],policy:{kind:'even'}},topology,context),replicated=allocateDistributedStorage(storage.storageId,[storage],{kind:'replicated',groupId:'tp'},topology,context);
const collective=CommunicationDefinition.parse({operation:'all_reduce',groupId:'ring',source:{tensorId:tensor.tensorId,distribution:{kind:'partial',groupId:'ring',reduceOperation:'sum'}},destination:{tensorId:tensor.tensorId,distribution:{kind:'replicated',groupId:'ring'}},payloadDtype:tensor.dtype,sendBytesPerMember:{kind:'literal',quantity:{value:1000,unit:'byte'}},receiveBytesPerMember:{kind:'literal',quantity:{value:1000,unit:'byte'}},algorithm:{name:'Explicit assumed ring factor 2*(4-1)/4 and 3 startup rounds',trafficFactor:1.5,startupRounds:3},timing:{kind:'bandwidth_latency',bytePerSecond:1e6,latencySeconds:0.001}});
const communication=evaluateCommunication(collective,MetricScope.parse({phase:'decode',target:{kind:'node',nodeId:'reference-all-reduce'},deviceIds:topology.devices.map(d=>d.deviceId),aggregation:'group_total'}),[tensor],topology,context);
if(sharded.status!=='available'||replicated.status!=='available'||communication.status!=='available')throw Error(JSON.stringify({sharded,replicated,communication}));
const bytes=(result:typeof sharded.result)=>result.perDevice.map(p=>p.totalBytes.status==='available'?p.totalBytes.quantity.value:null);
if(JSON.stringify(bytes(sharded.result))!=='[512,512]'||JSON.stringify(bytes(replicated.result))!=='[1024,1024]')throw Error('C03 reference does not match the documented arithmetic');
const time=communication.result.cost.seconds,traffic=communication.result.cost.communications[0];
if(time.status!=='available'||Math.abs(time.quantity.value-0.0045)>1e-12||traffic?.algorithmTrafficBytesPerMember.status!=='available'||traffic.algorithmTrafficBytesPerMember.quantity.value!==1500||traffic.groupSendBytes.status!=='available'||traffic.groupSendBytes.quantity.value!==4000)throw Error('Ring reference does not match the explicit algorithm arithmetic');
await mkdir('examples/computed',{recursive:true});
await writeFile('examples/computed/distributed-reference.json',JSON.stringify({description:'Independent synthetic comparisons, not a complete distributed model analysis or real device benchmark. C03 KV arithmetic comes from docs/DATA_CONTRACT_DETAILS.md. Ring payload, bandwidth and latency are explicit mathematical assumptions. Missing local HBM/reduction work is intentionally diagnosed.',engineVersion:ENGINE_VERSION,topology,tensor,sharded,replicated,communication},null,2)+'\n');
console.log('C03: sharded 512 bytes/device; replicated 1024 bytes/device. Ring: 1500 algorithm bytes/member, 4000 group payload bytes, 4.5 ms collective span. Full evidence: examples/computed/distributed-reference.json');
const original=project.scenarios[0];if(!original)throw Error('Missing reference scenario');
const layout={kind:'sharded',groupId:'tp',axes:[{tensorAxisId:'col',meshAxisId:'tp'}],policy:{kind:'even'}};
const scenario=Scenario.parse({...original,scenarioId:'example:scenario:parallel-resolution',name:'Synthetic two-device GEMM weight layout',deviceTopology:{devices:topology.devices.slice(0,2),groups:topology.groups.filter(g=>g.groupId==='tp')},parallelPlan:{assignments:[{selector:{kind:'subtree',rootNodeId:'$model'},phases:['decode'],tensorDistributions:[{tensorId:'W',distribution:layout}],storageDistributions:[{storageId:'sW',distribution:layout}]}],communications:[],assumptions:['Only weight placement is declared. The unassigned activations, local compute and whole-model schedule are not inferred.']}});
const portable=ProjectDocument.parse({...project,projectId:'example:project:parallel-resolution',name:'Synthetic two-device layout reference',scenarios:[scenario],measurements:[]}),resolution=await resolveParallelPlan(scenario,portable.assetSnapshots);
if(resolution.status!=='available'||resolution.result.deviceAllocations.length!==2||resolution.result.deviceAllocations.some(d=>d.knownBytes.status!=='available'||d.knownBytes.quantity.value!==128))throw Error('Scope/layout reference does not match 128 weight bytes per device');
await writeFile('examples/computed/parallel-plan-project.json',JSON.stringify(portable,null,2)+'\n');
await writeFile('examples/computed/parallel-plan-result.json',JSON.stringify(resolution,null,2)+'\n');
console.log('Scope reference: two physical devices, 128 weight bytes each. Import examples/computed/parallel-plan-project.json and select the layout preview; result evidence: examples/computed/parallel-plan-result.json');
