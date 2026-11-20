import { AssetDocument,ProjectDocument,Scenario,DeviceId,type ParallelPresetTemplate } from '@model-analyser/contracts';
import { previewParallelPreset } from '@model-analyser/core';
import { makeUlyssesProject } from './ulysses-project.js';
import { makeMoeProject } from './moe-project.js';
import { makeContextParallelProject } from './context-parallel-project.js';
import { makePipelineParallelProject } from './pipeline-parallel-project.js';
import { ref } from './model-authoring.js';

export type NamedParallelKind='sp2'|'ep2'|'ep2-tp2'|'pcp2'|'dcp2'|'pp2';
const specs={
  sp2:{name:'SP2 · sequence → heads → sequence',description:'两张实际设备上的 Ulysses 式 MHA 前向子图：token 分片 → Q/K/V 三次 AllToAll → head 分片 attention → AllToAll → token 分片。非因果、物化 SDPA、past=0；含投影与残差，不代表完整 LLM。',phases:['prefill']},
  ep2:{name:'EP2 · top-2 expert dispatch/combine',description:'两张实际设备上的 E4/K2 MoE 子图：token 分片、每 owner 两个常驻专家、显式 packet dispatch/combine。平衡路由由作者固定；不从 router 分数猜测，TP=1。',phases:['prefill','decode']},
  'ep2-tp2':{name:'EP2 × TP2 · four physical devices',description:'四张实际设备上的 E4/K2 MoE 子图：复用 world/grid，两个 owner 的 TP2 子组；显式 AllToAll、AllGather、ReduceScatter 和非均匀逐卡 payload。ep×tp 仅描述已列明 mesh，不创建额外设备。',phases:['prefill','decode']},
  pcp2:{name:'PCP2 · causal queries / replicated KV',description:'两张实际设备：连续均匀分片 prefill 查询及投影，K/V AllGather 后写入完整复制的 KV；attention 保留各查询片的全局因果起点。输出仍按查询分片，非 head-tail 负载均衡；独立 attention 子图。',phases:['prefill']},
  dcp2:{name:'DCP2 · stable softmax / fixed KV slots',description:'两张实际设备：固定容量 M 的 KV 沿序列均匀分片，槽位归属跨步不变；Q/权重复制并计重复投影，当前有效前缀参与 attention，max/分母/分子三次归约后归一化。每步仅1个查询 token；独立 attention 子图。',phases:['decode']},
  pp2:{name:'PP2 · two attention stages / one microbatch',description:'两张实际设备各驻留一个完整 GQA attention/residual 阶段的权重和 KV，通过一次 BF16 SendRecv 传递中间激活。单 microbatch 串行遍历两阶段，不宣称流水重叠或完整语言模型。',phases:['prefill','decode']}
} as const;

/** New roots reuse existing fixed research modules and formulas byte-for-byte. */
export function makeNamedParallelBase(kind:NamedParallelKind,ids?:string[]):ProjectDocument{
  const source=kind==='sp2'?makeUlyssesProject(2):kind==='pcp2'?makeContextParallelProject('pcp'):kind==='dcp2'?makeContextParallelProject('dcp'):kind==='pp2'?makePipelineParallelProject():makeMoeProject(kind==='ep2'?1:2),s=source.scenarios[0];if(!s)throw Error();
  const old=source.assetSnapshots.find(a=>a.assetId===s.model.assetId&&a.revision===s.model.revision);if(!old)throw Error();
  const spec=specs[kind],preset:ParallelPresetTemplate={presetId:kind,name:spec.name,description:spec.description,strategy:'declared_plan',phases:[...spec.phases],tensorShards:[],reductions:[],assumptions:[spec.description,'Fixed degree: device slots are bound in the selected physical group member order. All workload-dependent formulas remain live; no implicit communication HBM or reduction arithmetic.'],declaredPlan:{deviceSlots:s.deviceTopology.devices.map(d=>d.deviceId),groups:s.deviceTopology.groups,plan:s.parallelPlan}};
  const model=AssetDocument.parse({...old,assetId:'builtin:model:parallel-'+kind,revision:1,name:spec.name+' · authored subgraph',description:spec.description,tags:[...old.tags,'parallel-shortcut'],parallelPresets:[preset]});
  const members=(ids??s.deviceTopology.devices.map((_,i)=>'rack-A/device-'+(i+1))).map(id=>DeviceId.parse(id));if(members.length!==s.deviceTopology.devices.length)throw Error('Wrong physical pool size');
  const scenario=Scenario.parse({...s,model:ref(model),name:spec.name,deviceTopology:{devices:s.deviceTopology.devices.map((d,i)=>({...d,deviceId:members[i]})),groups:[{groupId:'physical-pool',members}]},parallelPlan:{assignments:[],communications:[],assumptions:[]}});
  return ProjectDocument.parse({...source,projectId:'example:project:parallel-'+kind,projectRevision:1,name:spec.name,scenarios:[scenario],assetSnapshots:[...source.assetSnapshots.filter(a=>a!==old),model]});
}
export async function makeNamedParallelProject(kind:NamedParallelKind){
  const project=makeNamedParallelBase(kind),s=project.scenarios[0];if(!s)throw Error();const attempt=await previewParallelPreset({scenario:s,assets:project.assetSnapshots,presetId:kind,groupId:'physical-pool',meshAxisId:'bound',network:{bytesPerSecond:1000,latencySeconds:.001}});if(attempt.status!=='available')throw Error(attempt.message);
  return {project:ProjectDocument.parse({...project,scenarios:[attempt.preview.scenario],assetSnapshots:attempt.preview.assets}),preview:attempt.preview};
}
