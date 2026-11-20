import { mkdir,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { analyzeScenario,instantiateModel,ENGINE_VERSION } from '@model-analyser/core';
import { validateProject } from '../packages/contracts/src/validation.js';
import { makeEditingProject } from './editing-project.js';

const project=makeEditingProject();assert.deepEqual(validateProject(project),[]);const scenario=project.scenarios[0];if(!scenario)throw Error('Missing scenario');
const expanded=instantiateModel(scenario,project.assetSnapshots);if(expanded.status!=='available')throw Error(JSON.stringify(expanded.diagnostics));assert.equal(expanded.resolved.graph.nodes.length,4);const result=await analyzeScenario(scenario,project.assetSnapshots);if(result.status!=='available')throw Error(JSON.stringify(result.diagnostics));assert.equal(result.result.total.seconds.status,'available');if(result.result.total.seconds.status==='available')assert.equal(result.result.total.seconds.quantity.value,9);
await mkdir('examples/editing',{recursive:true});for(const a of project.assetSnapshots)await writeFile('examples/editing/'+a.definition.kind+'.json',JSON.stringify(a,null,2)+'\n');
await writeFile('examples/editing/project.json',JSON.stringify(project,null,2)+'\n');await writeFile('examples/editing/result.json',JSON.stringify(result.result,null,2)+'\n');await writeFile('examples/editing/reference.json',JSON.stringify({engineVersion:ENGINE_VERSION,description:'Synthetic structure editor reference, no real hardware performance claim.',repeatCount:3,repeatedLeafSeconds:2,tailSeconds:3,independentSeconds:3*2+3,leafNodeIds:expanded.resolved.graph.nodes.map(n=>n.nodeId),containers:expanded.resolved.containers,inputHash:result.result.inputHash},null,2)+'\n');
console.log('Structure editing: 3 × 2 + 3 = 9 seconds, four leaves, fixed module binding and portable project written.');
