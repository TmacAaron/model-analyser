import {applyStorageAllocationOverrides} from './storage-allocation-overrides.js';
import {applyNodeCostOverride} from './node-cost-overrides.js';
import { modelAssumptions,targetParameterSources } from './model-context.js';
import { AnalysisAttempt,AnalysisResult,type Scenario,type AssetDocument,type Diagnostic,type Provenance,type CostDefinition,type MetricScope,type NodeId,type DecodeStepContext,type MemoryEvidence } from '@model-analyser/contracts';
import { instantiateModel } from './instantiate.js';
import { topologicalOrder } from './graph.js';
import { evaluateCost } from './cost.js';
import { allocateStorage } from './storage.js';
import { calculationInput,computeInputHash } from './input-hash.js';
import { aggregateCosts,MetricFactory } from './metrics.js';
import { applyTotalPeakOverrides } from './memory-peak-overrides.js';
import { serialMemory } from './serial-memory.js';
import { rooflinePoints } from './roofline.js';
import { FormulaError } from './formula.js';
import { validateScenario } from '../../contracts/src/scenario-validation.js';
import { validateResult } from '../../contracts/src/result-validation.js';
import { analyzeDistributedScenario } from './distributed-analysis.js';
import { ENGINE_VERSION } from './version.js';
import { analyzeDecodeSequence } from './decode.js';
import {moduleCostInputs} from './aggregate-members.js';
import {logicalDeclarationObserver,type AnalysisObserver} from './logical-work-observation.js';

export { ENGINE_VERSION } from './version.js';
export function usesDistributedAnalysis(scenario:Scenario):boolean{
  return !!(scenario.modulePeakOverrides?.some(rule=>rule.phases.includes(scenario.workload.kind))||scenario.executionPlan.kind==='streams'||
    scenario.fusionGroups.length||scenario.deviceTopology.devices.length!==1||scenario.parallelPlan.assignments.length||scenario.parallelPlan.communications.length);
}
export async function analyzeScenario(input:Scenario,library:AssetDocument[],stepContext?:DecodeStepContext,observer?:AnalysisObserver):Promise<AnalysisAttempt>{
  const diagnostics:Diagnostic[]=[];
  try{
    const pack=calculationInput(input,library),scenario=pack.scenario,assets=pack.assets;
    const invalid=validateScenario(scenario,assets).filter(d=>d.severity==='error');if(invalid.length)return AnalysisAttempt.parse({status:'unavailable',diagnostics:invalid});
    if(scenario.workload.kind==='decode'&&scenario.workload.steps!==1){if(stepContext)throw new FormulaError('invalid_decode_step','序列不能嵌套逐步上下文');return await analyzeDecodeSequence(scenario,assets,analyzeScenario);}
    if(usesDistributedAnalysis(scenario))return await analyzeDistributedScenario(scenario,assets,stepContext,observer);
    const logical=observer&&'logicalLeaf'in observer?observer.logicalLeaf:undefined;
    const expanded=instantiateModel(scenario,assets,undefined,stepContext,logicalDeclarationObserver(logical));if(expanded.status==='unavailable')return AnalysisAttempt.parse(expanded);
    const resolved=expanded.resolved;if(resolved.graph.nodes.some(n=>n.body.kind==='collective'))return await analyzeDistributedScenario(scenario,assets,stepContext,observer);diagnostics.push(...expanded.diagnostics);
    const device=scenario.deviceTopology.devices[0];if(!device)throw new FormulaError('missing_reference','设备不存在');
    const hardwareAsset=assets.find(a=>a.assetId===device.hardware.assetId&&a.revision===device.hardware.revision);if(hardwareAsset?.definition.kind!=='hardware')throw new FormulaError('missing_reference','硬件快照不存在');
    const hardware=hardwareAsset.definition.hardware,assumptions=[
      'Single-device serial baseline, one explicitly declared prefill/decode step; no implicit batch multiplier.',
      'Each leaf is counted once. Containers aggregate leaves without adding another cost.',
      'Weights, state, graph/runtime/reserve are resident; unreferenced workspace/communication storage is conservatively resident.',
      'Activation lifetimes follow producers/last uses; temporary scratch is live only during declared uses unless linked across nodes.',
      'Quantization payload alignment precedes tightly packed auxiliary tensors. Storage aliases share an allocation; accesses are counted independently.',
      'Roofline is per compute class and leaf; each class uses the whole leaf traffic as an explicit shared-traffic bound, never a mixed-precision denominator.',
      ...modelAssumptions(scenario,assets),
      ...scenario.parallelPlan.assumptions,
    ];
    const overrideKeys=new Set<string>();
    applyStorageAllocationOverrides(resolved.graph.storages,scenario.numericOverrides);
    const storageBytes=new Map(resolved.graph.storages.map(s=>[s.storageId,allocateStorage(s.storageId,resolved.graph.storages,{symbols:{},assets}).totalBytes])),accessContext={symbols:{},assets,storageBytes};
    for(const override of scenario.numericOverrides){const target=override.target;if(target.kind==='node'&&override.field==='fixed_seconds'&&scenario.numericOverrides.some(o=>o.target.kind==='node'&&o.target.nodeId===target.nodeId&&(o.field==='compute_efficiency'||o.field==='memory_efficiency')))throw new FormulaError('invalid_override','固定耗时与效率覆盖不能同时生效，请选择一个明确的耗时口径');}
    for(const [overrideIndex,override] of scenario.numericOverrides.entries()){
      if(override.field==='parameter'||override.target.kind==='device'&&override.field==='memory_bytes')continue;
      const target=override.target,key=JSON.stringify([target,override.field]);if(overrideKeys.has(key))throw new FormulaError('invalid_override','同一目标字段被重复覆盖');overrideKeys.add(key);
      assumptions.push(`Explicit override ${key} = ${override.value.value} ${override.value.unit}${override.description?' ('+override.description+')':''}`);
      if(target.kind==='storage'&&override.field==='memory_bytes'){
        continue; // Allocation overrides precede all access-byte bindings, regardless of input array order.
      }else if(target.kind==='node'){
        const node=resolved.graph.nodes.find(n=>n.nodeId===target.nodeId);if(node?.body.kind!=='opaque')throw new FormulaError('missing_reference','成本覆盖必须指向实际叶节点，容器可通过 opaque 资产声明总成本');const cost=node.body.cost;
        applyNodeCostOverride(cost,override,overrideIndex,accessContext);
      }else throw new FormulaError('unsupported_override','当前基线未接入此设备/范围覆盖，不能忽略其输入');
    }
    const provenance:Provenance={assetRefs:assets.map(a=>({assetId:a.assetId,revision:a.revision,kind:a.definition.kind})),formulaRefs:resolved.assetRefs.filter(r=>r.kind==='formula'),parameterSources:resolved.parameters.map(p=>({parameterKey:p.nodeId+':'+p.parameterKey,source:p.source.kind})),assumptions};
    const metrics=new MetricFactory(diagnostics,provenance,scenario.scenarioId),order=topologicalOrder(resolved.graph),scope:MetricScope={phase:resolved.phase,target:{kind:'model'},deviceIds:[device.deviceId],aggregation:'per_device'};
    const nodes:AnalysisResult['nodes']=[],definitions=new Map<NodeId,CostDefinition>(),nodeMetrics=new Map<NodeId,MetricFactory>();
    for(const nodeId of order){const node=resolved.graph.nodes.find(n=>n.nodeId===nodeId);if(node?.body.kind!=='opaque')throw new FormulaError('unsupported_graph_node','分析输入不是已解析叶节点');
      const {cost:definition}=node.body,capture=logical?.nodeId===nodeId?logical:undefined;
      const localProvenance={...provenance,parameterSources:targetParameterSources(resolved,nodeId)},factory=new MetricFactory(diagnostics,localProvenance,scenario.scenarioId),nodeScope:MetricScope={...scope,target:{kind:'node',nodeId}};
      const evaluated=evaluateCost(definition,nodeScope,{...accessContext,provenance:localProvenance},hardware,undefined,capture?{compute:(index,usefulOperations,executedOperations)=>{
        const segment=definition.compute[index];
        if(segment)capture.term(structuredClone({index,segmentId:segment.segmentId,computeClass:segment.computeClass,usefulOperations,executedOperations}));
      }}:undefined);
      nodeMetrics.set(nodeId,factory);diagnostics.push(...evaluated.diagnostics);
      if(evaluated.cost.hbmBytes.status==='available')evaluated.cost.hbmBytes.basis='estimated';
      const cost=aggregateCosts([evaluated.cost],nodeScope,factory);nodes.push({nodeId,cost});definitions.set(nodeId,node.body.cost);
    }
    const nodeById=new Map(nodes.map(node=>[node.nodeId,node]));
    const total=aggregateCosts(nodes.map(n=>n.cost),scope,metrics),modules:AnalysisResult['modules']=resolved.containers.filter(c=>c.nodeId!=='$model').map(c=>({nodeId:c.nodeId,leafNodeIds:c.leafNodeIds,cost:aggregateCosts(moduleCostInputs(c.leafNodeIds,nodeById,[]).costs,{...scope,target:{kind:'module',nodeId:c.nodeId}},new MetricFactory(diagnostics,{...provenance,parameterSources:targetParameterSources(resolved,c.nodeId,true)},scenario.scenarioId))}));
    const schedule:AnalysisResult['schedule']=[];let time=0,known=true;
    for(const node of nodes){if(node.cost.seconds.status==='unavailable'){known=false;continue;}if(!known)continue;const end=time+node.cost.seconds.quantity.value;if(!Number.isFinite(end)||(node.cost.seconds.quantity.value>0&&end===time)){metrics.unavailable('numeric_overflow','累计时间线溢出或无法表示非零区间');known=false;continue;}schedule.push({nodeId:node.nodeId,deviceScope:{kind:'per_device',deviceId:device.deviceId},streamId:'serial',startSeconds:time,endSeconds:end});time=end;}
    if(!known&&total.seconds.status==='available')total.seconds=metrics.unavailable('incomplete_serial_execution','串行时刻无法完整表示，不能报告完整跨度');
    const memoryEvidence:MemoryEvidence[]=[];
    const memory=applyTotalPeakOverrides([serialMemory(resolved,order,schedule,device.deviceId,hardware.capacityBytes,metrics,evidence=>memoryEvidence.push(evidence),assets)],resolved,scenario,assets,diagnostics)[0],roofline=nodes.flatMap(n=>{const definition=definitions.get(n.nodeId);if(!definition)throw new FormulaError('missing_reference','Roofline 缺少成本定义');return rooflinePoints(n.cost,definition,hardware,nodeMetrics.get(n.nodeId)??metrics);});
    const result=AnalysisResult.parse({parameterTrace:resolved.parameters,...(stepContext?{stepContext}:{}),engineVersion:ENGINE_VERSION,inputHash:await computeInputHash(scenario,assets,stepContext),scenarioId:scenario.scenarioId,phase:resolved.phase,scope,quantizationApplications:resolved.quantizationApplications,nodes,modules,total,memoryEvidence,memory:[memory],schedule,roofline,diagnostics});
    const issues=validateResult(result);if(issues.length)return AnalysisAttempt.parse({status:'unavailable',diagnostics:issues});return {status:'available',result};
  }catch(e){diagnostics.push({diagnosticId:'analysis-failure',severity:'error',code:e instanceof FormulaError?e.code:'invalid_input',message:e instanceof Error?e.message:'分析失败',location:{kind:'file',name:'analysis'}});return AnalysisAttempt.parse({status:'unavailable',diagnostics});}
}

