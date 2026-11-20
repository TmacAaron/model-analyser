import { FormulaDefinition, type Quantity, type ValueExpr, type AssetDocument,type AssetRef } from '@model-analyser/contracts';

import { parseExpression, FormulaError, type Ast } from '../../contracts/src/expression.js';
export { parseExpression, FormulaError, expressionSymbols } from '../../contracts/src/expression.js';
const fail = (code:string,message:string):never => {throw new FormulaError(code,message);};
export type ExpressionObservation={kind:'symbol';name:string;value:number;local:boolean}|{kind:'branch';condition:number;taken:'then'|'else'}|{kind:'sum';variable:string;from:number;to:number;value:number}|{kind:'operation';operator:string;operands:number[];value:number};
export function evaluateExpression(ast:Ast,bindings:Record<string,number>,observe?:(event:ExpressionObservation)=>void):number {
  let budget=100000;
  function run(node:Ast,env:Record<string,number>,locals?:ReadonlySet<string>):number {
    if(--budget<0) return fail('invalid_formula','公式计算预算超限');
    let result:number;
    if(node.kind==='number') result=node.value;
    else if(node.kind==='symbol') {const value=Object.hasOwn(env,node.name)?env[node.name]:undefined;if(value===undefined) return fail('unbound_symbol',`未绑定 ${node.name}`);result=value;observe?.({kind:'symbol',name:node.name,value,local:locals?.has(node.name)??false});}
    else if(node.kind==='binary') {const a=run(node.left,env,locals),b=run(node.right,env,locals);
      switch(node.op){case '+':result=a+b;break;case '-':result=a-b;break;case '*':result=a*b;break;case '/':if(b===0) return fail('invalid_formula','除零');result=a/b;break;
        case '<':result=Number(a<b);break;case '>':result=Number(a>b);break;case '<=':result=Number(a<=b);break;case '>=':result=Number(a>=b);break;case '==':result=Number(a===b);break;case '!=':result=Number(a!==b);break;default:return fail('invalid_formula','未知运算');}observe?.({kind:'operation',operator:node.op,operands:[a,b],value:result});
    } else {
      const arg=(i:number)=>{const a=node.args[i];if(!a) return fail('invalid_formula','缺少参数');return a;};
      if(node.name==='if') {const condition=run(arg(0),env,locals);observe?.({kind:'branch',condition,taken:condition!==0?'then':'else'});result=condition!==0?run(arg(1),env,locals):run(arg(2),env,locals);}
      else if(node.name==='sum') {const variable=arg(0);if(variable.kind!=='symbol') return fail('invalid_formula','sum 变量错误');
        const lo=run(arg(1),env,locals),hi=run(arg(2),env,locals);if(!Number.isSafeInteger(lo)||!Number.isSafeInteger(hi)||hi<lo||hi-lo>=10000) return fail('invalid_formula','sum 范围非法或超过 10000');
        const nested=observe?new Set([...(locals??[]),variable.name]):undefined;result=0;for(let i=lo;i<=hi;i++) result+=run(arg(3),{...env,[variable.name]:i},nested);observe?.({kind:'sum',variable:variable.name,from:lo,to:hi,value:result});
      } else {const values=node.args.map(a=>run(a,env,locals));const a=values[0]??0,b=values[1]??0;
        switch(node.name){case 'min':result=Math.min(...values);break;case 'max':result=Math.max(...values);break;case 'ceil':result=Math.ceil(a);break;case 'floor':result=Math.floor(a);break;case 'abs':result=Math.abs(a);break;case 'pow':result=Math.pow(a,b);break;default:return fail('invalid_formula','未知函数');}observe?.({kind:'operation',operator:node.name,operands:values,value:result});
      }
    }
    if(!Number.isFinite(result)) return fail('numeric_overflow','结果不是有限数');return result;
  }
  return run(ast,bindings);
}
export function evaluateFormula(input:unknown,bindings:Record<string,Quantity>,observe?:(event:ExpressionObservation)=>void):Quantity {
  const formula=FormulaDefinition.parse(input), ast=parseExpression(formula.expression);
  const values:Record<string,number>={};
  if(Object.keys(bindings).some(key=>!Object.hasOwn(formula.inputs,key))) return fail('unbound_symbol','含未声明的绑定');
  for(const [key,spec] of Object.entries(formula.inputs)) {
    const q=bindings[key];if(!q) return fail('unbound_symbol',`缺少 ${key}`);
    if(q.unit!==spec.unit) return fail('invalid_unit',`${key} 需要 ${spec.unit}，收到 ${q.unit}`);
    if(!Number.isFinite(q.value)||(spec.integerRequired&&!Number.isSafeInteger(q.value))||(spec.min!==undefined&&q.value<spec.min)||(spec.max!==undefined&&q.value>spec.max)) return fail('invalid_shape',`${key} 超出声明范围`);
    values[key]=q.value;
  }
  const value=evaluateExpression(ast,values,observe),out=formula.output;
  if((out.integerRequired&&!Number.isSafeInteger(value))||(out.nonNegative&&value<0)) return fail('invalid_shape','公式输出超出范围');
  return {value,unit:out.unit};
}
export type ValueEvaluationProof={kind:ValueExpr['kind'];quantity?:Quantity;symbol?:string;formula?:AssetRef;name?:string;definition?:FormulaDefinition;bindings?:{name:string;quantity:Quantity;proof?:ValueEvaluationProof}[];omittedBindings?:number;events?:ExpressionObservation[]};
type TraceBudget={nodes:number;events:number;truncated:boolean};
function valueImpl(expr:ValueExpr,symbols:Record<string,Quantity>,assets:AssetDocument[],chain:string[],proof?:ValueEvaluationProof,budget?:TraceBudget):Quantity {
  if(chain.length>64) return fail('dependency_cycle','公式引用深度超过 64');
  const finish=(q:Quantity)=>{if(proof)proof.quantity=q;return q;};
  if(expr.kind==='literal') return finish(expr.quantity);
  if(expr.kind==='symbol'){const q=symbols[expr.name];if(proof)proof.symbol=expr.name;return finish(q??fail('unbound_symbol',`缺少 ${expr.name}`));}
  const ref=expr.call.formula,key=`${ref.assetId}@${ref.revision}`;
  if(chain.includes(key)) return fail('dependency_cycle',`公式循环 ${[...chain,key].join(' → ')}`);
  const asset=assets.find(a=>a.assetId===ref.assetId&&a.revision===ref.revision);
  if(!asset) return fail('missing_reference',`缺少 ${key}`);
  if(ref.kind!=='formula'||asset.definition.kind!=='formula') return fail('reference_kind_mismatch',`${key} 不是公式`);
  if(proof){proof.formula=ref;proof.name=asset.name;proof.definition=asset.definition.formula;proof.bindings=[];proof.events=[];}
  const bindings=Object.fromEntries(Object.entries(expr.call.bindings).map(([k,v])=>{
    const child=budget&&budget.nodes<256?{kind:v.kind} as ValueEvaluationProof:undefined;if(child&&budget)budget.nodes++;else if(budget)budget.truncated=true;
    const quantity=valueImpl(v,symbols,assets,[...chain,key],child,budget);if(child)proof?.bindings?.push({name:k,quantity,proof:child});else if(proof)proof.omittedBindings=(proof.omittedBindings??0)+1;return [k,quantity];
  }));
  const observe=proof&&budget?(event:ExpressionObservation)=>{if(budget.events<1000){proof.events?.push(event);budget.events++;}else budget.truncated=true;}:undefined;
  return finish(evaluateFormula(asset.definition.formula,bindings,observe));
}
export function evaluateValue(expr:ValueExpr,symbols:Record<string,Quantity>,assets:AssetDocument[],chain:string[]=[]):Quantity{return valueImpl(expr,symbols,assets,chain);}
/** Optional, bounded evidence from the same evaluator; never changes its numeric result. */
export function explainValue(expr:ValueExpr,symbols:Record<string,Quantity>,assets:AssetDocument[]){const proof:ValueEvaluationProof={kind:expr.kind},budget:TraceBudget={nodes:1,events:0,truncated:false};const quantity=valueImpl(expr,symbols,assets,[],proof,budget);return {quantity,proof,truncated:budget.truncated};}
