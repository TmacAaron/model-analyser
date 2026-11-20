import type { ScenarioComparisonResult,Diagnostic,ScenarioCrossing } from './index.js';
import { canonical } from './validation.js';
import { validateCapacitySearch } from './capacity-validation.js';
import { validateResult } from './result-validation.js';

/** Check identity, completeness and sampled evidence independently of generation. */
export function validateScenarioComparison(r:ScenarioComparisonResult):Diagnostic[]{
  const issues:Diagnostic[]=[];
  const report=(message:string)=>issues.push({diagnosticId:'comparison-validation-'+issues.length,severity:'error',code:'invalid_comparison_result',message,location:{kind:'file',name:'scenario-comparison'}});
  const ids=r.request.scenarioIds;
  if(r.request.scan){const range=r.request.scan.searchRange,count=range.max-range.min+1;if(!Number.isSafeInteger(count)||count<1||count>512){report('比较扫描区间无效或超过逐点预算');return issues;}}
  if(new Set(ids).size!==ids.length||r.entries.length>ids.length||r.entries.some((e,i)=>e.scenario.scenarioId!==ids[i])||r.completion==='complete'&&r.entries.length!==ids.length)report('方案必须按请求顺序出现，完整结果不能缺少方案');
  if(r.entries[0]?.changes.length)report('基准方案不能有自身输入差异');
  for(const e of r.entries){
    if(e.analysis.status==='available'){if(e.analysis.result.scenarioId!==e.scenario.scenarioId||e.analysis.result.engineVersion!==r.engineVersion)report('分析结果身份或引擎不符');issues.push(...validateResult(e.analysis.result));}
    if(!r.request.scan&&e.scan)report('没有扫描请求却包含扫描结果');
    if(r.completion==='complete'&&r.request.scan&&!e.scan)report('完整比较缺少扫描尝试');
    if(e.scan?.status==='available'){
      issues.push(...validateCapacitySearch(e.scan.result));
      if(canonical(e.scan.result.request)!==canonical(r.request.scan)||canonical(e.scan.result.baseScenario)!==canonical(e.scenario)||e.scan.result.engineVersion!==r.engineVersion)report('扫描请求、固定输入或引擎不符');
      if(e.analysis.status==='available'&&e.analysis.result.inputHash!==e.scan.result.baseInputHash)report('扫描与原始分析输入 hash 不符');
      if(r.completion==='complete'&&e.scan.result.completion!=='complete')report('取消扫描不能声明完整比较');
    }
    const paths=e.changes.map(c=>c.path);if(new Set(paths).size!==paths.length||e.changes.some(c=>!c.path.startsWith('/')||!Object.hasOwn(c,'before')&&!Object.hasOwn(c,'after')||Object.hasOwn(c,'before')&&Object.hasOwn(c,'after')&&canonical(c.before)===canonical(c.after)))report('输入差异必须是唯一且有变化的 JSON Pointer');
  }
  const expectedPairs=r.request.scan?r.entries.length*(r.entries.length-1)/2:0;
  if(r.pairs.length!==expectedPairs||new Set(r.pairs.map(p=>p.leftScenarioId+'\0'+p.rightScenarioId)).size!==r.pairs.length)report('扫描方案对缺失或重复');
  for(const pair of r.pairs){
    const a=r.entries.findIndex(e=>e.scenario.scenarioId===pair.leftScenarioId),b=r.entries.findIndex(e=>e.scenario.scenarioId===pair.rightScenarioId),scan=r.request.scan;
    if(a<0||b<=a||!scan){report('方案对身份或顺序无效');continue;}
    const left=r.entries[a]?.scan,right=r.entries[b]?.scan,pointsA=left?.status==='available'?left.result.points:[],pointsB=right?.status==='available'?right.result.points:[];
    const samples=new Map(pointsA.map(p=>[p.value,p])),other=new Map(pointsB.map(p=>[p.value,p])),events:ScenarioCrossing[]=[];let known=0,lastValue:number|undefined,lastSign:number|undefined;
    for(let x=scan.searchRange.min;x<=scan.searchRange.max;x++){
      const p=samples.get(x),q=other.get(x);
      if(p?.status!=='available'||q?.status!=='available'||p.seconds.status!=='available'||q.seconds.status!=='available'){lastSign=undefined;lastValue=undefined;continue;}
      known++;const v=p.seconds.quantity.value,w=q.seconds.quantity.value,sign=v===w?0:v<w?-1:1;
      if(sign===0){const end=events.at(-1);if(end?.kind==='equal_samples'&&end.upper===x-1)end.upper=x;else events.push({kind:'equal_samples',lower:x,upper:x});}
      else if(lastValue===x-1&&lastSign!==undefined&&lastSign!==0&&lastSign!==sign)events.push({kind:'ordering_change',lower:x-1,upper:x});lastValue=x;lastSign=sign;
    }
    if(pair.expectedPoints!==scan.searchRange.max-scan.searchRange.min+1||pair.knownPoints!==known||canonical(pair.crossings)!==canonical(events))report('交叉点或共同覆盖数量没有对应的相邻整数时间证据');
  }
  return issues;
}
