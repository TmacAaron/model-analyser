import {z} from 'zod';
import {Scenario,AssetDocument,DecodeStepContext,MetricValue,MetricScope,ComputeClass,NodeId} from '@model-analyser/contracts';
import {analyzeScenario,ENGINE_VERSION} from './analyze.js';
import {instantiateModel,type InstantiatedCostCapture} from './instantiate.js';
import {computeInputHash,stableStringify} from './input-hash.js';
import {canonical} from '../../contracts/src/validation.js';
import type {InstantiationObserver} from './instantiate.js';
export type LeafSourceObservation=Pick<InstantiationObserver,'quantization'|'bindingNodes'|'bindingTraceReady'>&{declared?:(call:InstantiatedCostCapture)=>void;allowNodeCostOverrides?:true};
/** Semantic selectors originate where a cost field is selected, never from matching values. */
export const LeafCostSelector=z.strictObject({nodeId:NodeId,scope:MetricScope,field:z.enum(['hbmBytes','logicalReadBytes','logicalWriteBytes','usefulOperations','executedOperations','seconds']),computeClass:ComputeClass.optional()});
export type LeafCostSelector=z.infer<typeof LeafCostSelector>;
export const LeafCostSourceRequest=z.strictObject({scenario:Scenario,assets:z.array(AssetDocument),stepContext:DecodeStepContext.optional(),inputHash:z.string().min(1),engineVersion:z.string().min(1),selector:LeafCostSelector,metric:MetricValue,page:z.number().int().nonnegative().max(10000).default(0)});
export type LeafCostSourceRequest=z.input<typeof LeafCostSourceRequest>;

export async function resolveLeafCostSource(input:unknown,bindings=false,observation?:LeafSourceObservation){
  const r=LeafCostSourceRequest.parse(input);
  if(r.engineVersion!==ENGINE_VERSION)throw Error('原指标的引擎版本不同，请重算；相同hash或数值不能证明历史执行链。');
  if(await computeInputHash(r.scenario,r.assets,r.stepContext)!==r.inputHash)throw Error('固定输入或实际步骤hash不匹配原指标。');
  const checked=await analyzeScenario(r.scenario,r.assets,r.stepContext);if(checked.status!=='available')throw Error('原固定输入不能复算。');
  const result=checked.result;if(result.decode)throw Error('序列汇总没有单次调用实参，请选择实际步骤。');
  if(result.distributed)throw Error('此指标含局部／分布式变换；尚未采集其精确表达式链，不使用全局公式代替。');
  const node=result.nodes.find(n=>n.nodeId===r.selector.nodeId);if(!node||canonical(node.cost.scope)!==canonical(r.selector.scope))throw Error('原节点或完整设备／统计范围不匹配。');
  const compute=r.selector.field==='usefulOperations'||r.selector.field==='executedOperations';
  if(compute!==!!r.selector.computeClass)throw Error('计算指标必须绑定完整计算类别，其他字段不得携带类别。');
  const rows=compute?node.cost.compute.filter(c=>canonical(c.computeClass)===canonical(r.selector.computeClass)):[];
  if(compute&&rows.length!==1)throw Error('原计算类别不存在或不唯一。');
  const row=rows[0];if(compute&&!row)throw Error('原计算类别缺失。');
  const metric=compute&&row?row[r.selector.field as 'usefulOperations'|'executedOperations']:node.cost[r.selector.field as 'hbmBytes'|'logicalReadBytes'|'logicalWriteBytes'|'seconds'];
  if(stableStringify(metric)!==stableStringify(r.metric)||result.engineVersion!==r.engineVersion||result.inputHash!==r.inputHash)throw Error('原指标、单位、诊断或版本与固定输入复算不一致。');
  if(metric.status!=='available')throw Error('原指标不可用，保留诊断，不伪造数值求值链。');
  if(!observation?.allowNodeCostOverrides&&r.scenario.numericOverrides.some(o=>o.target.kind==='node'&&o.target.nodeId===r.selector.nodeId&&o.field!=='parameter'))throw Error('此节点有成本覆盖变换，尚未采集精确覆盖链；未展示被覆盖表达式作为实际来源。');
  const captures:InstantiatedCostCapture[]=[];
  const expanded=instantiateModel(r.scenario,r.assets,undefined,r.stepContext,{nodeId:r.selector.nodeId,cost:c=>{captures.push(c);observation?.declared?.(c);},...(bindings?{bindings:true}:{}),...(observation?.quantization?{quantization:observation.quantization}:{}),...(observation?.bindingNodes?{bindingNodes:observation.bindingNodes}:{}),...(observation?.bindingTraceReady?{bindingTraceReady:observation.bindingTraceReady}:{})});
  if(expanded.status!=='available'||captures.length!==1)throw Error('无法唯一捕获原实际调用的成本表达式。');
  const call=captures[0];if(!call)throw Error('原调用捕获缺失。');
 return {r,node,metric,call,expanded,compute};
}
export type LeafCostContext=Awaited<ReturnType<typeof resolveLeafCostSource>>;
