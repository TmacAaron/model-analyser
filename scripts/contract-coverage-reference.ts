import { mkdir,writeFile } from 'node:fs/promises';
import { buildContractCoverage } from './contract-coverage.js';
const fixture=buildContractCoverage();await mkdir('examples/contracts',{recursive:true});await writeFile('examples/contracts/union-coverage.json',JSON.stringify(fixture,null,2)+'\n');console.log('Generated structural fixtures: '+fixture.roots.length+' schema roots, '+fixture.unions.length+' distinct unions, '+fixture.unions.reduce((n,u)=>n+u.branches.length,0)+' branches. Domain semantics remain separately verified.');
