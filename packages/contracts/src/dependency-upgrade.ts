import { assetDependencies } from './validation.js';
import { AssetDocument,AssetId,AssetRef,DependencyUpgradeIntent,DependencyUpgradeProposal,ProjectDocument,type AssetIndexEntry } from './index.js';
import { canonical,collectRefs,validateProject } from './validation.js';

export class UpgradePlanningError extends Error {constructor(readonly code:'validation'|'reference'|'conflict',message:string){super(message);}}
export const upgradeRef=(asset:AssetDocument):AssetRef=>({assetId:asset.assetId,revision:asset.revision,kind:asset.definition.kind});
const key=(ref:AssetRef)=>canonical([ref.assetId,ref.revision,ref.kind]);
/** Data-only, explicit model-tree upgrades. Files and hashing belong to the local adapter. */
export function proposeDependencyUpgrade(projectInput:ProjectDocument,intentInput:DependencyUpgradeIntent,library:AssetDocument[],heads:AssetIndexEntry[],copyId:(base:AssetRef)=>string):DependencyUpgradeProposal{
  const project=ProjectDocument.parse(projectInput),intent=DependencyUpgradeIntent.parse(intentInput),fail: (code:UpgradePlanningError['code'],message:string)=>never=(code,message)=>{throw new UpgradePlanningError(code,message);};
  if(project.projectId!==intent.projectId||project.projectRevision!==intent.expectedProjectRevision)fail('conflict','项目修订已变化，请重新预览依赖升级');const scenario=project.scenarios.find(s=>s.scenarioId===intent.scenarioId);if(!scenario)fail('reference','当前方案不存在');
  const assets=new Map<string,AssetDocument>(),conflicts=new Set<string>(),registered=new Set(library.map(a=>key(upgradeRef(a))));for(const a of [...project.assetSnapshots,...library]){const k=key(upgradeRef(a)),old=assets.get(k);if(old&&canonical(old)!==canonical(a))conflicts.add(k);else assets.set(k,a);}
  const guards=new Map<string,DependencyUpgradeProposal['guards'][number]>(),touch=(id:AssetRef['assetId'])=>{const h=heads.find(h=>h.assetId===id);guards.set(id,{assetId:id,head:h?{assetId:h.assetId,revision:h.revision,kind:h.kind}:null,origin:h?.origin??'absent'});};
  const lookup=(ref:AssetRef)=>{touch(ref.assetId);if(conflicts.has(key(ref)))fail('conflict','项目快照与资产库同修订内容冲突 '+ref.assetId+'@'+ref.revision);const a=assets.get(key(ref));if(!a)fail('reference','缺少固定依赖 '+ref.assetId+'@'+ref.revision);return a;};
  const original=new Set<string>();function inventory(ref:AssetRef,stack:string[]=[]){const k=key(ref);if(stack.includes(k)||stack.length>64)fail('reference','依赖环或引用深度超过 64');if(original.has(k))return;if(original.size>=10000)fail('validation','依赖升级超过 10000 个资产预算');original.add(k);for(const child of assetDependencies(lookup(ref)))inventory(child,[...stack,k]);}inventory(scenario.model);
  const selected=new Map<string,AssetRef>();for(const {from,to} of intent.selections){if(from.kind!==to.kind||key(from)===key(to)||!original.has(key(from)))fail('validation','替换必须来自当前模型依赖树、同类型且确有变化');if(from.assetId===to.assetId&&to.revision<=from.revision)fail('validation','同 ID 升级必须选择更高修订');if(selected.has(key(from)))fail('validation','同一固定依赖不能选择两次');lookup(to);selected.set(key(from),to);}
  const used=new Set<string>(),memo=new Map<string,AssetRef>(),created=new Map<string,AssetDocument>(),changes:DependencyUpgradeProposal['changes']=[],warnings:string[]=[];
  function rewrite(value:unknown,stack:string[]):unknown{
    if(value===null||typeof value!=='object')return value;if(Array.isArray(value))return value.map(v=>rewrite(v,stack));
    if(Object.keys(value).length===3){const ref=AssetRef.safeParse(value);if(ref.success)return resolve(ref.data,stack);}return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rewrite(v,stack)]));
  }
  function resolve(source:AssetRef,stack:string[]=[]):AssetRef{
    const k=key(source),cached=memo.get(k);if(cached)return cached;if(stack.includes(k)||stack.length>64)fail('reference','所选替换形成依赖环或超过引用深度');if(memo.size+stack.length>=10000)fail('validation','依赖升级超过资产预算');const base=selected.get(k)??source;if(selected.has(k))used.add(k);const asset=lookup(base),definition=rewrite(asset.definition,[...stack,k]),parallelPresets=asset.parallelPresets?rewrite(asset.parallelPresets,[...stack,k]):undefined,fusionPresets=asset.fusionPresets?rewrite(asset.fusionPresets,[...stack,k]):undefined;let target=base;
    if(canonical(definition)!==canonical(asset.definition)||canonical(fusionPresets??null)!==canonical(asset.fusionPresets??null)||canonical(parallelPresets??null)!==canonical(asset.parallelPresets??null)||!registered.has(key(base))){
      const h=heads.find(h=>h.assetId===base.assetId),revise=h?.origin==='user'&&h.revision===base.revision;
      target=AssetRef.parse({assetId:revise?base.assetId:AssetId.parse(copyId(base)),revision:revise?base.revision+1:1,kind:base.kind});
      if(!revise&&[...assets.values()].some(a=>a.assetId===target.assetId))fail('conflict','派生副本 ID 已存在，请重新预览');touch(target.assetId);
      const next=AssetDocument.parse({...asset,assetId:target.assetId,revision:target.revision,name:asset.name+(revise?'':'（依赖升级副本）'),definition,...(parallelPresets?{parallelPresets}:{}),...(fusionPresets?{fusionPresets}:{})}),prior=created.get(key(target));if(prior&&canonical(prior)!==canonical(next))fail('conflict','一个父修订需要两份不同定义，请分开升级');created.set(key(target),next);
      changes.push({source,base,target,name:next.name,action:revise?'revision':'copy',asset:next});if(!revise)warnings.push(asset.name+' 从固定 r'+base.revision+' 派生副本；内置、缺失或已前进的库头保持不变。');
    }else if(key(source)!==key(base))changes.push({source,base,target,name:asset.name,action:'reuse'});
    memo.set(k,target);return target;
  }
  const model=resolve(scenario.model);for(const [k] of selected)if(!used.has(k))fail('validation','选定更新被另一个父级替换绕过，请取消该项或分开升级');
  const snapshots=new Map(project.assetSnapshots.map(a=>[key(upgradeRef(a)),a])),visited=new Set<string>();function snapshot(ref:AssetRef){const k=key(ref);if(visited.has(k))return;visited.add(k);const a=created.get(k)??lookup(ref),old=snapshots.get(k);if(old&&canonical(old)!==canonical(a))fail('conflict','快照同修订冲突');snapshots.set(k,a);for(const child of assetDependencies(a))snapshot(child);}snapshot(model);
  const updated=ProjectDocument.parse({...project,projectRevision:project.projectRevision+1,scenarios:project.scenarios.map(s=>s.scenarioId===scenario.scenarioId?{...s,model}:s),assetSnapshots:[...snapshots.values()]}),issues=validateProject(updated).filter(d=>d.severity==='error');if(issues.length)fail('reference',issues.map(d=>d.message).join('; '));
  return DependencyUpgradeProposal.parse({version:'dependency-upgrade.1',intent,guards:[...guards.values()].sort((a,b)=>a.assetId<b.assetId?-1:a.assetId>b.assetId?1:0),changes,project:updated,warnings});
}
