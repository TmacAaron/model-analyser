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

/** These memberships come from the fixed decoder templates. Arithmetic leaves keep their IDs. */
export function authoredCanvasGroups(resolved:ResolvedGraph,scope:string):CanvasOperatorGroup[]{
  const container=resolved.containers.find(item=>item.nodeId===scope);
  if(!container)return [];
  const id=container.asset.assetId;
  const specs=id==='builtin:module:qwen3-decoder'?qwenGroups:
    id==='builtin:module:glm4-decoder'?glmGroups:
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
