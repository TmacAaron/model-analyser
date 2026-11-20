import type { ScenarioComparisonResult } from '@model-analyser/contracts';
import { comparisonRows } from './comparison-metrics.js';
import { scopedComparisonCsv,type ScopedComparisonRequest } from './comparison-scoped-cost-data.js';
import { rooflineComparisonEvidence,type RooflineComparisonRequest } from './comparison-roofline-data.js';

export type ComparisonExportSelection=
  |{kind:'json'}
  |{kind:'csv'}
  |{kind:'scope-csv';request:ScopedComparisonRequest}
  |{kind:'roofline-json';request:RooflineComparisonRequest};

export const comparisonExportFiles={
  json:{name:'scenario-comparison.json',type:'application/json'},
  csv:{name:'scenario-comparison.csv',type:'text/csv'},
  'scope-csv':{name:'scenario-comparison-scope.csv',type:'text/csv'},
  'roofline-json':{name:'scenario-comparison-roofline.json',type:'application/json'},
} as const;

function comparisonCsv(report:ScenarioComparisonResult){
  const lines:(string|number|undefined)[][]=[['metric','unit','scenarioId','scenarioName','inputHash','value','deltaFromBaseline']];
  for(const row of comparisonRows(report))for(const [index,{scenario,analysis}] of report.entries.entries()){
    const value=row.values[index],baseline=row.values[0];
    const delta=value!==undefined&&baseline!==undefined?value-baseline:undefined;
    lines.push([row.label,row.unit,scenario.scenarioId,scenario.name,
      analysis.status==='available'?analysis.result.inputHash:'unavailable',value,
      delta!==undefined&&Number.isFinite(delta)?delta:undefined]);
  }
  return lines.map(line=>line.map(cell=>'"'+String(cell??'unavailable').replaceAll('"','""')+'"').join(',')).join('\r\n');
}

export function serializeComparison(report:ScenarioComparisonResult,selection:ComparisonExportSelection){
  const {type}=comparisonExportFiles[selection.kind];
  switch(selection.kind){
    case 'json':return new Blob([JSON.stringify(report,null,2)],{type});
    case 'csv':return new Blob([comparisonCsv(report)],{type});
    case 'scope-csv':return new Blob([scopedComparisonCsv(report,selection.request)],{type});
    case 'roofline-json':return new Blob([JSON.stringify(rooflineComparisonEvidence(report,selection.request),null,2)],{type});
  }
}
