import { describe,it,expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { analyzeScenario,evaluateValue,explainValue,computeInputHash,stableStringify } from '@model-analyser/core';
import { AssetDocument,NodeId,type ProjectDocument,type AnalysisResult,type ValueExpr } from '@model-analyser/contracts';
import { c01Project } from './model-fixtures.js';
import { makeDeclarationSourceProject,makeDeclarationFusionProject } from '../scripts/declaration-source-project.js';
import { makeCostRankingProject } from '../scripts/cost-ranking-project.js';
import { makeDecodeProject } from '../scripts/decode-project.js';
import { makeStreamProject } from '../scripts/stream-project.js';
import { buildDeclarationSource,replayDeclarationSource } from '../apps/web/src/declaration-source-task.js';
import { buildCostView,costFrame,costFrames,costMetrics,costPercentage,costViewCsv,type CostSelection,type ViewValue } from '../apps/web/src/cost-explorer.js';
import { CostValueSource } from '../apps/web/src/cost-value-source.js';
const selection:CostSelection={step:'all',scope:'$model',devices:'all',level:'execution',metric:'seconds',order:'desc',query:''};
async function analysis(p:ProjectDocument){const a=await analyzeScenario(p.scenarios[0]!,p.assetSnapshots);if(a.status!=='available')throw Error(JSON.stringify(a));return a.result;}
function request(p:ProjectDocument,r:AnalysisResult,node='A'){const application=r.memory[0]?.totalOverride?.theoretical.moduleOverrides?.applications.find(a=>a.rule.nodeId===node)??r.memory[0]?.moduleOverrides?.applications.find(a=>a.rule.nodeId===node);if(!application)throw Error('Application missing');return {expression:application.rule.peakBytes,expectedBytes:application.evaluatedBytes,nodeId:NodeId.parse(node),parameters:r.parameterTrace!,workload:p.scenarios[0]!.workload,assets:p.assetSnapshots,inputHash:r.inputHash};}
describe('actual declaration and cost value sources',()=>{
  it('shares scope precedence, retains shadowed root2 but selects module3 rather than sibling5, and preserves input/result hashes',async()=>{
    const p=makeDeclarationSourceProject(c01Project()),before=stableStringify(p),r=await analysis(p),raw=stableStringify(r),q=request(p,r),proof=buildDeclarationSource(q),b=proof.symbols.find(s=>s.name==='B');expect(proof.quantity.value).toBe(300);expect(b?.assignments.map(a=>a.quantity.value)).toEqual([2,3]);expect(b?.assignments.at(-1)?.source).toMatchObject({kind:'parameter',parameter:{nodeId:'A',source:{kind:'asset_default'}}});expect(buildDeclarationSource(request(p,r,'B')).quantity.value).toBe(500);expect(stableStringify(p)).toBe(before);expect(stableStringify(r)).toBe(raw);expect(await computeInputHash(p.scenarios[0]!,p.assetSnapshots)).toBe(r.inputHash);
  });
  it('replays the winning root device200 separately from private300/500 and preserves the shadowed group rule',async()=>{
    const p=makeDeclarationSourceProject(c01Project()),r=await analysis(p),total=r.memory[0]!.totalOverride!;expect(total.rule.overrideId).toBe('device-root');expect(total.shadowedOverrideIds).toEqual(['group-root']);const q=request(p,r);const proof=buildDeclarationSource({...q,nodeId:NodeId.parse('$model'),expression:total.rule.peakBytes,expectedBytes:total.evaluatedBytes});expect(proof.quantity.value).toBe(200);expect(proof.symbols.find(s=>s.name==='B')?.assignments).toHaveLength(1);
  });
  it('uses the same corrected nearest scope for a real fixed-origin fusion timing formula rather than the root scalar',async()=>{
    const p=makeDeclarationFusionProject(c01Project());
    const r=await analysis(p),seconds=r.fusions?.[0]?.cost.seconds;expect(seconds?.status==='available'&&seconds.quantity.value).toBeCloseTo(.005,12);expect(r.engineVersion).toBe('0.1.0-execution.20');
  });
  it('captures nested fixed formulas, exact input units, actual lazy branch and sum locals without a guessed branch',async()=>{
    const p=makeDeclarationSourceProject(c01Project()),r=await analysis(p),q=request(p,r),proof=buildDeclarationSource(q);expect(proof.proof.definition?.expression).toBe('if(flag > 0, bytes, sum(i, 1, 2, bytes))');expect(proof.proof.bindings?.find(b=>b.name==='bytes')?.proof?.definition?.expression).toBe('100 * x');expect(proof.proof.events).toContainEqual({kind:'branch',condition:1,taken:'then'});expect(proof.proof.events?.some(e=>e.kind==='sum')).toBe(false);const expr=structuredClone(q.expression);if(expr.kind!=='formula')throw Error();expr.call.bindings.flag={kind:'literal',quantity:{value:0,unit:'count'}};const sum=buildDeclarationSource({...q,expression:expr,expectedBytes:600});expect(sum.proof.events).toContainEqual({kind:'sum',variable:'i',from:1,to:2,value:600});expect(sum.proof.events).toContainEqual({kind:'branch',condition:0,taken:'else'});
  });
  it('rejects changed output, wrong input unit, missing actual symbol and conflicting fixed data rather than silently using defaults',async()=>{
    const p=makeDeclarationSourceProject(c01Project()),q=request(p,await analysis(p));expect(()=>buildDeclarationSource({...q,expectedBytes:200})).toThrow('不一致');expect(()=>buildDeclarationSource({...q,parameters:[]})).toThrow('缺少 B');const broken=structuredClone(q);broken.parameters.filter(p=>p.parameterKey==='B').forEach(p=>p.unit='byte');expect(()=>buildDeclarationSource(broken)).toThrow('需要 count');const conflict=structuredClone(q.assets.find(a=>a.definition.kind==='formula')!);conflict.name+=' conflicting content';expect(()=>buildDeclarationSource({...q,assets:[...q.assets,conflict]})).toThrow('固定修订存在冲突');expect(()=>buildDeclarationSource({...q,parameters:[...q.parameters,q.parameters[0]]})).toThrow('原调用参数身份重复');
  });
  it('binds the third growing Decode C4 and fixed-context C2 to their actual scenario/parameter/hash',async()=>{
    for(const fixed of [false,true]){const p=makeDeclarationSourceProject(c01Project(),true);if(fixed&&p.scenarios[0]!.workload.kind==='decode')p.scenarios[0]!.workload.approximation='fixed_context';const r=await analysis(p),step=r.decode!.steps[2]!,q=request({...p,scenarios:[step.scenario]},step.result,'block'),proof=buildDeclarationSource(q);expect(proof.quantity.value).toBe(fixed?200:400);expect(proof.inputHash).toBe(step.result.inputHash);expect(proof.inputHash).not.toBe(r.inputHash);}
  });
  it('bounds trace recording while continuing the same evaluator, and correctly marks local symbols that shadow inputs',()=>{
    const asset=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'test:bounded-proof',revision:1,name:'Bounded sum',parameters:[],tags:[],sources:[],definition:{kind:'formula',formula:{inputs:{i:{unit:'count',integerRequired:true}},expression:'sum(i,1,2000,i)',output:{unit:'byte',integerRequired:true,nonNegative:true},description:'Exact independent sum2001000'}}}),expr:ValueExpr={kind:'formula',call:{formula:{assetId:asset.assetId,revision:1,kind:'formula'},bindings:{i:{kind:'literal',quantity:{value:9,unit:'count'}}}}},proof=explainValue(expr,{},[asset]);expect(proof.quantity.value).toBe(2001000);expect(proof.quantity).toEqual(evaluateValue(expr,{},[asset]));expect(proof.truncated).toBe(true);expect(proof.proof.events).toHaveLength(1000);expect(proof.proof.events?.[0]).toEqual({kind:'symbol',name:'i',value:1,local:true});
  });
  it('keeps literal and symbol evidence distinct and rejects old/missing declaration context at schema boundary',()=>{
    expect(explainValue({kind:'literal',quantity:{value:100,unit:'byte'}},{},[]).proof).toEqual({kind:'literal',quantity:{value:100,unit:'byte'}});expect(explainValue({kind:'symbol',name:'X'},{X:{value:10,unit:'byte'}},[]).proof).toMatchObject({kind:'symbol',symbol:'X',quantity:{value:10,unit:'byte'}});expect(()=>buildDeclarationSource({expression:{kind:'literal',quantity:{value:1,unit:'byte'}}})).toThrow();
  });
  it('independently replays the fixed original input and rejects stale hash, actual parameters, wrong winning rule and device scope',async()=>{
    const p=makeDeclarationSourceProject(c01Project()),r=await analysis(p),q=request(p,r),input={...q,scenario:p.scenarios[0]!,ruleId:'private-A',ruleKind:'module' as const,deviceIds:['gpu0']},proof=await replayDeclarationSource(input);expect(proof.verifiedInputHash).toBe(r.inputHash);expect(proof.engineVersion).toBe('0.1.0-execution.20');
    for(const patch of [{inputHash:'stale'},{ruleId:'private-B'},{deviceIds:['not-a-device']},{parameters:q.parameters.slice(1)},{expectedBytes:200}])await expect(replayDeclarationSource({...input,...patch})).rejects.toThrow();
  });
  it('checks exact real Decode stepContext before accepting an original C4 module rule',async()=>{
    const p=makeDeclarationSourceProject(c01Project(),true),r=await analysis(p),step=r.decode!.steps[2]!,q=request({...p,scenarios:[step.scenario]},step.result,'block'),input={...q,scenario:step.scenario,stepContext:step.result.stepContext,ruleId:'actual-decode-budget',ruleKind:'module' as const,deviceIds:['gpu0']};expect((await replayDeclarationSource(input)).quantity.value).toBe(400);await expect(replayDeclarationSource({...input,stepContext:r.decode!.steps[0]!.result.stepContext})).rejects.toThrow('hash');
  });
  it('retains a full unfiltered32B denominator and exact16B numerator through search, ordering and cost CSV',async()=>{
    const p=makeCostRankingProject(),r=await analysis(p),before=stableStringify(r),view=buildCostView(r,p.scenarios[0]!,{...selection,metric:'hbm',query:'inner/A'});expect(view.rows).toHaveLength(1);expect(view.percentage(view.rows[0]!)).toBe(50);expect(view.sum.value).toBe(32);expect(view.sum.calculation).toMatchObject({kind:'sum',operands:[{value:16},{value:12},{value:0},{value:4}]});expect(view.rows[0]?.value.frame).toBe(0);expect(costViewCsv(r,{...selection,metric:'hbm',query:'inner/A'},view)).toContain('"16","","50"');expect(stableStringify(r)).toBe(before);
  });
  it('retains subtraction operands and full class identity rather than treating all original values as an unordered sum',async()=>{
    const p=makeCostRankingProject(),r=await analysis(p),metric=costMetrics(r).find(m=>m.field==='delta'&&m.computeClass?.resource==='matrix')!,v=buildCostView(r,p.scenarios[0]!,{...selection,metric:metric.id}),row=v.rows.find(r=>r.id==='outer/inner/A')!;expect(row.value.value).toBe(4);expect(row.value.calculation).toMatchObject({kind:'difference',operands:[{value:8},{value:4}]});expect(v.percentage(row)).toBe(100);
  });
  it('looks up actual Decode indices instead of array offsets and exports missing step hashes as null rather than the sequence hash',async()=>{
    const p=makeDecodeProject(c01Project()),r=await analysis(p),steps=r.decode!.steps;steps.forEach((s,i)=>s.index=10+i*10);expect(costFrame(r,20)).toBe(steps[1]!.result);expect(costFrame(r,1)).toBeUndefined();const v=buildCostView(r,p.scenarios[0]!,{...selection,step:20});expect(v.rows[0]?.entries[0]?.step).toBe(20);expect(costViewCsv(r,{...selection,step:20},v)).toContain(steps[1]!.result.inputHash);v.rows[0]!.entries[0]!.step=99;expect(costViewCsv(r,{...selection,step:20},v)).toContain('[null]');expect(costFrame(r,99)).toBeUndefined();
  });
  it('does not fabricate a nondecode step or a defined percent with zero, missing, negative or nested denominator',async()=>{
    const p=makeCostRankingProject(),r=await analysis(p);expect(costFrames(r,3)).toEqual([]);expect(buildCostView(r,p.scenarios[0]!,{...selection,step:3}).sum.value).toBeNull();const nested=buildCostView(r,p.scenarios[0]!,{...selection,level:'modules'});expect(nested.percentage(nested.rows[0]!)).toBeNull();expect(costPercentage(0,0)).toBeNull();expect(costPercentage(1e308,1e308)).toBe(100);expect(costPercentage(Number.MIN_VALUE,1e308)).toBeNull();
  });
  it('shows actual source action context and unavailable-step explanation without falling back to sequence parameters',async()=>{
    const p=makeDecodeProject(c01Project()),r=await analysis(p),value:ViewValue={value:1,sources:[r.total.seconds],reason:'',frame:99,calculation:{kind:'metric',metric:r.total.seconds}},html=renderToStaticMarkup(createElement(CostValueSource,{target:{label:'Missing actual step',value,unit:'second'},selection,result:r,scenario:p.scenarios[0]!,assets:p.assetSnapshots,onClose:()=>{}}));expect(html).toContain('未找到该组成值的实际步骤');expect(html).not.toContain('实际调用求值上下文');
  });
  it('keeps per-device maximum and actual stream intervals separate from module first-to-last span',async()=>{
    const p=makeStreamProject(c01Project()),r=await analysis(p),v=buildCostView(r,p.scenarios[0]!,{...selection,devices:'device:gpu0'}),a=v.rows.find(x=>x.id==='A')!;expect(a.value.calculation).toMatchObject({kind:'maximum',operands:[{calculation:{kind:'interval',start:.001,end:.003}}]});expect(v.sum.value).toBeCloseTo(.0085,12);expect(r.total.seconds.status==='available'&&r.total.seconds.quantity.value).toBeCloseTo(.0065,12);
  });
});

