import { AssetDocument,AssetRef,ProjectDocument,LocalCostRule,DeviceId,NodeId,TensorId,type ValueExpr } from '@model-analyser/contracts';
import { validateProject } from '../packages/contracts/src/validation.js';

/** Author a distinct synthetic asset variant; do not rewrite the C01 revision. */
export function remapReferenceAssets(assets:AssetDocument[],ids:Map<string,string>):AssetDocument[]{
  function rewrite(value:unknown):unknown{if(value===null||typeof value!=='object')return value;if(Array.isArray(value))return value.map(rewrite);const ref=AssetRef.safeParse(value);if(ref.success)return {...ref.data,assetId:ids.get(ref.data.assetId)??ref.data.assetId};return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rewrite(v)]));}
  return assets.map(a=>AssetDocument.parse({...a,assetId:ids.get(a.assetId)??a.assetId,definition:rewrite(a.definition)}));
}
export function makeLocalGemmProject(base:ProjectDocument):ProjectDocument{
  const project=ProjectDocument.parse(base),original=project.scenarios[0];if(!original)throw Error('Missing C01 scenario');
  const ids=new Map<string,string>([['example:operator:gemm','example:operator:gemm-local'],['example:module:gemm','example:module:gemm-local'],['example:model:gemm','example:model:gemm-local']]);
  project.assetSnapshots=remapReferenceAssets(project.assetSnapshots,ids);
  const source=project.assetSnapshots.find(a=>a.assetId==='builtin:formula:gemm-operations');if(source?.definition.kind!=='formula')throw Error('Missing GEMM equation');
  const operations=AssetDocument.parse({...source,assetId:'example:formula:local-gemm-operations',name:'局部 GEMM 工作量（允许空有效切片）',tags:['synthetic-local-cost'],definition:{kind:'formula',formula:{...source.definition.formula,inputs:Object.fromEntries(Object.entries(source.definition.formula.inputs).map(([k,v])=>[k,{...v,min:0}]))}}});project.assetSnapshots.push(operations);
  const op=project.assetSnapshots.find(a=>a.assetId==='example:operator:gemm-local');if(op?.definition.kind!=='operator')throw Error('Missing GEMM operator');
  const symbol=(name:string):ValueExpr=>({kind:'symbol',name}),work=(m:string,n:string,k:string):ValueExpr=>({kind:'formula',call:{formula:{assetId:operations.assetId,revision:1,kind:'formula'},bindings:{M:symbol(m),N:symbol(n),K:symbol(k)}}});
  const axis=(symbol:string,tensorId:string,axisId:string,basis:'logical'|'allocated')=>({symbol,source:{kind:'tensor_axis',tensorId,axisId,basis}});
  op.definition.operator.localCost=LocalCostRule.parse({participation:{kind:'tensor_layout',tensorId:'Y'},bindings:[axis('ml','X','row','logical'),axis('ma','X','row','allocated'),axis('kl','X','col','logical'),axis('ka','X','col','allocated'),axis('nl','Y','col','logical'),axis('na','Y','col','allocated'),...['X','W','Y'].map(id=>({symbol:id.toLowerCase()+'Bytes',source:{kind:'storage_bytes',storageId:'s'+id,basis:'all_copies'}}))],cost:{...op.definition.operator.cost,compute:op.definition.operator.cost.compute.map(c=>({...c,usefulOperations:work('ml','nl','kl'),executedOperations:work('ma','na','ka')})),memoryAccess:op.definition.operator.cost.memoryAccess.map(a=>({...a,logicalBytes:symbol(a.storageId.slice(1).toLowerCase()+'Bytes')}))},description:'Synthetic column-parallel GEMM: valid M/N/K determine useful work, allocated M/N/K determine executed work. Each declared local storage is read/written once, including quantization auxiliaries; HBM factor=1. No automatic speedup from storage bit width.'});
  project.projectId='example:project:local-gemm';project.name='局部 GEMM 成本参考';project.measurements=[];
  const scenario={...original,scenarioId:'example:scenario:local-gemm',name:'两卡 column-parallel GEMM',model:AssetRef.parse({...original.model,assetId:ids.get(original.model.assetId)??original.model.assetId})};
  const hardware=original.deviceTopology.devices[0]?.hardware;if(!hardware)throw Error('Missing synthetic hardware');
  scenario.deviceTopology={devices:[0,1].map(i=>({deviceId:DeviceId.parse('gpu'+i),hardware})),groups:[{groupId:'tp',members:[DeviceId.parse('gpu0'),DeviceId.parse('gpu1')],mesh:{axes:[{axisId:'tp',size:2}],coordinates:[0,1].map(i=>({deviceId:DeviceId.parse('gpu'+i),coordinates:[i]}))}}]};
  scenario.parallelPlan={assignments:[{selector:{kind:'subtree',rootNodeId:NodeId.parse('$model')},phases:['decode'],tensorDistributions:['X','W','Y'].map(id=>({tensorId:TensorId.parse(id),distribution:id==='X'?{kind:'replicated' as const,groupId:'tp'}:{kind:'sharded' as const,groupId:'tp',axes:[{tensorAxisId:'col',meshAxisId:'tp'}],policy:{kind:'even' as const}}})),storageDistributions:[]}],communications:[],assumptions:['Explicit column-parallel local equations under serial barriers; no implicit communication or cross-node overlap.']};project.scenarios=[scenario];
  const parsed=ProjectDocument.parse(project),invalid=validateProject(parsed).filter(d=>d.severity==='error');if(invalid.length)throw Error(JSON.stringify(invalid));return parsed;
}
