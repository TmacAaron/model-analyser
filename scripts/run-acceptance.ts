import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Expand existing npm chains before starting children, avoiding repeated npm
// lifecycle nesting and keeping child command lookup in one Windows environment.
// Keep every original leaf command, argument, repetition and && execution order.
const scripts=(JSON.parse(readFileSync('package.json','utf8')) as {scripts:Record<string,string>}).scripts;
const args=process.argv.slice(2),list=args.includes('--list'),targets=args.filter(a=>a!=='--list');
if(!targets.length)throw Error('Specify one or more package script names.');
const leaves:{script:string;command:string}[]=[];
function expand(name:string,parents:string[]=[]){
  if(parents.includes(name))throw Error('Acceptance script cycle: '+[...parents,name].join(' → '));
  const body=scripts[name];if(!body)throw Error('Unknown package script: '+name);
  for(const command of body.split(' && ')){
    const nested=/^npm run ([a-zA-Z0-9:_-]+)$/.exec(command);
    const composed=/^tsx scripts\/run-acceptance\.ts ([a-zA-Z0-9:_ -]+)$/.exec(command);
    if(nested)expand(nested[1]!,[...parents,name]);
    else if(composed)for(const target of composed[1]!.split(' ').filter(Boolean))expand(target,[...parents,name]);
    else if(command==='npm test')expand('test',[...parents,name]);
    else if(command.startsWith('npm '))throw Error('Unsupported npm command in acceptance chain: '+command);
    else leaves.push({script:name,command});
  }
}
for(const target of targets)expand(target);
if(list)console.log(JSON.stringify(leaves,null,2));
else for(const [index,leaf] of leaves.entries()){
  console.log(`\n[acceptance ${index+1}/${leaves.length}] ${leaf.script}: ${leaf.command}\n`);
  const result=spawnSync(leaf.command,{shell:true,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0){console.error('Acceptance stopped at '+leaf.script+(result.signal?' ('+result.signal+')':''));process.exit(result.status??1);}
}
