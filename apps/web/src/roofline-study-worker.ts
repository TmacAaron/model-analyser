import { studyRoofline } from '@model-analyser/core';
import type { AssetDocument,Scenario,RooflineStudyRequest,RooflineStudyAttempt } from '@model-analyser/contracts';
export type RooflineWorkerRequest={kind:'start';scenario:Scenario;assets:AssetDocument[];request:RooflineStudyRequest}|{kind:'cancel'};
export type RooflineWorkerResponse={kind:'progress';completed:number;total:number}|{kind:'result';attempt:RooflineStudyAttempt};
const endpoint=globalThis as unknown as {onmessage:((e:MessageEvent<RooflineWorkerRequest>)=>void)|null;postMessage:(message:RooflineWorkerResponse)=>void};let cancelled=false;
endpoint.onmessage=e=>{if(e.data.kind==='cancel'){cancelled=true;return;}cancelled=false;const {scenario,assets,request}=e.data;void studyRoofline(scenario,assets,request,{isCancelled:()=>cancelled,onProgress:(completed,total)=>endpoint.postMessage({kind:'progress',completed,total}),yieldControl:()=>new Promise(resolve=>setTimeout(resolve,0))}).then(attempt=>endpoint.postMessage({kind:'result',attempt}));};
