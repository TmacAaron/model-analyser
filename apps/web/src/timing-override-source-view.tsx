import type {ExactLeafSourceReport} from '@model-analyser/core';

type OverrideReport=Extract<ExactLeafSourceReport,{schemaVersion:4}>;

export function TimingOverrideSource({report}:{report:OverrideReport}){
 if(!report.timingOverrides.length)return null;
 return <section className="storage-access-item" aria-label="实际耗时覆盖">
  <h4>实际耗时覆盖</h4>
  {report.timingOverrides.map(({override,overrideIndex,before,after})=>{
   const label=override.field==='fixed_seconds'?'固定耗时':override.field==='compute_efficiency'?'计算效率':'显存带宽效率';
   const previous=before.kind==='roofline_bound'&&override.field==='compute_efficiency'?before.computeEfficiency:before.kind==='roofline_bound'&&override.field==='memory_efficiency'?before.memoryEfficiency:undefined;
   return <div key={overrideIndex}><p>规则 #{overrideIndex} · {label} · {previous===undefined?'':`${previous} → `}{override.value.value} {override.value.unit}</p>
    {after.kind==='fixed'&&<p>原耗时策略 {before.kind}，当前直接使用 {after.seconds} 秒。</p>}
    {override.description&&<p>{override.description}</p>}
   </div>;
  })}
 </section>;
}
