import { assetDependencies } from '../../../packages/contracts/src/validation.js';
import { AssetDocument,AssetDraft,type AssetRef,type GraphTemplate,type ProjectDocument } from '@model-analyser/contracts';
import { instantiateModel } from '@model-analyser/core';
import { canonical,collectRefs,validateProject } from '../../../packages/contracts/src/validation.js';
import { nodePorts } from './graph-editing.js';
import { request,draftResponse,commitResponse } from './api.js';
type GraphAsset=AssetDocument&{definition:Extract<AssetDocument['definition'],{kind:'model'|'module'}>};
export type CanvasEditPlan={project:ProjectDocument;records:{asset:AssetDocument;draft:AssetDraft;draftRequestId:string;commitRequestId:string;draftSaved:boolean;committed:boolean}[]};
const ref=(a:AssetDocument):AssetRef=>({assetId:a.assetId,revision:a.revision,kind:a.definition.kind});
export function connectCanvasNodes(asset:GraphAsset,fromId:string,toId:string,kind:'data'|'control'|'synchronization',outputPort:string,inputPort:string,library:AssetDocument[]):GraphAsset{
  const graph=structuredClone(asset.definition.graph),from=graph.nodes.find(n=>n.nodeId===fromId),to=graph.nodes.find(n=>n.nodeId===toId);if(!from||!to||from===to)throw Error('端点须为此模块定义内两个不同节点；重复实例的模板连接请在上一级编辑。');
  if(kind!=='data'){if(graph.dependencies.some(e=>e.fromNodeId===from.nodeId&&e.toNodeId===to.nodeId&&e.kind===kind))throw Error('该依赖已存在');graph.dependencies.push({edgeId:crypto.randomUUID(),fromNodeId:from.nodeId,toNodeId:to.nodeId,kind});}
  else {const out=nodePorts(from,library).outputs.find(p=>p.portId===outputPort),input=nodePorts(to,library).inputs.find(p=>p.portId===inputPort),binding=from.portBindings.find(p=>p.portId===out?.portId);if(!out||!input||!binding)throw Error('请选择明确的输出和输入端口');
    if(to.body.kind==='collective')throw Error('通信端点还涉及分布、payload 与网络算法，请在定义编辑器中明确修改。');
    if(to.body.kind==='opaque'){
      const old=to.body.inputs.find(p=>p.portId===input.portId),oldTensor=graph.tensors.find(t=>t.tensorId===old?.tensorId),nextTensor=graph.tensors.find(t=>t.tensorId===binding.tensorId);if(!old||!oldTensor||!nextTensor)throw Error('内联算子输入张量缺失');
      const signature=(t:typeof oldTensor)=>({shape:t.shape.map(a=>({semantic:a.semantic,size:a.size})),dtype:t.dtype});if(canonical(signature(oldTensor))!==canonical(signature(nextTensor)))throw Error('新输入的声明 shape／精度不同，须同步修改算术与访问方程。');
      if(oldTensor.storageId!==nextTensor.storageId&&to.body.inputs.some(p=>p.portId!==input.portId&&graph.tensors.find(t=>t.tensorId===p.tensorId)?.storageId===oldTensor.storageId))throw Error('多个输入共享同一存储，无法从访问方程区分本次端口，请明确编辑成本。');
      const oldStorage=oldTensor.storageId,newStorage=nextTensor.storageId,rewireCost=(cost:typeof to.body.cost)=>({...cost,memoryAccess:cost.memoryAccess.map(a=>a.mode==='read'&&a.storageId===oldStorage?{...a,storageId:newStorage}:a)});
      if(to.body.cost.temporaryStorageIds.includes(oldStorage))throw Error('输入同时声明为临时工作区，须明确编辑其生命周期');
      const local=to.body.localCost;to.body={...to.body,inputs:to.body.inputs.map(p=>p.portId===input.portId?{...p,tensorId:binding.tensorId}:p),cost:rewireCost(to.body.cost),...(local?{localCost:{...local,cost:rewireCost(local.cost),participation:local.participation.kind==='storage_layout'&&local.participation.storageId===oldStorage?{...local.participation,storageId:newStorage}:local.participation,bindings:local.bindings.map(b=>{const source=b.source;if('tensorId' in source&&source.tensorId===oldTensor.tensorId){const axis='axisId' in source?nextTensor.shape[oldTensor.shape.findIndex(a=>a.axisId===source.axisId)]?.axisId:undefined;if('axisId' in source&&!axis)throw Error('局部成本轴无法对应新输入');return {...b,source:{...source,tensorId:nextTensor.tensorId,...(axis?{axisId:axis}:{})}};}return 'storageId' in source&&source.storageId===oldStorage?{...b,source:{...source,storageId:newStorage}}:b;})}}:{})};
    }
    to.portBindings=to.portBindings.map(p=>p.portId===input.portId?{...p,tensorId:binding.tensorId}:p);graph.edges=graph.edges.filter(e=>!(e.to.kind==='node'&&e.to.nodeId===to.nodeId&&e.to.portId===input.portId));graph.edges.push({edgeId:crypto.randomUUID(),from:{kind:'node',nodeId:from.nodeId,portId:out.portId},to:{kind:'node',nodeId:to.nodeId,portId:input.portId},tensorId:binding.tensorId});
  }
  return AssetDocument.parse({...asset,definition:{...asset.definition,graph}}) as GraphAsset;
}
/** Copy the changed definition and affected ancestors; immutable source revisions stay intact. */
export function prepareCanvasEdit(project:ProjectDocument,modelRef:AssetRef,edited:AssetDocument,library:AssetDocument[]):CanvasEditPlan{
  const pool=new Map(project.assetSnapshots.map(a=>[a.assetId+'@'+a.revision,a])),memo=new Map<string,AssetRef>(),documents:AssetDocument[]=[],visiting=new Set<string>();pool.set(edited.assetId+'@'+edited.revision,edited);
  function visit(reference:AssetRef):AssetRef{const key=reference.assetId+'@'+reference.revision,prior=memo.get(key);if(prior)return prior;if(visiting.has(key))throw Error('定义依赖存在循环');const source=pool.get(key);if(!source)throw Error('固定定义快照缺失 '+key);visiting.add(key);const replacements=new Map<string,AssetRef>();for(const child of assetDependencies(source)){const mapped=visit(child);if(mapped.assetId!==child.assetId||mapped.revision!==child.revision)replacements.set(child.assetId+'@'+child.revision,mapped);}
    const changed=key===edited.assetId+'@'+edited.revision||replacements.size>0||!library.some(a=>a.assetId===source.assetId&&a.revision===source.revision&&canonical(a)===canonical(source));
    if(!changed){memo.set(key,reference);visiting.delete(key);return reference;}
    function rewrite(value:unknown):unknown{if(Array.isArray(value))return value.map(rewrite);if(value&&typeof value==='object'){const obj=value as Record<string,unknown>;if(typeof obj.assetId==='string'&&typeof obj.revision==='number'&&typeof obj.kind==='string'){const replacement=replacements.get(obj.assetId+'@'+obj.revision);if(replacement)return replacement;}return Object.fromEntries(Object.entries(obj).map(([k,v])=>[k,rewrite(v)]));}return value;}
    const next=AssetDocument.parse({...source,assetId:crypto.randomUUID(),revision:1,name:source.name+' · 编辑',definition:rewrite(source.definition),...(source.parallelPresets?{parallelPresets:rewrite(source.parallelPresets)}:{}),...(source.fusionPresets?{fusionPresets:rewrite(source.fusionPresets)}:{})});documents.push(next);const mapped=ref(next);memo.set(key,mapped);visiting.delete(key);return mapped;
  }
  const root=visit(modelRef);
  if(!memo.has(edited.assetId+'@'+edited.revision))throw Error('待编辑定义不在当前模型的固定闭包中');
  const next=structuredClone(project);next.assetSnapshots.push(...documents);for(const s of next.scenarios)if(s.model.assetId===modelRef.assetId&&s.model.revision===modelRef.revision)s.model=root;
  const issues=validateProject(next).filter(d=>d.severity==='error');if(issues.length)throw Error(issues.map(d=>d.message).join('；'));for(const s of next.scenarios.filter(s=>s.model.assetId===root.assetId)){const attempt=instantiateModel(s,next.assetSnapshots);if(attempt.status==='unavailable')throw Error(attempt.diagnostics.map(d=>d.message).join('；'));}
  return {project:next,records:documents.map(asset=>({asset,draft:AssetDraft.parse({documentType:'asset_draft',schemaVersion:1,draftId:crypto.randomUUID(),assetId:asset.assetId,assetKind:asset.definition.kind,baseRevision:null,draftGeneration:1,updatedAt:new Date().toISOString(),candidate:asset}),draftRequestId:crypto.randomUUID(),commitRequestId:crypto.randomUUID(),draftSaved:false,committed:false}))};
}
export async function publishCanvasEdit(plan:CanvasEditPlan):Promise<ProjectDocument>{
  // Persist the complete set of authored definitions before publishing any head.
  for(const row of plan.records){if(row.draftSaved)continue;await request('drafts',draftResponse,{requestId:row.draftRequestId,draft:row.draft});row.draftSaved=true;}
  for(const row of plan.records){if(row.committed)continue;const committed=await request('commit',commitResponse,{requestId:row.commitRequestId,draftId:row.draft.draftId,draftGeneration:row.draft.draftGeneration,expectedRevision:null});if(committed.asset.assetId!==row.asset.assetId)throw Error('结构发布响应身份不一致');row.committed=true;}
  return plan.project;
}
export function graphAsset(asset:AssetDocument|undefined):GraphAsset|undefined{return asset&&(asset.definition.kind==='model'||asset.definition.kind==='module')?asset as GraphAsset:undefined;}
export function localCanvasNodeId(globalId:string,scope:string,graph:GraphTemplate):string{const path=scope==='$model'?globalId:globalId.slice(scope.length+1);let local:string;try{local=decodeURIComponent(path);}catch{throw Error('节点路径无法解析');}if(graph.nodes.some(n=>n.nodeId===local))return local;const withoutIndex=local.replace(/\[\d+\]$/,'');if(graph.nodes.some(n=>n.nodeId===withoutIndex))return withoutIndex;throw Error('该端点不是此模块的直接模板节点');}
