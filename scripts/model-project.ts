import { AssetDocument,ProjectDocument,Scenario,type AssetDocument as Asset,type Scenario as ScenarioType } from '@model-analyser/contracts';
import { makeQwenAssets } from './qwen-model.js';
import { matrix,vector,ref } from './model-authoring.js';
import { makeDeepSeekAssets,selection } from './deepseek-model.js';

/** Invented hardware isolates arithmetic/capacity checks; never a real GPU preset. */
export function referenceHardware():Asset{return AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'example:hardware:transformer-hand-reference',revision:1,name:'Synthetic 80 GB · 1 TOP/s matrix/vector/selection · 1 TB/s HBM',parameters:[],tags:['synthetic','hand-reference'],sources:[{kind:'note',text:'Invented decimal capacities/rates for independently reproducible arithmetic, not a hardware specification, benchmark or purchasing recommendation.'}],definition:{kind:'hardware',hardware:{capacityBytes:80_000_000_000,computeCapabilities:[matrix,vector,selection].map(computeClass=>({computeClass,kind:'peak',operationsPerSecond:1e12})),memoryCapabilities:[{key:'hbm',kind:'peak',bytesPerSecond:1e12}],communicationDefaults:[]}}});}
export function makeModelProject(assets:Asset[],workload:ScenarioType['workload'],name:string):ProjectDocument{
  const model=assets.find(a=>a.definition.kind==='model');if(!model)throw Error('Model missing');const h=referenceHardware(),scenario=Scenario.parse({scenarioId:'example:scenario:'+model.assetId, name,model:ref(model),bindings:[],workload,deviceTopology:{devices:[{deviceId:'gpu0',hardware:ref(h)}],groups:[]},parallelPlan:{assignments:[],communications:[],assumptions:['One device; no inferred parallelism, fusion or measured kernel efficiency.']},executionPlan:{kind:'serial'},quantizationOverrides:[],numericOverrides:[],fusionGroups:[]});
  return ProjectDocument.parse({documentType:'project',schemaVersion:1,projectId:'example:project:'+model.assetId,projectRevision:1,name,scenarios:[scenario],assetSnapshots:[...assets,h],measurements:[],viewState:{nodes:[]}});
}
export const makeQwenProject=(workload:ScenarioType['workload']={kind:'decode',batchSize:1,contextTokensPerRequest:2,queryTokensPerRequest:1,steps:1})=>makeModelProject(makeQwenAssets(),workload,'Qwen3-0.6B 固定来源单卡理论参考');
export const makeDeepSeekProject=(variant:'expanded'|'absorbed'='expanded',workload:ScenarioType['workload']={kind:'decode',batchSize:1,contextTokensPerRequest:2,queryTokensPerRequest:1,steps:1})=>makeModelProject(makeDeepSeekAssets(variant),workload,'DeepSeek-V2-Lite '+variant+' 固定来源单卡理论参考');
