import { readdir } from 'node:fs/promises';
import { resolve,dirname,relative,sep } from 'node:path';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

const roots={contracts:resolve('packages/contracts/src'),core:resolve('packages/core/src'),local:resolve('apps/local/src'),web:resolve('apps/web/src')};
type Layer=keyof typeof roots;
const allowed:Record<Layer,Layer[]>={contracts:['contracts'],core:['core','contracts'],local:['local','contracts'],web:['web','core','contracts']};
const errors:string[]=[];
const api=new API({cwd:process.cwd()});
try {
using snapshot=api.updateSnapshot({openProjects:[resolve('tsconfig.json')]});
const project=snapshot.getProject(resolve('tsconfig.json'));
if(!project)throw Error('无法读取项目编译配置');
const layerOf=(path:string)=>(Object.keys(roots) as Layer[]).find(layer=>path===roots[layer]||path.startsWith(roots[layer]+sep));
async function walk(dir:string):Promise<string[]>{const entries=await readdir(dir,{withFileTypes:true});return (await Promise.all(entries.map(async entry=>entry.isDirectory()?walk(resolve(dir,entry.name)):/\.tsx?$/.test(entry.name)?[resolve(dir,entry.name)]:[]))).flat();}
for(const [layer,root] of Object.entries(roots) as [Layer,string][]){
  for(const path of await walk(root)){
    const file=project.program.getSourceFile(path);if(!file)throw Error('编译项目未包含 '+path);
    const report=(node:ts.Node,message:string)=>{const line=file.getLineAndCharacterOfPosition(node.getStart()).line+1;errors.push(`${relative(process.cwd(),path)}:${line} ${message}`);};
    function checkImport(node:ts.Node,spec:string){
      const target=spec.startsWith('.')?layerOf(resolve(dirname(path),spec)):(spec.startsWith('@model-analyser/')?spec.split('/')[1] as Layer:undefined);
      if(target&&!allowed[layer].includes(target))report(node,`依赖方向禁止 ${layer} → ${target}`);
      if((layer==='core'||layer==='contracts')&&spec.startsWith('node:'))report(node,`${layer} 不得依赖 Node 专用 API`);
    }
    function visit(node:ts.Node){
      if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))checkImport(node,node.moduleSpecifier.text);
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){const spec=node.arguments[0];if(spec&&ts.isStringLiteral(spec))checkImport(node,spec.text);else report(node,'动态导入路径必须固定以便核对依赖');}
      if(layer==='contracts'||layer==='core'){
        if(node.kind===ts.SyntaxKind.AnyKeyword||ts.isNonNullExpression(node))report(node,'领域代码禁止 any 和非空断言');
        if((ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='eval')||(ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='Function'))report(node,'禁止执行输入字符串代码');
      }
      node.forEachChild(visit);
    }
    visit(file);
  }
}
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log('Architecture checks passed: contracts ← core/local; web → core/contracts; pure domain boundaries.');
}finally{api.close();}
