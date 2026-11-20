import { ScenarioComparisonRequest,ScenarioComparisonAttempt,type Scenario,type AssetDocument,type ScenarioInputChange,type CapacitySearchPoint,type ScenarioCrossing } from '@model-analyser/contracts';
import { analyzeScenario,ENGINE_VERSION } from './analyze.js';
import { calculationInput,stableStringify } from './input-hash.js';
import { searchCapacity,type CapacitySearchControl } from './capacity.js';
import { validateScenarioComparison } from '../../contracts/src/comparison-validation.js';

export const MAX_COMPARISON_ANALYSES=512;
const escape=(s:string)=>s.replaceAll('~','~0').replaceAll('/','~1');
/** JSON Pointer changes; absent and explicit null remain distinct. */
export function comparisonInputChanges(before:unknown,after:unknown):ScenarioInputChange[]{
  const changes:ScenarioInputChange[]=[];
  function visit(a:unknown,b:unknown,path:string){
    if(a!==undefined&&b!==undefined&&stableStringify(a)===stableStringify(b))return;
    if(a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)){
      const left=Object.fromEntries(Object.entries(a)),right=Object.fromEntries(Object.entries(b));
      for(const key of [...new Set([...Object.keys(left),...Object.keys(right)])].sort())visit(left[key],right[key],path+'/'+escape(key));
    }else changes.push({path:path||'/',...(a===undefined?{}:{before:a as ScenarioInputChange['before']}),...(b===undefined?{}:{after:b as ScenarioInputChange['after']})});
  }
  visit(before,after,'');return changes;
}
/** Exact sampled equalities and strict reversals at adjacent integers only. No root interpolation. */
export function sampledCrossings(left:CapacitySearchPoint[],right:CapacitySearchPoint[]):{knownPoints:number;crossings:ScenarioCrossing[]}{
  const other=new Map(right.map(p=>[p.value,p])),crossings:ScenarioCrossing[]=[];let knownPoints=0,previous:{value:number;sign:number}|undefined;
  for(const p of left){const q=other.get(p.value);
    if(p.status!=='available'||q?.status!=='available'||p.seconds.status!=='available'||q.seconds.status!=='available'){previous=undefined;continue;}
    knownPoints++;const a=p.seconds.quantity.value,b=q.seconds.quantity.value,sign=a===b?0:a<b?-1:1;
    if(sign===0){const last=crossings.at(-1);if(last?.kind==='equal_samples'&&last.upper===p.value-1)last.upper=p.value;else crossings.push({kind:'equal_samples',lower:p.value,upper:p.value});}
    else if(previous&&previous.value===p.value-1&&previous.sign!==0&&previous.sign!==sign)crossings.push({kind:'ordering_change',lower:previous.value,upper:p.value});
    previous={value:p.value,sign};
  }
  return {knownPoints,crossings};
}

export async function compareScenarios(scenarios:Scenario[],library:AssetDocument[],input:ScenarioComparisonRequest,control:CapacitySearchControl={}):Promise<ScenarioComparisonAttempt>{
  try{
    const request=ScenarioComparisonRequest.parse(input);
    if(new Set(request.scenarioIds).size!==request.scenarioIds.length)throw Error('请选择不同的方案');
    const packs=request.scenarioIds.map(id=>{const matches=scenarios.filter(s=>s.scenarioId===id);if(matches.length!==1)throw Error('方案缺失或身份重复：'+id);return calculationInput(matches[0] as Scenario,library);});
    const count=request.scan?request.scan.searchRange.max-request.scan.searchRange.min+1:0,total=packs.length*(1+count);
    if(count<0||request.scan&&count===0||!Number.isSafeInteger(total)||total>MAX_COMPARISON_ANALYSES)throw Error(`每次比较最多 ${MAX_COMPARISON_ANALYSES} 次分析，且扫描范围必须有序`);
    if(request.scan&&new Set(packs.map(p=>p.scenario.workload.kind)).size!==1)throw Error('扫描交叉点需要相同推理阶段');
    const assets=[...new Map(packs.flatMap(p=>p.assets).map(a=>[a.assetId+'@'+a.revision,a])).values()];
    // canonicalInput removes editorial metadata and selects only reachable definitions.
    const normalized=packs.map(p=>{const value=JSON.parse(p.canonicalInput) as {scenario:Scenario;assets:AssetDocument[]};const {scenarioId,...scenario}=value.scenario;void scenarioId;return {scenario:{...scenario,numericOverrides:scenario.numericOverrides.map(o=>o.target.kind==='scenario'?{...o,target:{...o.target,scenarioId:'$self'}}:o)},assets:Object.fromEntries(value.assets.map(a=>[a.assetId+'@'+a.revision,a]))};});
    const entries:Extract<ScenarioComparisonAttempt,{status:'available'}>['result']['entries']=[];let completed=0;
    for(const [index,pack] of packs.entries()){
      if(control.isCancelled?.())break;
      const analysis=await analyzeScenario(pack.scenario,pack.assets);completed++;control.onProgress?.(completed,total);await control.yieldControl?.();
      const scan=request.scan&&!control.isCancelled?.()?await searchCapacity(pack.scenario,pack.assets,request.scan,{...control,onProgress:(n)=>control.onProgress?.(completed+n,total)}):undefined;
      completed+=scan?.status==='available'?scan.result.points.length:0;
      entries.push({scenario:pack.scenario,analysis,changes:comparisonInputChanges(normalized[0],normalized[index]),...(scan?{scan}:{})});
      if(scan?.status==='available'&&scan.result.completion==='cancelled')break;
      await control.yieldControl?.();
    }
    if(!entries.length)throw Error('比较已取消，尚无完成的方案');
    const pairs:Extract<ScenarioComparisonAttempt,{status:'available'}>['result']['pairs']=[];
    if(request.scan)for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
      const a=entries[i],b=entries[j];if(!a||!b)continue;
      pairs.push({leftScenarioId:a.scenario.scenarioId,rightScenarioId:b.scenario.scenarioId,expectedPoints:count,...sampledCrossings(a.scan?.status==='available'?a.scan.result.points:[],b.scan?.status==='available'?b.scan.result.points:[])});
    }
    const attempt=ScenarioComparisonAttempt.parse({status:'available',result:{version:'scenario-comparison.1',engineVersion:ENGINE_VERSION,request,completion:control.isCancelled?.()||entries.length!==packs.length?'cancelled':'complete',assets,entries,pairs,assumptions:[
      '结果逐项复用同一理论引擎；不同工作负载、硬件、布局与有效参数是作者声明的不同假设，不自动归因。',
      '扫描穷举指定闭区间内每个整数；仅报告完全相等的采样点与相邻严格排序变化区间，不插值、不证明连续交点、唯一性或区间外行为。',
      '缺项不补零；理论耗时即使超显存仍可展示，超容量点不构成可运行建议；容量最大值只限各自指定范围。',
      '跨方案模块按稳定 nodeId 对齐；未匹配模块保留缺失，不按名称猜测。父模块与子模块的耗时不累加。',
    ]}});
    if(attempt.status==='available'){const issues=validateScenarioComparison(attempt.result);if(issues.length)return {status:'unavailable',diagnostics:issues};}return attempt;
  }catch(e){return ScenarioComparisonAttempt.parse({status:'unavailable',diagnostics:[{diagnosticId:'comparison-invalid',severity:'error',code:'invalid_scenario_comparison',message:e instanceof Error?e.message:'比较失败',location:{kind:'file',name:'scenario-comparison'}}]});}
}
