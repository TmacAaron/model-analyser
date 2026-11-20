import type {AnalysisResult,DecodeSequence,MetricValue,ParallelResolution} from '@model-analyser/contracts';

export type AnalysisExportSelection=
  |{kind:'json'}
  |{kind:'csv'}
  |{kind:'step';index:number;inputHash:string}
  |{kind:'layout';index:number|null;inputHash:string};
export type AnalysisExportRequest={kind:'export';taskId:number;inputHash:string;engineVersion:string;selection:AnalysisExportSelection};
export type AnalysisExportReply={kind:'exported';taskId:number;inputHash:string;engineVersion:string;selection:AnalysisExportSelection}&(
  {status:'available';blob:Blob}|{status:'error';message:string}
);

type CostRow=AnalysisResult['nodes'][number];
export type ExportContents=
  |{format:'json';value:AnalysisResult|DecodeSequence['steps'][number]|ParallelResolution}
  |{format:'csv';nodes:Pick<CostRow,'nodeId'|'cost'>[];fusedNodeIds:string[];fusions:Pick<CostRow,'nodeId'|'cost'>[]};

export function selectExportContents(result:AnalysisResult,selection:AnalysisExportSelection):ExportContents{
  switch(selection.kind){
    case 'json':return {format:'json',value:result};
    case 'step':{
      const step=result.decode?.steps.find(step=>step.index===selection.index&&step.result.inputHash===selection.inputHash);
      if(!step)throw Error('原 Decode 步骤或输入哈希不同，请重新计算');
      return {format:'json',value:step};
    }
    case 'layout':{
      const frame=selection.index===null?(result.decode?undefined:result):result.decode?.steps.find(step=>step.index===selection.index)?.result;
      const layout=frame?.distributed?.layout;
      if(!layout||layout.inputHash!==selection.inputHash)throw Error('原布局或实际步骤的输入哈希不同，请重新计算');
      return {format:'json',value:layout};
    }
    case 'csv':return {format:'csv',nodes:result.nodes,
      fusedNodeIds:result.decode?.fusedMemberNodeIds??result.fusions?.flatMap(f=>f.evaluation.application.memberNodeIds)??[],
      fusions:result.fusions?.map(f=>({nodeId:f.evaluation.application.nodeId,cost:f.cost}))??[]};
  }
}

const raw=(value:MetricValue)=>value.status==='available'?value.quantity.value:'unavailable';
const cell=(value:string|number)=>'"'+String(value).replaceAll('"','""')+'"';
const headings=['nodeId','phase','aggregation','deviceIdsJson','computeSegments (operations)','logicalReadBytes','logicalWriteBytes','estimatedHbmBytes','seconds'];

export function serializeAnalysisExport(contents:ExportContents){
  if(contents.format==='json')return new Blob([JSON.stringify(contents.value,null,2)],{type:'application/json'});
  const fused=new Set(contents.fusedNodeIds),active=[...contents.nodes.filter(row=>!fused.has(row.nodeId)),...contents.fusions];
  const rows=active.map(({nodeId,cost})=>[nodeId,cost.scope.phase,cost.scope.aggregation,JSON.stringify(cost.scope.deviceIds),
    JSON.stringify(cost.compute.map(c=>({computeClass:c.computeClass,usefulOperations:raw(c.usefulOperations),executedOperations:raw(c.executedOperations)}))),
    raw(cost.logicalReadBytes),raw(cost.logicalWriteBytes),raw(cost.hbmBytes),raw(cost.seconds)]);
  return new Blob([[headings,...rows].map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv'});
}

export function analysisExportFilename(result:AnalysisResult,selection:AnalysisExportSelection){
  switch(selection.kind){
    case 'json':return 'model-analyser-result.json';
    case 'step':return 'decode-step-'+(selection.index+1)+'.json';
    case 'layout':return selection.index===null?'model-analyser-layout.json':'decode-step-'+(selection.index+1)+'-layout.json';
    case 'csv':return result.fusions?.length?'model-analyser-execution-costs.csv':'model-analyser-leaf-costs.csv';
  }
}
