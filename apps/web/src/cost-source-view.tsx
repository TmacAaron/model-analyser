import { useDisplayUnits } from './display-units.js';
import { useDeferredValue,useEffect,useMemo,useRef,useState } from 'react';
import type { AnalysisResult,AssetDocument,Scenario } from '@model-analyser/contracts';

import type {FusionCostSelector,FusionSourceOperand,LocalCostSelector,LogicalWorkSourceMember} from '@model-analyser/core';
import { LeafCostSourceView } from './leaf-cost-source-view.js';
import {AggregateCostSourceView,type AggregateSourceMember} from './aggregate-cost-source-view.js';
import {CommunicationCostSourceView} from './communication-cost-source-view.js';
import {LocalCostSourceView} from './local-cost-source-view.js';
import {FusionCostSourceView} from './fusion-cost-source-view.js';
import {LogicalWorkSourceView} from './logical-work-source-view.js';
import {LayoutSourceView} from './layout-source-view.js';
import {logicalTargetId} from './compute-source.js';
import {canonical} from '../../../packages/contracts/src/validation.js';
import {findSourceTarget,fusionDeviceId,indexSourceTargets,localId,sourceFrame,sourceProblem} from './cost-source-index.js';
import {ConfigurationEvidence,ProvenanceEvidence,useSourceAssets} from './cost-source-evidence.js';

export {resolveSourceSelection} from './cost-source-index.js';
export type SourceSelection={targetId:string;metricId:string;step?:number;nonce:number};
function Sources({result,scenario,assets,selection}:{result:AnalysisResult;scenario:Scenario;assets:AssetDocument[];selection?:SourceSelection|undefined}){
  const display=useDisplayUnits();

  const [step,setStep]=useState('aggregate'),[query,setQuery]=useState(''),[targetId,setTarget]=useState('model'),[metricId,setMetric]=useState('seconds');
  useEffect(()=>{if(selection){setStep(selection.step===undefined?'aggregate':String(selection.step));setTarget(selection.targetId);setMetric(selection.metricId);setQuery(selection.targetId==='model'?'':selection.targetId);}},[selection]);
  const frame=useMemo(()=>sourceFrame(result,step),[result,step]);
  const {report,actual}=frame;
  const index=useMemo(()=>report?indexSourceTargets(report,actual):undefined,[report,actual]);
  const target=index?.targets.get(targetId);
  const metrics=useMemo(()=>target?.readMetrics()??[],[target]);
  const metric=metrics.find(item=>item.id===metricId);
  const deferredQuery=useDeferredValue(query);
  const {count,visible}=useMemo(()=>index?.search(deferredQuery)??{count:0,visible:[]},[index,deferredQuery]);
  const options=target&&!visible.some(item=>item.id===targetId)?[target,...visible]:visible;
  const value=metric?.value,provenance=value?.status==='available'?value.provenance:undefined;
  const diagnostics=useMemo(()=>value?.diagnosticIds.map(id=>report?.diagnostics.find(d=>d.diagnosticId===id)?.message??id)??[],[value,report]);
  const sourceScenario=frame.scenario??scenario,findAsset=useSourceAssets(assets);
  const problem=sourceProblem(report,target,metric);
  const proofStep=step==='aggregate'?undefined:Number(step);
  const aggregate=targetId==='model'||targetId.startsWith('module:')||!!result.decode&&step==='aggregate'&&targetId.startsWith('node:')?metric?.aggregateSelector:undefined;
  const communication=value&&metric?.communicationSelector?<CommunicationCostSourceView metric={value} selector={metric.communicationSelector} result={result} scenario={scenario} assets={assets} step={proofStep}/>:undefined;
  function goToLocalOperand(selector:LocalCostSelector){
   const key=canonical(selector),matching=metrics.find(item=>canonical(item.localSelector)===key);
   if(matching)return ()=>setMetric(matching.id);
  }
  const local=value&&metric?.localSelector?<LocalCostSourceView metric={value} selector={metric.localSelector} result={result} scenario={scenario} assets={assets} step={proofStep} goTo={goToLocalOperand}/>:undefined;
  function goToFusionTerm(term:FusionSourceOperand,operandSelector?:FusionCostSelector){
   const source=operandSelector??metric?.fusionSelector;
   if(!source||term.deviceId===undefined)return;
   const id=term.kind==='device'?fusionDeviceId(term.nodeId,term.deviceId):localId(term.nodeId,term.deviceId);
   const matching=index?.targets.get(id)?.readMetrics().find(m=>{
    const candidate=m.fusionSelector??m.localSelector;
    return candidate?.field===source.field&&canonical(candidate.computeClass)===canonical(source.computeClass)&&
     (!operandSelector||canonical(candidate.scope)===canonical(operandSelector.scope))&&
     (term.computeIndex===undefined||m.localSelector?.computeIndex===term.computeIndex);
   });
   if(matching)return ()=>{setTarget(id);setMetric(matching.id);setQuery('');};
  }
  const fusion=value&&metric?.fusionSelector?<FusionCostSourceView metric={value} selector={metric.fusionSelector} result={result} scenario={scenario} assets={assets} step={proofStep} goTo={goToFusionTerm}/>:undefined;
  function navigateLogical(member:LogicalWorkSourceMember){
   const actual=member.step?result.decode?.steps.find(item=>item.index===member.step?.index):undefined;
   const selected=metric?.logicalSelector;
   if(!selected)return;
   const identity={scope:member.scope,field:selected.field,computeClass:selected.computeClass,...(member.fusionNodeId?{fusionNodeId:member.fusionNodeId}:{})};
   const id=member.fusionNodeId?'logical-extra:'+member.fusionNodeId:logicalTargetId(member.scope.target);
   const next=member.step?(actual?findSourceTarget(actual.result,id,true):undefined):index?.targets.get(id);
   const identityKey=canonical(identity);
   const matching=next?.readMetrics().find(item=>canonical(item.logicalSelector)===identityKey);
   setStep(member.step?String(member.step.index):step);
   setTarget(matching?id:'logical:missing');
   setMetric(matching?.id??metricId);
   setQuery('');
  }
  const logical=value&&metric?.logicalSelector?<LogicalWorkSourceView metric={value} selector={metric.logicalSelector} result={result} scenario={scenario} assets={assets} step={proofStep} onNavigate={navigateLogical}/>:undefined;
  const layout=metric?.layoutSelector&&report?<LayoutSourceView selector={metric.layoutSelector} anchor={{scenario:sourceScenario,assets,inputHash:report.inputHash,engineVersion:report.engineVersion,...(report.stepContext?{stepContext:report.stepContext}:{})}}/>:undefined;
  function selectStep(next:string){
   const selected=metric?.logicalSelector;
   const frame=next==='aggregate'?result:result.decode?.steps.find(item=>String(item.index)===next)?.result;
   if(selected&&frame){
    const destination=next===step?target:findSourceTarget(frame,targetId,next!=='aggregate');
    const matching=destination?.readMetrics().find(item=>item.logicalSelector?.field===selected.field&&canonical(item.logicalSelector.computeClass)===canonical(selected.computeClass));
    setMetric(matching?.id??'missing:'+selected.field);
   }
   setStep(next);
  }
  const devices=useMemo(()=>{
   const selected=metric?.aggregateSelector;
   if(!targetId.startsWith('node:')||!selected)return [];
   const selectorClass=canonical(selected.computeClass);
   return (index?.localByNode.get(targetId.slice(5))??[]).flatMap(item=>{
    const matching=item.readMetrics().find(candidate=>candidate.localSelector?.field===selected.field&&canonical(candidate.localSelector.computeClass)===selectorClass);
    return matching&&item.local?[{id:item.id,deviceId:item.local.deviceId,metricId:matching.id}]:[];
   });
  },[index,metric,targetId]);
  const deviceChoices=devices.length>0&&<div className="button-row">{devices.slice(0,20).map(device=><button key={device.id} onClick={()=>{
   setTarget(device.id);setMetric(device.metricId);setQuery('');
  }}>查看 {device.deviceId} 的局部方程</button>)}{devices.length>20&&<button onClick={()=>setQuery(targetId.slice(5))}>查找其余设备</button>}</div>;
  function navigate(member:AggregateSourceMember){
   const nextStep=member.step?String(member.step.index):step;
   const frame=nextStep==='aggregate'?result:result.decode?.steps.find(item=>String(item.index)===nextStep)?.result;
   const nodeId=member.target.kind==='node'?member.target.nodeId:undefined;
   const network=member.kind==='communication'&&aggregate?.field==='seconds'&&nodeId?frame?.distributed?.layout.communications.find(c=>c.evaluation.definition.placement?.nodeId===nodeId):undefined;
   const nextTarget=network?`communication:${network.index}`:member.target.kind==='model'?'model':`${member.kind==='fusion'?'fusion':member.target.kind}:${member.target.nodeId}`;
   const next=nextStep===step?index?.targets.get(nextTarget):frame&&findSourceTarget(frame,nextTarget,nextStep!=='aggregate');
   const matching=next?.readMetrics().find(item=>item.aggregateSelector?.field===aggregate?.field&&canonical(item.aggregateSelector?.computeClass)===canonical(aggregate?.computeClass));
   setStep(nextStep);setTarget(nextTarget);setMetric(matching?.id??`missing:${aggregate?.field}`);setQuery('');
  }
  return <div className="cost-source-content"><p className="scope-note">按当前结果查看实际值、精度、固定公式与求值假设。引用沿用引擎记录，可能包含所属范围共用依赖，不表示每个公式都单独贡献于此指标。下方覆盖声明表是输入来源清单；生效/优先级以所选指标与结构参数来源为准，不把声明表再次计入成本。</p>
    {result.decode&&<label>来源步骤<select aria-label="来源步骤" value={step} onChange={e=>selectStep(e.target.value)}><option value="aggregate">完整序列汇总</option>{step!=='aggregate'&&!result.decode.steps.some(s=>String(s.index)===step)&&<option value={step} disabled>缺失步骤 · {step}</option>}{result.decode.steps.map(s=><option key={s.index} value={s.index}>步骤 {s.index+1} · context {s.evaluatedContext}</option>)}</select></label>}
    <div className="preset-fields">
      <label>查找范围<input aria-label="查找成本来源范围" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <label>结果范围<select aria-label="成本来源范围" value={targetId} onChange={e=>{
        const id=e.target.value,nextMetrics=index?.targets.get(id)?.readMetrics()??[];
        setTarget(id);
        setMetric(nextMetrics.find(item=>item.id===metricId)?.id??nextMetrics[0]?.id??'seconds');
      }}>
        {!target&&<option value={targetId} disabled>缺失范围 · {targetId}</option>}
        {options.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <label>指标<select aria-label="成本来源指标" value={metricId} onChange={e=>setMetric(e.target.value)}>
        {!metric&&<option value={metricId} disabled>缺失指标 · {metricId}</option>}
        {metrics.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
    </div>
    {count>100&&<p>显示匹配的前 100/{count} 个范围；输入节点、存储或设备 ID 查看其余范围。</p>}
    {problem&&<p role="status">{problem}</p>}
    {value&&<section className="metric-source-proof">
      <h4>{target?.label} · {metric?.label}</h4>
      {value.status==='available'?<>
        <p className="source-value">{display.metric(value)} · {value.basis}<small>原始 {value.quantity.value} {value.quantity.unit}</small></p>
        {layout??logical??fusion??local??communication??(
          aggregate?<AggregateCostSourceView metric={value} selector={aggregate} result={result} scenario={scenario} assets={assets} step={proofStep} onNavigate={navigate}/>:
          devices.length?deviceChoices:
          <LeafCostSourceView metric={value} selector={metric?.selector} result={result} scenario={scenario} assets={assets} frame={step==='aggregate'?(result.decode?undefined:0):Number(step)}/>
        )}
        {provenance&&<ProvenanceEvidence provenance={provenance} findAsset={findAsset} parameters={report?.parameterTrace}
          missingParameters={result.decode&&step==='aggregate'?'序列各步参数可能不同，请选择来源步骤查看该步实际求值。':'此旧结果没有记录参数值，请重新计算；不会用当前默认值补填。'}/>}
      </>:<>
        <p>不可用；缺项未补零。</p>{fusion??local??communication??deviceChoices}
      </>}
      {diagnostics.length>0&&<div className="source-diagnostics">{diagnostics.map((d,i)=><p key={i}>{d}</p>)}</div>}
    </section>}
    <ConfigurationEvidence scenario={sourceScenario} findAsset={findAsset}/>
  </div>;
}
export function CostSourceInspector(props:{result:AnalysisResult;scenario:Scenario;assets:AssetDocument[];selection?:SourceSelection|undefined}){const [open,setOpen]=useState(false),container=useRef<HTMLDetailsElement>(null);useEffect(()=>{if(props.selection){setOpen(true);container.current?.scrollIntoView({block:'nearest'});}},[props.selection]);return <details ref={container} open={open} className="cost-source-inspector" onToggle={e=>setOpen(e.currentTarget.open)}><summary>成本与覆盖来源</summary>{open&&<Sources {...props}/>}</details>;}
