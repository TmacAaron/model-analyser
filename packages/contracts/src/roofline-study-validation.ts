import type { RooflineStudyResult,Diagnostic,RooflineBalance,RooflineObservation,MetricValue,RooflineStudyTransition } from './index.js';
import { canonical } from './validation.js';
import { validateResult } from './result-validation.js';
import { validateCapacitySearch } from './capacity-validation.js';
const near=(a:number,b:number)=>a===b||Math.abs(a-b)<=Math.max(Math.abs(a),Math.abs(b))*1e-12;
/** Algebra/identity/coverage evidence, independent of study generation. */
export function validateRooflineStudy(r:RooflineStudyResult):Diagnostic[]{
  const issues:Diagnostic[]=[];const report=(message:string)=>issues.push({diagnosticId:'roofline-study-validation-'+issues.length,severity:'error',code:'invalid_roofline_study_result',message,location:{kind:'file',name:'roofline-study'}});
  const scan=r.request.scan,count=scan?scan.searchRange.max-scan.searchRange.min+1:0;
  if(new Set(r.assets.map(a=>a.assetId+'@'+a.revision)).size!==r.assets.length)report('固定资产身份重复，不能选择任意一个修订内容作为依据');
  if(scan&&(!Number.isSafeInteger(count)||count<1||count+1>512)){report('扫描范围无效或超出预算');return issues;}
  if(r.analysis.status==='available'){issues.push(...validateResult(r.analysis.result));if(r.analysis.result.engineVersion!==r.engineVersion||r.analysis.result.scenarioId!==r.scenario.scenarioId||r.base.inputHash!==r.analysis.result.inputHash)report('基础分析身份/引擎/hash不符');}
  else if(r.base.inputHash||r.base.observations.length)report('失败的基础分析不能生成点位或hash');
  if(!scan&&(r.scan||r.samples.length||r.transitions.length))report('没有扫描请求却存在扫描数据');
  if(scan&&r.completion==='complete'&&!r.scan)report('完整研究必须包含扫描尝试');
  if(r.scan?.status==='available'){
    issues.push(...validateCapacitySearch(r.scan.result));if(canonical(r.scan.result.request)!==canonical(scan)||canonical(r.scan.result.baseScenario)!==canonical(r.scenario)||r.scan.result.engineVersion!==r.engineVersion||r.analysis.status==='available'&&r.scan.result.baseInputHash!==r.analysis.result.inputHash)report('扫描请求、固定输入或引擎/hash不符');
    if(r.completion==='complete'&&r.scan.result.completion!=='complete')report('取消扫描不能声明完整研究');
    if(r.scan.result.points.length!==r.samples.length)report('扫描尝试与研究样本数量不符');
    for(const [i,p] of r.scan.result.points.entries()){const s=r.samples[i];if(!s||s.value!==p.value||(p.status==='available'?s.inputHash!==p.inputHash:s.inputHash!==undefined||s.observations.length!==0))report('样本身份或输入hash不匹配扫描点');}
  }else if(r.samples.length)report('没有成功扫描尝试却有样本');
  const actualDevices=new Set(r.scenario.deviceTopology.devices.map(d=>d.deviceId));
  for(const [i,s] of [r.base,...r.samples].entries()){
    if(i>0&&scan&&s.value!==scan.searchRange.min+i-1)report('整数样本必须按请求连续排列，未知点不能省略');
    const ids=new Map(s.diagnostics.map(d=>[d.diagnosticId,d]));if(ids.size!==s.diagnostics.length)report('样本诊断ID重复');
    function metricRefs(v:unknown){if(v&&typeof v==='object'){if('diagnosticIds' in v&&Array.isArray(v.diagnosticIds)){if(v.diagnosticIds.some(id=>!ids.has(id)))report('指标引用缺少诊断');if('status' in v&&v.status==='unavailable'&&!v.diagnosticIds.some(id=>ids.get(id)?.severity==='error'))report('缺项没有关联错误诊断');}for(const child of Object.values(v))metricRefs(child);}}
    metricRefs(s.observations);
    if(new Set(s.observations.map(o=>o.seriesId)).size!==s.observations.length)report('样本分类重复');
    for(const o of s.observations){const p=o.point;
      if(o.seriesId!==canonical({scope:p.scope,computeClass:p.computeClass})||canonical(p.scope.target)!==canonical(r.request.target)||new Set(p.scope.deviceIds).size!==p.scope.deviceIds.length||p.scope.deviceIds.some(id=>!actualDevices.has(id)))report('点位范围或分类身份不符，物理设备不能重复');
      if(new Set(o.sourceNodeIds).size!==o.sourceNodeIds.length)report('来源叶节点重复');
      if(p.arithmeticIntensity.status==='available'&&(p.operations.status!=='available'||p.trafficBytes.status!=='available'||p.trafficBytes.quantity.value<=0||!near(p.arithmeticIntensity.operationsPerByte,p.operations.quantity.value/p.trafficBytes.quantity.value)))report('算术强度不等于执行operations/流量');
      function balance(b:RooflineBalance,c:MetricValue,m:MetricValue){
        let expected:Extract<RooflineBalance,{status:'available'}>|undefined;
        if(c.status==='available'&&m.status==='available'&&p.operations.status==='available'&&p.trafficBytes.status==='available'){
          const x=p.operations.quantity.value,y=p.trafficBytes.quantity.value,ct=x/c.quantity.value,mt=y/m.quantity.value,ridge=c.quantity.value/m.quantity.value;
          if(c.quantity.value>0&&m.quantity.value>0&&Number.isFinite(ridge)&&ridge>0&&Number.isFinite(ct)&&Number.isFinite(mt)&&!(x>0&&ct===0)&&!(y>0&&mt===0)&&!(x===0&&y===0))expected={status:'available',ridgeOperationsPerByte:ridge,computeSeconds:ct,memorySeconds:mt,side:ct===mt?'balanced':ct>mt?'compute':'memory'};
        }
        if(b.status==='available'){if(!expected||!near(b.ridgeOperationsPerByte,expected.ridgeOperationsPerByte)||!near(b.computeSeconds,expected.computeSeconds)||!near(b.memorySeconds,expected.memorySeconds)||b.side!==expected.side)report('拐点、分量时间或限制侧无对应算术依据');}else if(expected)report('具备完整有限数据时不能无依据丢弃屋顶证据');
      }
      balance(o.effectiveBalance,p.computeCeiling,p.memoryBandwidth);balance(o.hardwareBalance,o.hardwareComputeCeiling,o.hardwareMemoryBandwidth);
      for(const [name,field,unit] of [['compute','hardwareComputeCeiling','operation_per_second'],['memory','hardwareMemoryBandwidth','byte_per_second']] as const){
        const caps=p.scope.deviceIds.map(id=>{const ref=r.scenario.deviceTopology.devices.find(d=>d.deviceId===id)?.hardware,a=r.assets.find(a=>a.assetId===ref?.assetId&&a.revision===ref.revision);return a?.definition.kind==='hardware'?name==='compute'?a.definition.hardware.computeCapabilities.filter(c=>canonical(c.computeClass)===canonical(p.computeClass)).map(c=>({value:c.operationsPerSecond,kind:c.kind})):a.definition.hardware.memoryCapabilities.filter(c=>c.key==='hbm').map(c=>({value:c.bytesPerSecond,kind:c.kind})):[];});
        const m=o[field],kind=name==='compute'?o.hardwareComputeKind:o.hardwareMemoryKind,known=caps.every(c=>c.length===1),total=caps.reduce((n,c)=>n+(c[0]?.value??0),0),kinds=new Set(caps.flat().map(c=>c.kind)),expectedKind=known?kinds.size===1?caps[0]?.[0]?.kind:'mixed':'unavailable';
        if(kind!==expectedKind||m.status==='available'&&(!known||m.quantity.unit!==unit||!near(m.quantity.value,total))||m.status==='unavailable'&&known&&Number.isFinite(total))report('硬件屋顶必须来自唯一物理设备的固定声明，不可重复或补值');
      }
    }
  }
  if(scan){
    const series=[...new Set([r.base,...r.samples].flatMap(s=>s.observations.map(o=>o.seriesId)))];if(r.transitions.length!==series.length*2||new Set(r.transitions.map(t=>t.seriesId+'\0'+t.roof)).size!==r.transitions.length)report('限制侧变化分类缺失或重复');
    for(const t of r.transitions){if(!series.includes(t.seriesId)){report('变化引用未知分类');continue;}let known=0,previous:{x:number;side:string}|undefined;const events:RooflineStudyTransition['events']=[];
      for(const s of r.samples){const o=s.observations.find(o=>o.seriesId===t.seriesId),b=t.roof==='effective'?o?.effectiveBalance:o?.hardwareBalance,x=s.value;if(x===undefined||b?.status!=='available'){previous=undefined;continue;}known++;if(b.side==='balanced'){const end=events.at(-1);if(end?.kind==='balanced_samples'&&end.upper===x-1)end.upper=x;else events.push({kind:'balanced_samples',lower:x,upper:x});}else if(previous&&previous.x===x-1&&previous.side!=='balanced'&&previous.side!==b.side)events.push({kind:'regime_change',lower:x-1,upper:x});previous={x,side:b.side};}
      if(t.knownPoints!==known||t.expectedPoints!==count||canonical(t.events)!==canonical(events))report('变化事件或共同覆盖数量缺少相邻整数样本依据');
    }
  }
  return issues;
}
