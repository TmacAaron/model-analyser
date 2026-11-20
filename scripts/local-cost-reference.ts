import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { ProjectDocument } from '@model-analyser/contracts';
import { resolveParallelPlan } from '@model-analyser/core';
import { makeLocalGemmProject } from './local-gemm-project.js';
const base=makeLocalGemmProject(ProjectDocument.parse(JSON.parse(await readFile('examples/contracts/project.json','utf8')) as unknown));
await mkdir('examples/computed',{recursive:true});
for(const padded of [false,true]){
  const project=ProjectDocument.parse(base),scenario=project.scenarios[0];if(!scenario)throw Error();
  if(padded){project.projectId+='-padded';project.name+=' · N=9 padding';scenario.scenarioId+='-padded';scenario.bindings=[{parameterKey:'N',value:{kind:'integer',value:9}}];for(const a of scenario.parallelPlan.assignments)for(const t of a.tensorDistributions)if(t.distribution.kind==='sharded')t.distribution.policy={kind:'padded'};}
  const result=await resolveParallelPlan(scenario,project.assetSnapshots);if(result.status!=='available')throw Error(JSON.stringify(result.diagnostics));const node=result.result.localCosts.nodes[0];if(node?.placement.kind!=='placed')throw Error('Local reference was not placed');
  const expected=padded?[640,512]:[512,512];for(const [i,d] of node.placement.perDevice.entries()){if(d.outcome.status!=='available')throw Error('Local reference is unavailable');const useful=d.outcome.cost.compute[0]?.usefulOperations,executed=d.outcome.cost.compute[0]?.executedOperations,hbm=d.outcome.cost.hbmBytes;if(useful?.status!=='available'||useful.quantity.value!==expected[i]||executed?.status!=='available'||executed.quantity.value!==(padded?640:512)||hbm.status!=='available'||hbm.quantity.value!==(padded?328:288))throw Error('Local GEMM reference does not match hand arithmetic');}
  const name='local-gemm'+(padded?'-padded':'');await writeFile('examples/computed/'+name+'-project.json',JSON.stringify(project,null,2)+'\n');await writeFile('examples/computed/'+name+'-result.json',JSON.stringify(result,null,2)+'\n');
  console.log(name+': useful operations '+expected.join('/')+', executed operations '+(padded?'640/640':'512/512')+', estimated HBM '+(padded?'328':'288')+' bytes per device. Portable project/result written to examples/computed.');
}
