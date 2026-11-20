import { AssetDocument,AssetRef,ProjectDocument,Scenario,NodeId } from '@model-analyser/contracts';
import { remapReferenceAssets } from './local-gemm-project.js';
import { makeSerialGatherProject } from './serial-gather-project.js';

/** Same model, two explicit M/time/hardware configurations; independent values:2s→5s,64B→128B. */
export function makeMetricSourceProject(base:ProjectDocument,mixed=false):ProjectDocument{
  const p=ProjectDocument.parse(base),original=p.scenarios[0],hardware=p.assetSnapshots.find(a=>a.definition.kind==='hardware');
  if(!original||hardware?.definition.kind!=='hardware')throw Error('C01 fixture required');
  const ids=new Map(p.assetSnapshots.filter(a=>['operator','module','model'].includes(a.definition.kind)).map(a=>[a.assetId,a.assetId+':metric-source'+(mixed?'-mixed':'')]));
  p.assetSnapshots=remapReferenceAssets(p.assetSnapshots,ids);
  if(mixed){const op=p.assetSnapshots.find(a=>a.definition.kind==='operator');if(op?.definition.kind!=='operator')throw Error('Operator required');const segment=op.definition.operator.cost.compute[0];if(!segment)throw Error('Compute required');op.definition.operator.cost.compute.push({...structuredClone(segment),segmentId:'independent-vector',computeClass:{...segment.computeClass,resource:'vector',multiplyDtype:{category:'float',bits:32,format:'fp32'}},usefulOperations:{kind:'literal',quantity:{value:2,unit:'operation'}},executedOperations:{kind:'literal',quantity:{value:3,unit:'operation'}}});}
  const h0=AssetDocument.parse({...hardware,assetId:'example:hardware:metric-source64',name:'Explicit64B source',sources:[{kind:'note',text:'Independent synthetic64byte capacity, not a GPU specification.'}],definition:{kind:'hardware',hardware:{...hardware.definition.hardware,capacityBytes:64}}});
  const h1=AssetDocument.parse({...h0,assetId:'example:hardware:metric-source128',name:'Explicit128B source',sources:[{kind:'note',text:'Independent synthetic128byte capacity, not a GPU specification.'}],definition:{kind:'hardware',hardware:{...hardware.definition.hardware,capacityBytes:128}}});
  p.assetSnapshots.push(h0,h1);
  p.scenarios=[h0,h1].map((h,i)=>{
    const scenarioId='example:scenario:metric-source-'+i;
    return Scenario.parse({...original,scenarioId,name:i?'当前 5s':'基准 2s',model:{...original.model,assetId:ids.get(original.model.assetId)},deviceTopology:{...original.deviceTopology,devices:original.deviceTopology.devices.map(d=>({...d,hardware:AssetRef.parse({assetId:h.assetId,revision:1,kind:'hardware'})}))},numericOverrides:[{target:{kind:'scenario',scenarioId},field:'parameter',parameterKey:'M',value:{value:i?5:4,unit:'count'},description:'Explicit actual M for this configuration'},{target:{kind:'node',nodeId:NodeId.parse('module/op')},field:'fixed_seconds',value:{value:i?5:2,unit:'second'},description:i?'Current declared5seconds':'Baseline declared2seconds'}],quantizationOverrides:[],fusionGroups:[]});
  });
  p.projectId='example:project:metric-source'+(mixed?'-mixed':'');p.name='同模型指标来源'+(mixed?' · 混合精度':'');p.measurements=[];
  return ProjectDocument.parse(p);
}

/** Two explicitly placed network events in the same physical group; their group totals add. */
export function makeMetricCommunicationProject(base:ProjectDocument):ProjectDocument{
  const p=makeSerialGatherProject(base),first=p.scenarios[0],event=first?.parallelPlan.communications[0];
  if(!first||!event?.placement)throw Error('Placed gather required');
  first.parallelPlan.communications.push({...structuredClone(event),placement:{...event.placement,nodeId:NodeId.parse('gather-Y-second'),afterNodeIds:[event.placement.nodeId]}});
  first.name='两次通信基准';
  p.scenarios.push(Scenario.parse({...first,scenarioId:first.scenarioId+':copy',name:'两次通信副本'}));
  p.projectId='example:project:metric-communication';p.name='同组两事件来源';
  return ProjectDocument.parse(p);
}
