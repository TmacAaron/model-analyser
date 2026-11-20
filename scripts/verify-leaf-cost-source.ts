import {readFile} from 'node:fs/promises';
import { verifyExactLeafSourceReport } from '@model-analyser/core';
const file=process.argv[2];if(!file)throw Error('Supply an exported leaf-cost source JSON file.');
const report=await verifyExactLeafSourceReport(JSON.parse(await readFile(file,'utf8').then(s=>s.replace(/^\uFEFF/,''))));
console.log(JSON.stringify({file,kind:report.kind,schemaVersion:report.schemaVersion,inputHash:report.inputHash,engineVersion:report.engineVersion,selector:report.selector,quantity:report.metric.quantity,page:report.page,components:report.componentCount,...(report.kind==='leaf_timing_source'?{coverage:report.coverage}:{complete:report.complete}),...('parameterBindings'in report?{parameterBindingGraph:{complete:report.parameterBindings.complete,nodes:report.parameterBindings.nodes.length,roots:report.parameterBindings.roots.length}}:{})}));
