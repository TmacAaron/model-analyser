import { ProjectDocument,Scenario,type AscendQuantizationMapping,type ResolvedGraph } from '@model-analyser/contracts';
import { verifyAscendSource,ascendAuxiliaryIndex,importMappingRule } from '../../contracts/src/ascend-quantization.js';
import { validateProject } from '../../contracts/src/validation.js';
import { instantiateModel } from './instantiate.js';

export function confirmAscendQuantization(input:ProjectDocument,scenarioId:string,importId:string,note:string):ProjectDocument{
  const project=ProjectDocument.parse(input),scenario=project.scenarios.find(s=>s.scenarioId===scenarioId),review=scenario?.ascendQuantizationImports?.find(r=>r.importId===importId),source=project.quantizationSources?.find(s=>s.sourceId===review?.sourceId);
  if(!scenario||!review||!source)throw Error('当前配置缺少导入记录或完整来源');if(!note.trim())throw Error('请明确确认映射范围、辅助布局及保留的内部计算方程');if(!review.mappings.length)throw Error('请先添加至少一条字段映射');
  const entries=verifyAscendSource(source),aux=ascendAuxiliaryIndex(entries),base=Scenario.parse({...scenario,quantizationOverrides:scenario.quantizationOverrides.filter(r=>r.importOrigin?.importId!==importId)}),expanded=instantiateModel(base,project.assetSnapshots);if(expanded.status!=='available')throw Error(expanded.diagnostics.map(d=>d.message).join('；'));const graph=expanded.resolved.graph;
  const seen=new Set<string>();for(const mapping of review.mappings){const key=JSON.stringify([mapping.sourceKey,mapping.storageId]);if(seen.has(key))throw Error('同一字段与存储映射重复');seen.add(key);validateTarget(mapping,entries[mapping.sourceKey],graph);}
  const rules=review.mappings.map(m=>importMappingRule(source,review,m,entries,aux)),nextScenario=Scenario.parse({...base,quantizationOverrides:[...base.quantizationOverrides,...rules],ascendQuantizationImports:base.ascendQuantizationImports?.map(r=>r.importId===importId?{...r,appliedMappings:structuredClone(r.mappings),appliedNote:note.trim(),confirmationNote:note}:r)});
  const proof=instantiateModel(nextScenario,project.assetSnapshots);if(proof.status!=='available')throw Error(proof.diagnostics.map(d=>d.message).join('；'));
  const next=ProjectDocument.parse({...project,scenarios:project.scenarios.map(s=>s.scenarioId===scenarioId?nextScenario:s)}),issues=validateProject(next).filter(d=>d.severity==='error');if(issues.length)throw Error(issues.map(d=>d.message).join('；'));return next;
}
function validateTarget(mapping:AscendQuantizationMapping,label:unknown,graph:ResolvedGraph['graph']){
  const storage=graph.storages.find(s=>s.storageId===mapping.storageId);if(!storage||storage.allocation.kind!=='tensor'||storage.category!==mapping.category)throw Error('目标必须为当前图中类别匹配、具有shape/dtype的规范存储');
  if(label==='FLOAT'&&(storage.allocation.dtype.category!=='float'||mapping.specification.payloadBits!==storage.allocation.dtype.bits||mapping.specification.packingUnitElements!==1||mapping.specification.alignmentBytes!==1))throw Error('FLOAT只能明确保留当前模型原始浮点格式，不推断源模型FLOAT位宽');
}
