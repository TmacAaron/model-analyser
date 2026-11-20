import { describe,it,expect } from 'vitest';
import { evaluateFormula,evaluateExpression,parseExpression,evaluateValue } from '@model-analyser/core';
import { fixture } from './fixtures.js';
describe('controlled formula evaluator',()=>{
  it('C01 GEMM operation count and typed bindings',()=>{
    const asset=fixture();if(asset.definition.kind!=='formula')throw Error();
    const formula=asset.definition.formula;
    expect(evaluateFormula(formula,{M:{value:4,unit:'count'},N:{value:8,unit:'count'},K:{value:16,unit:'count'}})).toEqual({value:1024,unit:'operation'});
    expect(()=>evaluateFormula(formula,{M:{value:4,unit:'byte'}})).toThrow();
  });
  it('supports lazy branches, bounded sums, comparisons and rounding',()=>{
    const run=(s:string)=>evaluateExpression(parseExpression(s),{});
    expect(run('if(2 > 1, sum(i, 1, 4, i * i), 1/0)')).toBe(30);
    expect(run('max(ceil(5/2), floor(2.9)) + abs(-2) + pow(2,3)')).toBe(13);
    for(const s of ['1/0','pow(10,1000)','sum(i,1,10001,i)','constructor(1)','a.b','x=2','1;2'])expect(()=>run(s)).toThrow();
  });
  it('rejects unsafe output shape and missing references',()=>{
    expect(()=>evaluateFormula({inputs:{},expression:'-1',output:{unit:'count',integerRequired:true,nonNegative:true},description:'shape'},{})).toThrow();
    expect(()=>evaluateValue({kind:'formula',call:{formula:{assetId:fixture().assetId,revision:2,kind:'formula'},bindings:{}}},{},[])).toThrow('缺少');
  });
});
