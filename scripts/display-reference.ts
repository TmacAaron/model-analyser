import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { ProjectDocument } from '@model-analyser/contracts';
import { analyzeScenario,computeInputHash } from '@model-analyser/core';
import { makeStreamProject } from './stream-project.js';
import { displayBytes,displaySeconds,displayMetric,displayQuantity,type DisplayUnits } from '../apps/web/src/display-format.js';

const binary:DisplayUnits={memory:'binary',time:'auto'},decimal:DisplayUnits={memory:'decimal',time:'ms'},raw:DisplayUnits={memory:'byte',time:'s'};
const cases=[
  {name:'binary capacity',actual:displayBytes(4096,binary),expected:'4 KiB'},
  {name:'decimal capacity',actual:displayBytes(4096,decimal),expected:'4.096 KB'},
  {name:'raw capacity',actual:displayBytes(4096,raw),expected:'4,096 B'},
  {name:'automatic stream duration',actual:displaySeconds(0.0065,binary),expected:'6.5 ms'},
  {name:'fixed microsecond duration',actual:displaySeconds(0.0065,{...binary,time:'us'}),expected:'6,500 µs'},
  {name:'signed comparison difference',actual:displaySeconds(-0.002,decimal),expected:'-2 ms'},
  {name:'known zero',actual:displayMetric({status:'available',quantity:{value:0,unit:'byte'},basis:'theoretical',provenance:{assetRefs:[],formulaRefs:[],parameterSources:[],assumptions:[]},diagnosticIds:[]},decimal),expected:'0 B'},
  {name:'unknown does not become zero',actual:displayMetric({status:'unavailable',diagnosticIds:['missing']},decimal),expected:'不可用'},
  {name:'bandwidth remains per second',actual:displayQuantity(1000,'byte_per_second',{...decimal,time:'us'}),expected:'1,000 B/s'},
];
for(const c of cases)assert.equal(c.actual,c.expected,c.name);
const p=makeStreamProject(ProjectDocument.parse(JSON.parse(await readFile('examples/contracts/project.json','utf8')) as unknown)),scenario=p.scenarios[0]!,originalProject=JSON.stringify(p),before=await computeInputHash(scenario,p.assetSnapshots),a=await analyzeScenario(scenario,p.assetSnapshots);assert.equal(a.status,'available');if(a.status!=='available')throw Error();const originalResult=JSON.stringify(a.result),seconds=a.result.total.seconds,peak=a.result.memory[0]!.peakBytes;assert.equal(seconds.status,'available');assert.equal(peak.status,'available');if(seconds.status!=='available'||peak.status!=='available')throw Error();assert.ok(Math.abs(seconds.quantity.value-0.0065)<1e-15);assert.equal(peak.quantity.value,5*2**30);
const formatted=[binary,decimal,raw].map(units=>({units,seconds:displayMetric(seconds,units),peak:displayMetric(peak,units)}));assert.deepEqual(formatted.map(f=>f.peak),['5 GiB','5.3687 GB','5,368,709,120 B']);assert.equal(JSON.stringify(p),originalProject);assert.equal(JSON.stringify(a.result),originalResult);assert.equal(await computeInputHash(scenario,p.assetSnapshots),before);assert.equal(a.result.inputHash,before);
await mkdir('examples/display-units',{recursive:true});await writeFile('examples/display-units/reference.json',JSON.stringify({scope:'Display-only authored C05 reference; canonical quantities remain byte/second, no hardware measurement claim',cases,stream:{rawSeconds:seconds.quantity,rawPeak:peak.quantity,inputHash:before,engineVersion:a.result.engineVersion,formatted,projectUnchanged:true,resultUnchanged:true}},null,2)+'\n');console.log('Display units: nine scalar references and C05 0.0065 second / 5368709120 byte; binary/decimal/raw views preserve project, result and inputHash.');
