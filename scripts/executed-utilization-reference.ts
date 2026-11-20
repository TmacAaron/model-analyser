import assert from 'node:assert/strict';
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { ProjectDocument,MeasurementRecord,type MetricValue } from '@model-analyser/contracts';
import { analyzeScenario,compareMeasurement,computeInputHash } from '@model-analyser/core';
import { makeExecutedUtilizationProject,makeMixedExecutedUtilizationProject } from './executed-utilization-project.js';
import { makeDecodeProject } from './decode-project.js';
import { makeFusedProject } from './fused-project.js';
import { runMeasurementComparisons,type ComparedMeasurement } from '../apps/web/src/measurement-comparison-task.js';
import { createMeasurementReport,measurementReportCsv } from '../apps/web/src/measurement-report.js';

const base=ProjectDocument.parse(JSON.parse(await readFile('examples/contracts/project.json','utf8')) as unknown),gqa=ProjectDocument.parse(JSON.parse(await readFile('examples/gqa/replicated-project.json','utf8')) as unknown),dir='examples/executed-utilization';await mkdir(dir,{recursive:true});
const fixtures=[['replicated',makeExecutedUtilizationProject(gqa),480,960,3000],['single',base,1024,1024,1000],['decode',makeDecodeProject(base),5,5,1000],['fusion',makeFusedProject(base),5,6,1000],['mixed',makeMixedExecutedUtilizationProject(base),1024,1024,1000]] as const;
const n=(v:MetricValue|undefined)=>{if(v?.status!=='available')throw Error('Missing reference value');return v.quantity.value;},close=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-12*Math.max(1,Math.abs(b)),a+' != '+b),save=async(name:string,v:unknown)=>writeFile(dir+'/'+name+'.json',JSON.stringify(v,null,2)+'\n');const ledgers=[];
for(const [name,project,logical,executed,peak] of fixtures){
  const a=await analyzeScenario(project.scenarios[0]!,project.assetSnapshots);assert.equal(a.status,'available');if(a.status!=='available')throw Error();const r=a.result,frame=name==='decode'?r.decode!.steps[2]!:undefined,current=frame?.result??r,scenario=frame?.scenario??project.scenarios[0]!,records=[];
  for(const time of [{kind:'single',seconds:2},{kind:'mean',seconds:5},{kind:'sum',seconds:10},{kind:'span',startSeconds:100,endSeconds:110}] as const){
    const count=time.kind==='single'?1:2;records.push(MeasurementRecord.parse({measurementId:'example:executed:'+name+':'+time.kind,scenarioId:scenario.scenarioId,inputHash:current.inputHash,target:{kind:'model'},phase:current.phase,deviceIds:current.scope.deviceIds,interval:'Independent artificial '+name+' '+time.kind+' interval',count,time,...(count===2?{actualBytes:{readBytes:768,writeBytes:128,basis:'interval_total'}}:{}),source:{kind:'manual',mappingBasis:'Declared model/actual-call scope, not hardware counter data'}}));
  }
  records.push({...records[0]!,measurementId:'example:executed:'+name+':stale',inputHash:'older-input'});const unbound={...records[0]!,measurementId:'example:executed:'+name+':unbound'};delete unbound.inputHash;records.push(unbound);project.measurements=records;
  await save(name+'-project',project);const portable=ProjectDocument.parse(JSON.parse(await readFile(dir+'/'+name+'-project.json','utf8')) as unknown),again=await analyzeScenario(portable.scenarios[0]!,portable.assetSnapshots);assert.equal(again.status,'available');if(again.status!=='available')throw Error();assert.equal(again.result.inputHash,r.inputHash);assert.equal(r.inputHash,await computeInputHash(project.scenarios[0]!,project.assetSnapshots));
  const items:ComparedMeasurement[]=[];await runMeasurementComparisons({scenario:portable.scenarios[0],assets:portable.assetSnapshots,result:again.result,records:portable.measurements},m=>{if(m.kind==='item')items.push({id:m.id,attempt:m.attempt});});assert.deepEqual(items.map(i=>i.attempt.status),['available','available','available','available','unavailable','unavailable']);
  for(const [index,item] of items.slice(0,4).entries()){if(item.attempt.status!=='available')throw Error();const c=item.attempt.comparison,seconds=index===0?2:5;close(n(c.mfu[0]?.value),logical/seconds/peak);close(n(c.executedUtilization?.compute[0]?.value),executed/seconds/peak);assert.equal(c.executedUtilization?.version,'executed-utilization.1');assert.equal(c.inputHash,current.inputHash);if(index>0)close(n(c.mbu),448/seconds/(name==='replicated'?400:100));
    if(name==='mixed'){close(n(c.mfu[1]?.value),2/seconds/10);close(n(c.executedUtilization?.compute[1]?.value),3/seconds/10);close(n(c.mfu[2]?.value),7/seconds/7);close(n(c.executedUtilization?.compute[2]?.value),9/seconds/7);assert.equal(c.executedUtilization?.compute[2]?.computeClass.arithmetic,'integer');}
  }
  const report=await createMeasurementReport({scenario:portable.scenarios[0]!,assets:portable.assetSnapshots,result:again.result,records:portable.measurements,items,offset:0,totalRecords:records.length,completion:'complete'});await save(name+'-report',report);await writeFile(dir+'/'+name+'-comparison.csv',measurementReportCsv(report));
  // The same original record dispatched directly must match the exported actual-call comparison.
  const direct=await compareMeasurement(records[0]!,scenario,current,project.assetSnapshots);assert.deepEqual(direct,items[0]?.attempt);
  ledgers.push({name,logicalOperations:logical,executedOperations:executed,actualDevicePeakOperationsPerSecond:peak,seconds:2,modelUsefulMfu:logical/2/peak,executedWorkUtilization:executed/2/peak,rootInputHash:r.inputHash,actualInputHash:current.inputHash,records:records.length,available:4,unavailable:2,...(name==='mixed'?{vector:{logical:2,executed:3,peak:10},integer:{logical:7,executed:9,peak:7}}:{})});
}
await save('hand-ledger',{version:'executed-utilization-reference.1',scope:'Declared execution work / normalized measurement time / sum of unique physical peak capabilities; not hardware counters. Model analysis engine/input hashing and original useful-MFU/MBU conventions retained.',ledgers});
console.log('Executed utilization:5 portable projects, separately scoped logical/physical ratios,4 time statistics, mixed arithmetic classes, exact Decode call, fusion extra work, stale/unbound rows and complete JSON/CSV reports independently verified.');
