import type { AnalysisResult } from '@model-analyser/contracts';
type ComputeClass=AnalysisResult['total']['compute'][number]['computeClass'];

/** Uses precisely the same logical model work as the analysis/comparison value. */
export function modelComputeFrame(result:AnalysisResult){
  const logical=result.decode?.logicalCompute??result.distributed?.logicalCompute;
  const index=logical?.findIndex(c=>c.scope.target.kind==='model')??-1;
  const frame=index>=0?logical?.[index]:undefined;
  return frame?{compute:frame.compute,targetId:'logical:'+index}:{compute:result.total.compute,targetId:'model'};
}
export function computeClassLabel(cls:ComputeClass){
  return cls.arithmetic+' '+cls.resource+(cls.resourceKey?' '+cls.resourceKey:'')+' '+cls.multiplyDtype.format+' → '+cls.accumulateDtype.format+' inputs['+cls.inputDtypes.map(d=>d.format).join(',')+']';
}
