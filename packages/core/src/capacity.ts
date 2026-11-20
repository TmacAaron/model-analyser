import { capacityCandidate,capacityPoint } from './capacity-candidate.js';
import { CapacitySearchRequest,CapacitySearchAttempt,Scenario,type AssetDocument,type CapacitySearchPoint,type CapacitySearchResult,type Diagnostic,type ParameterBinding,type AnalysisAttempt } from '@model-analyser/contracts';
import { analyzeScenario,ENGINE_VERSION } from './analyze.js';
import { calculationInput,computeInputHash } from './input-hash.js';
import { FormulaError } from './formula.js';
import { validateCapacitySearch } from '../../contracts/src/capacity-validation.js';

export const MAX_CAPACITY_POINTS=512;
export interface CapacitySearchControl {
  isCancelled?:()=>boolean;
  onProgress?:(completed:number,total:number)=>void;
  yieldControl?:()=>Promise<void>;
  onAnalysis?:(value:number,attempt:AnalysisAttempt)=>void;
}

/** Exhaust every integer: no monotonicity is inferred from endpoints or samples. */
export async function searchCapacity(input:Scenario,library:AssetDocument[],search:CapacitySearchRequest,control:CapacitySearchControl={}):Promise<CapacitySearchAttempt>{
  const diagnostics:Diagnostic[]=[];
  function diagnostic(code:string,message:string):Diagnostic{const d:Diagnostic={diagnosticId:'capacity-'+diagnostics.length,severity:'error',code,message,location:{kind:'file',name:'capacity-search'}};diagnostics.push(d);return d;}
  try{
    // Parse once into an immutable search snapshot, independent of edits during awaits.
    const pack=calculationInput(input,library),base=pack.scenario,assets=pack.assets,request=CapacitySearchRequest.parse(search),variable=request.variable;
    const {min,max}=request.searchRange,count=max-min+1;
    if(min>max)throw new FormulaError('invalid_search_range','搜索最小值不能大于最大值');
    if(!Number.isSafeInteger(count)||count>MAX_CAPACITY_POINTS)throw new FormulaError('search_limit',`每次最多逐点搜索 ${MAX_CAPACITY_POINTS} 个整数；请缩小显式范围`);
    const root=assets.find(a=>a.assetId===base.model.assetId&&a.revision===base.model.revision);
    const parameter=variable.kind==='parameter'?root?.parameters.find(p=>p.key===variable.parameterKey):undefined;
    if(variable.kind==='parameter'){
      if(parameter?.type!=='integer')throw new FormulaError('invalid_search_variable','容量搜索需要模型根部已声明的整数参数');
      if((parameter.min!==undefined&&min<parameter.min)||(parameter.max!==undefined&&max>parameter.max))throw new FormulaError('invalid_search_range','搜索范围超出模型参数声明边界');
    }else{
      if(!(variable.field in base.workload))throw new FormulaError('invalid_search_variable','该工作负载阶段没有所选字段');
      if((variable.field==='batchSize'||variable.field==='queryTokensPerRequest')&&min<1)throw new FormulaError('invalid_search_range','并发与查询长度必须至少为 1');
    }
    const fixedVariables:ParameterBinding[]=[];
    for(const [key,value] of Object.entries(base.workload))if(typeof value==='number'&&!(variable.kind==='workload'&&variable.field===key))fixedVariables.push({parameterKey:'workload.'+key,value:{kind:'integer',value}});
    for(const binding of base.bindings)if(!(variable.kind==='parameter'&&binding.parameterKey===variable.parameterKey))fixedVariables.push({...binding,parameterKey:'binding.'+binding.parameterKey});
    const points:CapacitySearchPoint[]=[],baseInputHash=await computeInputHash(base,assets);let cancelled=false;
    for(let offset=0;offset<count;offset++){
      if(control.isCancelled?.()){cancelled=true;break;}
      const value=min+offset,candidate=capacityCandidate(base,variable,value);
      const attempt=await analyzeScenario(candidate,assets);
      control.onAnalysis?.(value,attempt);
      if(attempt.status==='unavailable')points.push({status:'unavailable',value,diagnostics:attempt.diagnostics});
      else {
        points.push(capacityPoint(attempt.result,value));
      }
      control.onProgress?.(points.length,count);
      if(offset<count-1)await control.yieldControl?.();
    }
    let capacityStatus:CapacitySearchResult['capacityStatus'];
    const fitting=points.filter((p):p is Extract<CapacitySearchPoint,{status:'available'}>=>p.status==='available'&&p.fit==='fits'),best=fitting.at(-1);
    if(cancelled)capacityStatus={kind:'unavailable',diagnosticIds:[diagnostic('search_cancelled','搜索已取消，已完成点仅供查看，未证明整个区间的最大容量').diagnosticId]};
    else if(points.some(p=>(p.status==='unavailable'||p.fit==='unknown')&&(!best||p.value>best.value)))capacityStatus={kind:'unavailable',diagnosticIds:[diagnostic('capacity_indeterminate','候选最大值以上存在不可计算的点，无法证明区间最大容量').diagnosticId]};
    else if(!best)capacityStatus={kind:'unavailable',diagnosticIds:[diagnostic('no_feasible_capacity','指定区间内没有满足所有设备显存容量的整数点；不将零或区间外值作为答案').diagnosticId]};
    else {
      // At the next failing integer these devices actually exceed capacity. At the
      // range ceiling report the tightest current devices, with an explicit bound note.
      const next=points.find(p=>p.value===best.value+1),limiting=next?.status==='available'?next.memory.filter(m=>m.peakBytes.status==='available'&&m.peakBytes.quantity.value>m.capacityBytes).map(m=>m.deviceId):[];
      if(best.value===max){diagnostics.push({diagnosticId:'capacity-range-ceiling',severity:'info',code:'capacity_range_ceiling',message:'区间上界仍可容纳；该最大值仅限所选范围，未证明全局容量上限',location:{kind:'scenario',scenarioId:base.scenarioId}});const margins=best.memory.flatMap(m=>m.peakBytes.status==='available'?[{id:m.deviceId,margin:m.capacityBytes-m.peakBytes.quantity.value}]:[]),least=Math.min(...margins.map(m=>m.margin));limiting.push(...margins.filter(m=>m.margin===least).map(m=>m.id));}
      capacityStatus={kind:'solved',fixedVariables,solveVariable:variable.kind==='workload'?'workload.'+variable.field:'parameter.'+variable.parameterKey,maximum:best.value,searchRange:request.searchRange,limitingDeviceIds:limiting};
    }
    const attempt=CapacitySearchAttempt.parse({status:'available',result:{engineVersion:ENGINE_VERSION,baseInputHash,baseScenario:base,request,method:'exhaustive_integer',completion:cancelled?'cancelled':'complete',points,capacityStatus,diagnostics}});
    if(attempt.status==='available'){const issues=validateCapacitySearch(attempt.result);if(issues.length)return CapacitySearchAttempt.parse({status:'unavailable',diagnostics:issues});}
    return attempt;
  }catch(e){diagnostic(e instanceof FormulaError?e.code:'invalid_capacity_search',e instanceof Error?e.message:'容量搜索失败');return CapacitySearchAttempt.parse({status:'unavailable',diagnostics});}
}

