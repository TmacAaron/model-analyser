import { it,expect } from 'vitest';
import { mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve,join,dirname,basename } from 'node:path';
import { spawnSync } from 'node:child_process';

const runner=resolve('scripts/run-acceptance.ts'),tsx=resolve('node_modules/tsx/dist/cli.mjs');
function run(scripts:Record<string,string>,...args:string[]){
  const directory=mkdtempSync(join(tmpdir(),'model-analyser-acceptance-'));
  try{
    writeFileSync(join(directory,'package.json'),JSON.stringify({scripts}));
    writeFileSync(join(directory,'record.cjs'),"require('node:fs').appendFileSync('order.txt',process.argv[2]+'\\n');if(process.argv[2]==='fail')process.exit(7);");
    const result=spawnSync(process.execPath,[tsx,runner,...args],{cwd:directory,encoding:'utf8'});
    return {status:result.status,stdout:result.stdout,stderr:result.stderr,order:existsSync(join(directory,'order.txt'))?readFileSync(join(directory,'order.txt'),'utf8'):''};
  }finally{
    if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith('model-analyser-acceptance-'))throw Error('Unexpected temporary test path');
    rmSync(directory,{recursive:true,force:true});
  }
}
it('executes original nested and repeated leaf commands in order without an npm child chain',()=>{
  const r=run({top:'npm run first && npm run nested && npm run final',first:'node record.cjs A',nested:'npm test && npm test',test:'node record.cjs B',final:'node record.cjs C'},'top');expect(r.status).toBe(0);expect(r.order).toBe('A\nB\nB\nC\n');
});
it('stops at the real failed leaf and preserves its exit code without executing later tasks',()=>{
  const r=run({top:'node record.cjs A && npm run fail && node record.cjs C',fail:'node record.cjs fail'},'top');expect(r.status).toBe(7);expect(r.order).toBe('A\nfail\n');expect(r.stderr).toContain('Acceptance stopped at fail');
});
it('composes an earlier flat acceptance alias without starting another runner and preserves repetitions/cycle rejection',()=>{
  const scripts={top:'tsx scripts/run-acceptance.ts first prior',first:'node record.cjs A',prior:'tsx scripts/run-acceptance.ts first last',last:'node record.cjs C'};expect(run(scripts,'top')).toMatchObject({status:0,order:'A\nA\nC\n'});expect(JSON.parse(run(scripts,'--list','top').stdout)).toHaveLength(3);expect(run({top:'node record.cjs A && tsx scripts/run-acceptance.ts top'},'top')).toMatchObject({status:1,order:''});
});
it('preflights cycles and missing scripts before side effects and lists commands without executing them',()=>{
  const scripts={top:'node record.cjs A && npm run cycle',cycle:'npm run top'};expect(run(scripts,'top')).toMatchObject({order:'',status:1});expect(run({top:'node record.cjs A && npm run absent'},'top')).toMatchObject({order:'',status:1});const listed=run({top:'npm test && npm test',test:'node record.cjs B'},'--list','top');expect(listed.status).toBe(0);expect(listed.order).toBe('');expect(JSON.parse(listed.stdout)).toEqual([{script:'test',command:'node record.cjs B'},{script:'test',command:'node record.cjs B'}]);
});
