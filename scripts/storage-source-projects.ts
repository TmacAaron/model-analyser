import {readFileSync} from 'node:fs';
import {ProjectDocument} from '@model-analyser/contracts';
import {analyzeScenario,type LeafCostSourceRequest} from '@model-analyser/core';
export const storageSourceBase=()=>ProjectDocument.parse(JSON.parse(readFileSync('examples/contracts/project.json','utf8')));
export async function storageSourceRequest(project:ProjectDocument,nodeId:string,field:'hbmBytes'|'logicalReadBytes'|'logicalWriteBytes'|'seconds'='hbmBytes',stepIndex?:number):Promise<LeafCostSourceRequest>{
 const scenario=project.scenarios[0];if(!scenario)throw Error('Scenario missing');const attempt=await analyzeScenario(scenario,project.assetSnapshots);if(attempt.status!=='available')throw Error(JSON.stringify(attempt.diagnostics));
 const step=stepIndex===undefined?undefined:attempt.result.decode?.steps.find(s=>s.index===stepIndex),result=step?.result??attempt.result,sourceScenario=step?.scenario??scenario;if(stepIndex!==undefined&&!step)throw Error('Actual step missing');const node=result.nodes.find(n=>n.nodeId===nodeId);if(!node)throw Error('Actual node missing');
 return {scenario:sourceScenario,assets:project.assetSnapshots,inputHash:result.inputHash,engineVersion:result.engineVersion,selector:{nodeId:node.nodeId,scope:node.cost.scope,field},metric:node.cost[field],...(result.stepContext?{stepContext:result.stepContext}:{})};
}
