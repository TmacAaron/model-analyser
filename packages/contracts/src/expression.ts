export type Ast = {kind:'number';value:number} | {kind:'symbol';name:string} | {kind:'binary';op:string;left:Ast;right:Ast} | {kind:'call';name:string;args:Ast[]};
export class FormulaError extends Error {
  constructor(public readonly code:string,message:string) { super(message); }
}
const fail = (code:string,message:string):never => {throw new FormulaError(code,message);};
export function parseExpression(text:string):Ast {
  if(text.length>10000) return fail('invalid_formula','公式长度超过 10000');
  const tokens:string[]=[];
  const regex=/\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z_0-9]*)|(<=|>=|==|!=|[+*/(),<>-]))/gy;
  let cursor=0;
  while(cursor<text.trimEnd().length) {
    regex.lastIndex=cursor;const match=regex.exec(text);
    if(!match) return fail('invalid_formula',`非法表达式，位置 ${cursor}`);
    tokens.push((match[1]??match[2]??match[3]) as string);cursor=regex.lastIndex;
  }
  let index=0,depth=0;
  const take=()=>tokens[index++];
  const precedence:Record<string,number>={'<':1,'>':1,'<=':1,'>=':1,'==':1,'!=':1,'+':2,'-':2,'*':3,'/':3};
  function primary():Ast {
    if(++depth>128) return fail('invalid_formula','表达式嵌套过深');
    const token=take();let node:Ast;
    if(token===undefined) return fail('invalid_formula','表达式意外结束');
    if(token==='+'||token==='-') node={kind:'binary',op:token,left:{kind:'number',value:0},right:primary()};
    else if(token==='('){node=expression(0);if(take()!==')') return fail('invalid_formula','缺少右括号');}
    else if(/^\d|^\./.test(token)) node={kind:'number',value:Number(token)};
    else if(/^[A-Za-z_]/.test(token)) {
      if(tokens[index]==='('){take();const args:Ast[]=[];
        if(tokens[index]!==')'){do {args.push(expression(0));if(tokens[index]!==',') break;take();}while(true);}
        if(take()!==')') return fail('invalid_formula','函数括号不完整');
        const arities:Record<string,number|undefined>={if:3,ceil:1,floor:1,abs:1,pow:2,sum:4,min:undefined,max:undefined};
        if(!Object.hasOwn(arities,token)||args.length===0||(arities[token]!==undefined&&args.length!==arities[token])) return fail('invalid_formula',`函数或参数数量错误：${token}`);
        if(token==='sum'&&args[0]?.kind!=='symbol') return fail('invalid_formula','sum 第一个参数应为局部变量');
        node={kind:'call',name:token,args};
      } else node={kind:'symbol',name:token};
    } else return fail('invalid_formula',`意外符号：${token}`);
    depth--;return node;
  }
  function expression(min:number):Ast {let left=primary();while(true){const op=tokens[index];const p=op===undefined?undefined:precedence[op];if(p===undefined||p<min||op===undefined) break;take();left={kind:'binary',op,left,right:expression(p+1)};}return left;}
  const ast=expression(0);if(index!==tokens.length) return fail('invalid_formula',`多余符号：${tokens[index]}`);return ast;
}
export function expressionSymbols(ast:Ast,local=new Set<string>()):Set<string> {
  if(ast.kind==='number') return new Set();if(ast.kind==='symbol') return new Set(local.has(ast.name)?[]:[ast.name]);
  if(ast.kind==='binary') return new Set([...expressionSymbols(ast.left,local),...expressionSymbols(ast.right,local)]);
  if(ast.name==='sum') {
    const [symbol,lo,hi,body]=ast.args;
    if(symbol?.kind!=='symbol'||!lo||!hi||!body) return fail('invalid_formula','sum 参数错误');
    return new Set([...expressionSymbols(lo,local),...expressionSymbols(hi,local),...expressionSymbols(body,new Set([...local,symbol.name]))]);
  }
  return new Set(ast.args.flatMap(a=>[...expressionSymbols(a,local)]));
}
