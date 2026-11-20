import type { ResolvedGraph } from '@model-analyser/contracts';

export type CanvasOperatorGroup={
  id:string;
  name:string;
  ownerScope:string;
  leafIds:string[];
  kind:'operator'|'fusion';
  fusionNodeId?:string;
};

const marker='/$view:';
type AuthoredGroup={key:string;name:string;members:readonly string[]};
const qwenGroups:AuthoredGroup[]=[
  {key:'attention',name:'GQA Attention',members:['qk-norm-rope','cache-update','qk','softmax','av','o-proj']},
  {key:'ffn',name:'SwiGLU',members:['gate-up-proj','silu-multiply','down-proj']},
];
const mlaGroups:AuthoredGroup[]=[
  {key:'attention',name:'MLA Attention',members:['kv-a-norm','rope','q-absorb','kv-b','cache-update','qk','softmax','av','v-up','o-proj']},
];
const v3MoeGroups:AuthoredGroup[]=[
  ...mlaGroups,
  {key:'routed',name:'Routed Experts',members:['router','router-sigmoid','router-bias','group-top2','group-scores','group-select','topk','route-weights','dispatch','expert-gate-up','expert-silu','expert-down','combine']},
  {key:'shared',name:'Shared Expert',members:['shared-gate-up','shared-silu','shared-down']},
];
const glmGroups:AuthoredGroup[]=[
  {key:'attention',name:'GQA Attention',members:['rope','cache-update','expand-kv','qk','score-scale-cast','mask-softmax','probability-cast','av','o-proj']},
  {key:'ffn',name:'SwiGLU',members:['gate-up','silu','down']},
];
const qwenHybridGqa:AuthoredGroup={key:'attention',name:'Gated GQA',members:['qk-norm-rope','cache-update','qk','softmax','av','output-gate','o-proj']};
const qwenHybridDelta:AuthoredGroup={key:'attention',name:'Gated DeltaNet',members:['delta-output-gate-proj','beta-proj','decay-proj','convolve','qk-l2-norm','beta','decay','recurrent','value-norm-gate','delta-o-proj']};
const qwenHybridMoe:AuthoredGroup[]=[
  {key:'routed',name:'Routed Experts',members:['router','router-softmax','topk','route-renormalize','dispatch','expert-gate-up','expert-silu','expert-down','combine']},
  {key:'shared',name:'Shared Expert',members:['shared-gate-up','shared-silu','shared-down','shared-mix-proj','shared-gate']},
];
const qwenHybridDense:AuthoredGroup={key:'ffn',name:'SwiGLU',members:['ffn-gate-up','ffn-silu','ffn-down']};
const glm52Groups:AuthoredGroup[]=[
  {key:'indexer',name:'DSA Indexer',members:['index-query','index-query-rope','index-key','index-key-norm','index-key-rope','index-write',
    'index-weight','index-score','index-reduce','index-topk']},
  {key:'attention',name:'Sparse MLA',members:['cache-write','q-absorb','qk','softmax','av','v-up','o-proj']},
  {key:'routed',name:'Routed Experts',members:['router','router-sigmoid','router-bias','route-topk','route-normalize',
    'dispatch','expert-gate-up','expert-silu','expert-down','combine']},
  {key:'shared',name:'Shared Expert',members:['shared-gate-up','shared-silu','shared-down']},
  qwenHybridDense,
];
const v4Compressor=['value-proj','score-proj','pending','pool','norm','rope','write'];
function deepSeekV4Groups(ratio:string,v41=false):AuthoredGroup[]{
  const mode=ratio==='0'?'滑窗注意力':v41?'CSA2 · R'+ratio:ratio==='4'?'CSA · R4':'HCA · R128';
  const hyperMembers=v41?['mix','sinkhorn']:['mix','sinkhorn','reduce'];
  return [
    {key:'attention',name:mode,members:['q-head-rmsnorm','q-rope','kv-rmsnorm','kv-rope','window-fake-quant','window-write',
      ...['main','index'].flatMap(prefix=>v4Compressor.map(operation=>prefix+'-'+operation)),
      'index-query','index-query-rope','index-weight','index-key','index-key-norm','index-key-rope','index-score','index-reduce','index-topk',
      'candidate-block-scores','candidate-blocks','candidate-mask-apply',
      'sparse-qk','sink-softmax','sparse-av','output-rope','output-fake-quant','group-output-proj','output-proj']},
    ...['attn','ffn'].map(prefix=>({key:prefix+'-hc',name:'Hyper-Connections',members:hyperMembers.map(operation=>prefix+'-hc-'+operation)})),
    {key:'routed',name:'Routed Experts',members:['router','router-affinity','hash-experts','route-bias','route-topk','route-normalize',
      'route-dispatch','routed-gate-proj','routed-up-proj','routed-swiglu','routed-down-proj','route-combine']},
    {key:'shared',name:'Shared Expert',members:['shared-gate-proj','shared-up-proj','shared-swiglu','shared-down-proj']},
    {key:'engram',name:'Engram',members:['engram-lookup','engram-project','engram-gate','engram-inject']},
  ];
}

/** These memberships come from the fixed decoder templates. Arithmetic leaves keep their IDs. */
export function authoredCanvasGroups(resolved:ResolvedGraph,scope:string):CanvasOperatorGroup[]{
  const container=resolved.containers.find(item=>item.nodeId===scope);
  if(!container)return [];
  const id=container.asset.assetId;
  const hybrid=/^builtin:module:qwen-hybrid-(moe|dense)-(delta|gqa)$/.exec(id);
  const deepSeekV4=/^builtin:module:deepseek-v4-decoder-(0|4|128)(-hash)?$/.exec(id);
  const deepSeekV41=/^builtin:module:deepseek-v41-block-(r[12]|window)(?:-|$)/.exec(id);
  const specs=id==='builtin:module:qwen3-decoder'?qwenGroups:
    id==='builtin:module:glm4-decoder'?glmGroups:
    id.startsWith('builtin:module:glm-5.2-block-')?glm52Groups:
    hybrid?[hybrid[2]==='delta'?qwenHybridDelta:qwenHybridGqa,...(hybrid[1]==='moe'?qwenHybridMoe:[qwenHybridDense])]:
    deepSeekV4?deepSeekV4Groups(deepSeekV4[1]!):
    deepSeekV41?deepSeekV4Groups(deepSeekV41[1]==='window'?'0':deepSeekV41[1]!.slice(1),true):
    id==='builtin:module:deepseek-v3-absorbed-moe'?v3MoeGroups:
    /^builtin:module:deepseek-(v2-(expanded|absorbed)-(dense|moe)|v3-absorbed-dense)$/.test(id)?mlaGroups:[];
  if(!specs.length)return [];
  const leaves=new Set<string>(container.leafNodeIds);
  return specs.flatMap(spec=>{
    const leafIds=spec.members.map(member=>scope+'/'+member).filter(member=>leaves.has(member));
    return leafIds.length>1?[{id:scope+marker+spec.key,name:spec.name,ownerScope:scope,leafIds,kind:'operator' as const}]:[];
  });
}

export function canvasFusionGroup(scope:string,application:ResolvedGraph['fusionApplications'][number],name=application.groupId):CanvasOperatorGroup{
  return {id:scope+marker+'fusion:'+encodeURIComponent(application.groupId),name,
    ownerScope:scope,leafIds:[...application.memberNodeIds],kind:'fusion',fusionNodeId:application.nodeId};
}

export function canvasOperatorScope(resolved:ResolvedGraph|undefined,scope:string):CanvasOperatorGroup|undefined{
  if(!resolved)return;
  const index=scope.lastIndexOf(marker);
  if(index<0)return;
  const parent=scope.slice(0,index),key=scope.slice(index+marker.length);
  if(!key.startsWith('fusion:'))return authoredCanvasGroups(resolved,parent).find(group=>group.id===scope);
  const application=resolved.fusionApplications.find(group=>'fusion:'+encodeURIComponent(group.groupId)===key);
  if(!application)return;
  const group=canvasFusionGroup(parent,application,'融合 · '+application.groupId);
  return {...group,ownerScope:canvasOperatorScope(resolved,parent)?.ownerScope??parent};
}
