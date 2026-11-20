import type { AnalysisResult,MetricScope } from '@model-analyser/contracts';
type ComputeClass=AnalysisResult['total']['compute'][number]['computeClass'];

export function logicalTargetId(target:MetricScope['target']){
  return target.kind==='model'?'logical:model':'logical:'+target.kind+':'+target.nodeId;
}

/** Uses precisely the same logical model work as the analysis/comparison value. */
export function modelComputeFrame(result:AnalysisResult){
  const logical=result.decode?.logicalCompute??result.distributed?.logicalCompute;
  const frame=logical?.find(c=>c.scope.target.kind==='model');
  return frame?{compute:frame.compute,targetId:logicalTargetId(frame.scope.target)}:{compute:result.total.compute,targetId:'model'};
}
export function computeClassLabel(cls:ComputeClass){
  return cls.arithmetic+' '+cls.resource+(cls.resourceKey?' '+cls.resourceKey:'')+' '+cls.multiplyDtype.format+' → '+cls.accumulateDtype.format+' inputs['+cls.inputDtypes.map(d=>d.format).join(',')+']';
}
