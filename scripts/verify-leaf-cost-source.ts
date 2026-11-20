import {readFile} from 'node:fs/promises';
import { verifyAggregateCostSourceReport,verifyCommunicationCostSourceReport,verifyExactLeafSourceReport,verifyLocalCostSourceReport,verifyFusionCostSourceReport,verifyLogicalWorkSourceReport,verifyLayoutSourceReport } from '@model-analyser/core';
const file=process.argv[2];if(!file)throw Error('Supply an exported leaf-cost source JSON file.');
const raw:unknown=JSON.parse(await readFile(file,'utf8').then(s=>s.replace(/^\uFEFF/,'')));
const kind=raw&&typeof raw==='object'&&'kind'in raw?raw.kind:undefined;
if(kind==='layout_source'){
 const report=await verifyLayoutSourceReport(raw);
 console.log(JSON.stringify({file,kind:report.kind,schemaVersion:report.schemaVersion,inputHash:report.inputHash,engineVersion:report.engineVersion,selector:report.selector,page:report.page,components:report.componentCount,...(report.tensor?{logicalElements:report.tensor.logicalElements,allocatedElements:report.tensor.allocatedElements}:{}),...(report.storage?{totalBytes:report.storage.totalBytes,perCopyBytes:report.storage.perCopyBytes,materialization:report.storage.materialization}:{})}));
}else if(kind==='logical_work_source'){
 const report=await verifyLogicalWorkSourceReport(raw);
 console.log(JSON.stringify({file,kind:report.kind,schemaVersion:report.schemaVersion,inputHash:report.inputHash,engineVersion:report.engineVersion,selector:report.selector,metricStatus:report.metric.status,...(report.metric.status==='available'?{quantity:report.metric.quantity}:{}),page:report.page,components:report.componentCount,operation:report.operation}));
}else if(kind==='fusion_cost_source'){
 const report=await verifyFusionCostSourceReport(raw);
 console.log(JSON.stringify({file,kind:report.kind,schemaVersion:report.schemaVersion,inputHash:report.inputHash,engineVersion:report.engineVersion,selector:report.selector,metricStatus:report.metric.status,...(report.metric.status==='available'?{quantity:report.metric.quantity}:{}),page:report.page,components:report.componentCount,operation:report.operation}));
}else if(kind==='local_cost_source'){
 const report=await verifyLocalCostSourceReport(raw);
 console.log(JSON.stringify({file,kind:report.kind,schemaVersion:report.schemaVersion,inputHash:report.inputHash,engineVersion:report.engineVersion,selector:report.selector,metricStatus:report.metric.status,...(report.metric.status==='available'?{quantity:report.metric.quantity}:{}),page:report.page,components:report.componentCount,complete:report.complete,...(report.expressionOperands?{expressionOperands:report.expressionOperands.length,expressionOperandsComplete:report.expressionOperandsComplete}:{})}));
}else if(kind==='communication_cost_source'){
 const report=await verifyCommunicationCostSourceReport(raw);
 console.log(JSON.stringify({file,kind:report.kind,schemaVersion:report.schemaVersion,inputHash:report.inputHash,engineVersion:report.engineVersion,selector:report.selector,metricStatus:report.metric.status,...(report.metric.status==='available'?{quantity:report.metric.quantity}:{}),page:report.page,components:report.componentCount,operation:report.operation,...(report.parameterBindings?{parameterBindingGraph:{complete:report.parameterBindings.complete,nodes:report.parameterBindings.nodes.length,roots:report.parameterBindings.roots.length}}:{})}));
}else if(kind==='aggregate_cost_source'){
 const report=await verifyAggregateCostSourceReport(raw);
 console.log(JSON.stringify({file,kind:report.kind,schemaVersion:report.schemaVersion,inputHash:report.inputHash,engineVersion:report.engineVersion,selector:report.selector,quantity:report.metric.quantity,page:report.page,components:report.componentCount,operation:report.operation}));
}else{
const report=await verifyExactLeafSourceReport(raw);
console.log(JSON.stringify({file,kind:report.kind,schemaVersion:report.schemaVersion,inputHash:report.inputHash,engineVersion:report.engineVersion,selector:report.selector,quantity:report.metric.quantity,page:report.page,components:report.componentCount,...(report.kind==='leaf_timing_source'?{coverage:report.coverage}:{complete:report.complete}),...('parameterBindings'in report?{parameterBindingGraph:{complete:report.parameterBindings.complete,nodes:report.parameterBindings.nodes.length,roots:report.parameterBindings.roots.length}}:{})}));
}
