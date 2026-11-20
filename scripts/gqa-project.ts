import { AssetDocument,ProjectDocument,DeviceId,Scenario } from '@model-analyser/contracts';
import { previewParallelPreset } from '@model-analyser/core';
import { makeModelProject } from './model-project.js';
import { matrix,vector } from './model-authoring.js';
import { makeGqaAssets } from './gqa-model.js';

export function makeGqaBaseProject(degree=2,workload:Scenario['workload']={kind:'decode',batchSize:1,contextTokensPerRequest:2,queryTokensPerRequest:1,steps:1}){
  const project=makeModelProject(makeGqaAssets(),workload,'Synthetic GQA complete attention block'),scenario=project.scenarios[0];if(!scenario)throw Error();
  const hardware=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'example:hardware:gqa-hand-reference',revision:1,name:'Synthetic 1024 B · 1000 ops/s · 100 B/s',parameters:[],tags:['synthetic','gqa-reference'],sources:[{kind:'note',text:'Invented rates and capacity for independent arithmetic; not a real device or performance forecast.'}],definition:{kind:'hardware',hardware:{capacityBytes:1024,computeCapabilities:[matrix,vector].map(computeClass=>({computeClass,kind:'peak',operationsPerSecond:1000})),memoryCapabilities:[{key:'hbm',kind:'peak',bytesPerSecond:100}],communicationDefaults:[]}}});
  project.assetSnapshots=[...project.assetSnapshots.filter(a=>a.definition.kind!=='hardware'),hardware];project.projectId='example:project:gqa-base';project.name='GQA attention block · parallel reference';scenario.scenarioId='example:scenario:gqa';scenario.name='GQA';const members=Array.from({length:degree},(_,i)=>DeviceId.parse('gpu'+i));scenario.deviceTopology={devices:members.map(deviceId=>({deviceId,hardware:{assetId:hardware.assetId,revision:1,kind:'hardware'}})),groups:[{groupId:'parallel',members,mesh:{axes:[{axisId:'rank',size:degree}],coordinates:members.map((deviceId,i)=>({deviceId,coordinates:[i]}))}}]};return ProjectDocument.parse(project);
}
export async function makeGqaProject(presetId='tp-heads',degree=2,workload?:Scenario['workload']){
  const project=makeGqaBaseProject(degree,workload),scenario=project.scenarios[0];if(!scenario)throw Error();const attempt=await previewParallelPreset({scenario,assets:project.assetSnapshots,presetId,groupId:'parallel',meshAxisId:'rank',network:{bytesPerSecond:1000,latencySeconds:0.001}});if(attempt.status!=='available')throw Error(attempt.message);project.projectId='example:project:gqa-'+presetId+'-'+degree;project.name='GQA · '+attempt.preview.presetName+' · '+degree+' devices';project.scenarios=[{...attempt.preview.scenario,name:attempt.preview.presetName}];return {project:ProjectDocument.parse(project),preview:attempt.preview};
}
