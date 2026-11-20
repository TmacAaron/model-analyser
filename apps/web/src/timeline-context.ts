import type { AnalysisResult,MetricTarget,SingleStepAnalysisResult } from '@model-analyser/contracts';
import type { AnalysisFocus } from './analysis-focus.js';
export type TimelineFrameSelection={nodeIds:Set<string>;available:boolean;atomic:boolean};
export type TimelineContext={all:boolean;label:string;reason?:string|undefined;frames:Map<number,TimelineFrameSelection>;frame:TimelineFrameSelection;missingSteps:number[];atomic:boolean};
function frameSelection(report:SingleStepAnalysisResult,target:MetricTarget):TimelineFrameSelection{
  if(target.kind==='model')return {nodeIds:new Set(),available:true,atomic:false};
  const module=target.kind==='module'?report.modules.find(m=>m.nodeId===target.nodeId):undefined;
  const known=target.kind==='module'?!!module:report.nodes.some(n=>n.nodeId===target.nodeId)||!!report.fusions?.some(f=>f.evaluation.application.nodeId===target.nodeId)||!!(report.distributed?.layout.execution.status==='available'&&report.distributed.layout.execution.result.steps.some(s=>s.nodeId===target.nodeId));
  const nodeIds=new Set<string>(module?.leafNodeIds??(known?[target.nodeId]:[]));let atomic=false;
  for(const f of report.fusions??[]){const group=f.evaluation.application;if(group.memberNodeIds.some(id=>nodeIds.has(id))){if(!group.memberNodeIds.every(id=>nodeIds.has(id)))atomic=true;nodeIds.add(group.nodeId);}}
  return {nodeIds,available:known,atomic};
}
export function timelineContext(result:AnalysisResult|undefined,focus:AnalysisFocus|undefined):TimelineContext{
  const all=!focus||focus.target?.kind==='model',empty:TimelineFrameSelection={nodeIds:new Set(),available:all,atomic:false},frame=result&&focus?.target?frameSelection(result,focus.target):empty;
  const frames=new Map<number,TimelineFrameSelection>(),missingSteps:number[]=[];
  if(!all&&focus?.target)for(const step of result?.decode?.steps??[]){const selection=frameSelection(step.result,focus.target);frames.set(step.index,selection);if(!selection.available)missingSteps.push(step.index);}
  return {all,label:focus?.label??'整个模型',reason:focus?.reason??(!all&&(!frame.available||missingSteps.length)?'当前范围在部分或全部结果中不存在；不会自动展示全模型条目。':undefined),frames,frame,missingSteps,atomic:frame.atomic||[...frames.values()].some(f=>f.atomic)};
}
export function inTimelineContext(context:TimelineContext,nodeId:string,decodeStepIndex?:number){
  if(context.all)return true;
  const frame=decodeStepIndex===undefined?context.frame:context.frames.get(decodeStepIndex);
  return !!frame?.available&&frame.nodeIds.has(nodeId);
}
