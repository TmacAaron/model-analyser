import {expect,it} from 'vitest';
import {NodeId,StorageId} from '@model-analyser/contracts';
import {replayExactLeafSource,verifyExactLeafSourceReport} from '@model-analyser/core';
import {makeQuantizationScopeProject} from '../scripts/quantization-scope-project.js';
import {storageSourceRequest} from '../scripts/storage-source-projects.js';

const target={kind:'node' as const,nodeId:NodeId.parse('x')};

function mixedAccessProject(){
 const project=makeQuantizationScopeProject(),scenario=project.scenarios[0]!;
 const op=project.assetSnapshots.find(asset=>asset.definition.kind==='operator');
 if(op?.definition.kind!=='operator')throw Error('Expected operator');
 const [read,write]=op.definition.operator.cost.memoryAccess;
 if(!read||!write)throw Error('Expected two accesses');
 read.hbmEstimate={kind:'factor',value:.5};
 write.mode='write';
 write.hbmEstimate={kind:'bytes',value:{kind:'literal',quantity:{value:5,unit:'byte'}}};
 scenario.numericOverrides=[
  {target,field:'traffic_bytes',value:{value:60,unit:'byte'},description:'User traffic estimate'},
  {target:{kind:'storage',storageId:StorageId.parse('x::left')},field:'memory_bytes',value:{value:6,unit:'byte'}},
 ];
 return project;
}

it('uses final allocation to split total traffic and preserves independent HBM bytes',async()=>{
 const project=mixedAccessProject();
 const request=await storageSourceRequest(project,'x');
 const report=await replayExactLeafSource({...request,proofVersion:4});
 if(report.kind!=='leaf_storage_source'||report.schemaVersion!==4)throw Error('Expected version 4 storage report');
 expect(report.metric.quantity.value).toBe(14);
 expect(report.storageAccessSource.trafficOverride).toMatchObject({overrideIndex:0,previousTotal:20});
 expect(report.storageAccessSource.items).toMatchObject([
  {traffic:{before:6,after:18,fraction:.3},factor:.5,contribution:{value:9},storage:{bytes:6}},
  {traffic:{before:14,after:42,fraction:.7,independent:true},explicitProof:{quantity:{value:5,unit:'byte'}},contribution:{value:5}},
 ]);
 expect(report.complete).toBe(true);
 expect(await verifyExactLeafSourceReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
 const tampered=structuredClone(report);
 tampered.storageAccessSource.trafficOverride!.overrideIndex=1;
 await expect(verifyExactLeafSourceReport(tampered)).rejects.toThrow('固定输入复算不同');
});

it('retains write accesses in the original denominator for the read-only metric',async()=>{
 const request=await storageSourceRequest(mixedAccessProject(),'x','logicalReadBytes');
 const report=await replayExactLeafSource({...request,proofVersion:4});
 if(report.kind!=='leaf_storage_source')throw Error('Expected storage report');
 expect(report.metric.quantity.value).toBe(18);
 expect(report.storageAccessSource.items).toMatchObject([
  {traffic:{relevant:true,previousSum:{left:0,right:6,value:6}},contribution:{value:18}},
  {traffic:{relevant:false,previousSum:{left:6,right:14,value:20}},contribution:{value:0}},
 ]);
});

it('applies compute and memory efficiency to the real Roofline inputs after traffic override',async()=>{
 const project=mixedAccessProject();
 project.scenarios[0]!.numericOverrides.push(
  {target,field:'compute_efficiency',value:{value:.25,unit:'ratio'}},
  {target,field:'memory_efficiency',value:{value:.5,unit:'ratio'}},
 );
 const report=await replayExactLeafSource({...await storageSourceRequest(project,'x','seconds'),proofVersion:4});
 if(report.kind!=='leaf_timing_source'||report.schemaVersion!==4)throw Error('Expected version 4 timing report');
 expect(report.metric.quantity.value).toBe(.28);
 expect(report.timingOverrides).toMatchObject([
  {overrideIndex:2,before:{computeEfficiency:1},after:{computeEfficiency:.25,memoryEfficiency:1}},
  {overrideIndex:3,before:{memoryEfficiency:1,computeEfficiency:.25},after:{memoryEfficiency:.5,computeEfficiency:.25}},
 ]);
 expect(report.dag.nodes.find(node=>node.id==='hbm.work')?.value).toBe(14);
 expect(report.storageAccessSource.total.value).toBe(14);
 expect(report.coverage.completeTimingTransform).toBe(true);
 expect(await verifyExactLeafSourceReport(report)).toEqual(report);
});

it('uses zero fixed time as a complete expression root even when HBM is unavailable',async()=>{
 const project=makeQuantizationScopeProject();
 const op=project.assetSnapshots.find(asset=>asset.definition.kind==='operator');
 if(op?.definition.kind!=='operator')throw Error('Expected operator');
 for(const access of op.definition.operator.cost.memoryAccess)delete access.hbmEstimate;
 project.scenarios[0]!.numericOverrides=[{target,field:'fixed_seconds',value:{value:0,unit:'second'}}];
 const report=await replayExactLeafSource({...await storageSourceRequest(project,'x','seconds'),proofVersion:4});
 if(report.kind!=='leaf_cost_source'||report.schemaVersion!==4)throw Error('Expected fixed time report');
 expect(report.complete).toBe(true);
 expect(report.metric.quantity.value).toBe(0);
 expect(report.items).toMatchObject([{field:'timing.fixedSeconds',contribution:{value:0,unit:'second'}}]);
 expect(report.timingOverrides[0]).toMatchObject({overrideIndex:0,before:{kind:'roofline_bound'},after:{kind:'fixed',seconds:0}});
 await expect(replayExactLeafSource({...report.request,proofVersion:3})).rejects.toThrow('成本覆盖');
});
