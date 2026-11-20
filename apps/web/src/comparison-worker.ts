import { compareScenarios } from '@model-analyser/core';
import type { Scenario,AssetDocument,ScenarioComparisonRequest,ScenarioComparisonAttempt } from '@model-analyser/contracts';
export type ComparisonWorkerRequest={kind:'start';scenarios:Scenario[];assets:AssetDocument[];request:ScenarioComparisonRequest}|{kind:'cancel'};
export type ComparisonWorkerResponse={kind:'progress';completed:number;total:number}|{kind:'result';attempt:ScenarioComparisonAttempt};
const endpoint=globalThis as unknown as {onmessage:((event:MessageEvent<ComparisonWorkerRequest>)=>void)|null;postMessage:(message:ComparisonWorkerResponse)=>void};
let cancelled=false;
endpoint.onmessage=event=>{if(event.data.kind==='cancel'){cancelled=true;return;}cancelled=false;const {scenarios,assets,request}=event.data;void compareScenarios(scenarios,assets,request,{isCancelled:()=>cancelled,onProgress:(completed,total)=>endpoint.postMessage({kind:'progress',completed,total}),yieldControl:()=>new Promise(resolve=>setTimeout(resolve,0))}).then(attempt=>endpoint.postMessage({kind:'result',attempt}));};
