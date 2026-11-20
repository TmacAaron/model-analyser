import { z } from 'zod';
import { AssetDocument,ValueExpr,ResolvedParameter,Scenario,NodeId,DecodeStepContext,DeviceId } from '@model-analyser/contracts';
import { explainValue,scopedNumericSymbols,stableStringify,computeInputHash,analyzeScenario,type SymbolAssignment } from '@model-analyser/core';
import { preTotalPeak } from '../../../packages/contracts/src/memory-peak-validation.js';
export const DeclarationSourceRequest=z.strictObject({expression:ValueExpr,expectedBytes:z.number().int().nonnegative().safe(),nodeId:NodeId,workload:Scenario.shape.workload,parameters:z.array(ResolvedParameter),assets:z.array(AssetDocument),inputHash:z.string().min(1)});
export type DeclarationSourceRequest=z.infer<typeof DeclarationSourceRequest>;
export function buildDeclarationSource(input:unknown){
  const r=DeclarationSourceRequest.parse(input),revisions=new Map<string,string>(),parameterIds=new Set<string>();for(const asset of r.assets){const key=asset.assetId+'@'+asset.revision,content=stableStringify(asset);if(revisions.has(key)&&revisions.get(key)!==content)throw Error('固定修订存在冲突，不能选择第一份公式作为依据。');revisions.set(key,content);}for(const p of r.parameters){const key=JSON.stringify([p.nodeId,p.parameterKey]);if(parameterIds.has(key))throw Error('原调用参数身份重复，不能选择另一份数值补填。');parameterIds.add(key);}
  const assignments=new Map<string,SymbolAssignment[]>(),symbols=scopedNumericSymbols(r.parameters,r.workload,r.nodeId,a=>assignments.set(a.name,[...(assignments.get(a.name)??[]),a]));
  const proof=explainValue(r.expression,symbols,r.assets);
  if(proof.quantity.unit!=='byte'||!Number.isSafeInteger(proof.quantity.value)||proof.quantity.value!==r.expectedBytes)throw Error('声明复核的输出、单位或实际调用参数与原预算不一致，未用当前默认值补填。');
  const names=new Set<string>();function visit(node:typeof proof.proof){if(node.symbol)names.add(node.symbol);for(const b of node.bindings??[])if(b.proof)visit(b.proof);}visit(proof.proof);
  return {...proof,inputHash:r.inputHash,nodeId:r.nodeId,symbols:[...names].map(name=>({name,assignments:assignments.get(name)??[]}))};
}
export type DeclarationSourceProof=ReturnType<typeof buildDeclarationSource>;
export const DeclarationReplayRequest=DeclarationSourceRequest.extend({scenario:Scenario,stepContext:DecodeStepContext.optional(),ruleId:z.string().min(1),ruleKind:z.enum(['module','total']),deviceIds:z.array(DeviceId).min(1)});
export type DeclarationReplayRequest=z.infer<typeof DeclarationReplayRequest>;
export async function replayDeclarationSource(input:unknown){
  const r=DeclarationReplayRequest.parse(input);
  if(stableStringify(r.workload)!==stableStringify(r.scenario.workload)||await computeInputHash(r.scenario,r.assets,r.stepContext)!==r.inputHash)throw Error('固定配置或实际调用hash不匹配原声明，未用当前配置补填。');
  const a=await analyzeScenario(r.scenario,r.assets,r.stepContext);if(a.status!=='available')throw Error('原固定配置无法复核：'+a.diagnostics.map(d=>d.message).join('；'));
  if(a.result.inputHash!==r.inputHash||stableStringify(a.result.parameterTrace)!==stableStringify(r.parameters))throw Error('原调用参数记录与固定输入复算不一致。');
  if(new Set(r.deviceIds).size!==r.deviceIds.length)throw Error('原物理设备范围重复。');
  for(const id of r.deviceIds){const memory=a.result.memory.find(m=>m.deviceScope.kind==='per_device'?m.deviceScope.deviceId===id:m.deviceScope.deviceIds.includes(id));
    const total=memory?.totalOverride,module=memory?preTotalPeak(memory).moduleOverrides?.applications.find(x=>x.rule.overrideId===r.ruleId&&x.rule.nodeId===r.nodeId):undefined,application=r.ruleKind==='total'?total:module;
    if(!application||application.rule.overrideId!==r.ruleId||r.ruleKind==='total'&&r.nodeId!=='$model'||application.evaluatedBytes!==r.expectedBytes||stableStringify(application.rule.peakBytes)!==stableStringify(r.expression))throw Error('该设备的原获胜预算规则、表达式或求值结果已不匹配。');
  }
  return {...buildDeclarationSource({expression:r.expression,expectedBytes:r.expectedBytes,nodeId:r.nodeId,workload:r.workload,parameters:r.parameters,assets:r.assets,inputHash:r.inputHash}),verifiedInputHash:r.inputHash,engineVersion:a.result.engineVersion};
}
export type DeclarationReplayProof=Awaited<ReturnType<typeof replayDeclarationSource>>;
export type DeclarationSourceResponse={status:'available';proof:DeclarationReplayProof}|{status:'error';message:string};
