import { AssetDocument,ProjectDocument } from '@model-analyser/contracts';
import { makeMetricSourceProject } from './metric-source-project.js';
import { remapReferenceAssets } from './local-gemm-project.js';
/** Complete replicated GQA snapshots supplied by the independent GQA fixture. */
export function makeExecutedUtilizationProject(base:ProjectDocument){
  const p=ProjectDocument.parse(base),s=p.scenarios[0],device=s?.deviceTopology.devices[1],hardware=device?p.assetSnapshots.find(a=>a.assetId===device.hardware.assetId&&a.revision===device.hardware.revision):undefined;
  if(!s||s.deviceTopology.devices.length!==2||!device||hardware?.definition.kind!=='hardware')throw Error('Two-device replicated GQA reference required');
  const second=AssetDocument.parse({...hardware,assetId:'example:hardware:executed-uneven',name:'Artificial second card:2000 operation/s,300 byte/s',sources:[{kind:'note',text:'Artificial independent utilization ledger; not a GPU specification or measured counter.'}]});
  if(second.definition.kind!=='hardware')throw Error();second.definition.hardware.computeCapabilities.forEach(c=>c.operationsPerSecond=2000);second.definition.hardware.memoryCapabilities.forEach(c=>c.bytesPerSecond=300);
  p.assetSnapshots.push(second);device.hardware={assetId:second.assetId,revision:1,kind:'hardware'};s.deviceTopology.groups.push({...structuredClone(s.deviceTopology.groups[0]!),groupId:'same-physical-alias'});
  p.projectId='example:project:executed-utilization';p.name='有效480／执行960 · 异构逐卡峰值';p.measurements=[];return p;
}
export function makeMixedExecutedUtilizationProject(base:ProjectDocument){
  const p=makeMetricSourceProject(base,true),ids=new Map(p.assetSnapshots.filter(a=>['operator','module','model','hardware'].includes(a.definition.kind)).map(a=>[a.assetId,a.assetId+':executed-utilization']));p.assetSnapshots=remapReferenceAssets(p.assetSnapshots,ids);p.scenarios=[p.scenarios[0]!];const s=p.scenarios[0]!;s.model={...s.model,assetId:AssetDocument.shape.assetId.parse(ids.get(s.model.assetId))};for(const d of s.deviceTopology.devices)d.hardware={...d.hardware,assetId:AssetDocument.shape.assetId.parse(ids.get(d.hardware.assetId))};
  const op=p.assetSnapshots.find(a=>a.definition.kind==='operator'),hw=p.assetSnapshots.find(a=>a.assetId===s.deviceTopology.devices[0]!.hardware.assetId);if(op?.definition.kind!=='operator'||hw?.definition.kind!=='hardware')throw Error();
  const vector=op.definition.operator.cost.compute[1]!,segment=op.definition.operator.cost.compute[0]!,int={category:'int' as const,bits:8,format:'int8'},computeClass={...segment.computeClass,arithmetic:'integer' as const,inputDtypes:[int,int],multiplyDtype:int,accumulateDtype:{category:'int' as const,bits:32,format:'int32'}};
  op.definition.operator.cost.compute.push({...segment,segmentId:'independent-integer',computeClass,usefulOperations:{kind:'literal',quantity:{value:7,unit:'operation'}},executedOperations:{kind:'literal',quantity:{value:9,unit:'operation'}}});hw.definition.hardware.computeCapabilities.push({kind:'peak',computeClass:vector.computeClass,operationsPerSecond:10},{kind:'peak',computeClass,operationsPerSecond:7});
  p.projectId='example:project:mixed-executed-utilization';p.name='独立matrix／vector／integer执行利用率';return ProjectDocument.parse(p);
}
