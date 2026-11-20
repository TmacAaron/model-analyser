import { searchCapacity } from '@model-analyser/core';
import type { AssetDocument,Scenario,CapacitySearchRequest,CapacitySearchAttempt } from '@model-analyser/contracts';

export type CapacityWorkerRequest={kind:'start';scenario:Scenario;assets:AssetDocument[];request:CapacitySearchRequest}|{kind:'cancel'};
export type CapacityWorkerResponse={kind:'progress';completed:number;total:number}|{kind:'result';attempt:CapacitySearchAttempt};
const endpoint=globalThis as unknown as {onmessage:((event:MessageEvent<CapacityWorkerRequest>)=>void)|null;postMessage:(message:CapacityWorkerResponse)=>void};
let cancelled=false;
endpoint.onmessage=event=>{
  if(event.data.kind==='cancel'){cancelled=true;return;}
  cancelled=false;const {scenario,assets,request}=event.data;
  void searchCapacity(scenario,assets,request,{
    isCancelled:()=>cancelled,
    onProgress:(completed,total)=>endpoint.postMessage({kind:'progress',completed,total}),
    // Yield between bounded graph analyses so queued cancellation is observed.
    yieldControl:()=>new Promise(resolve=>setTimeout(resolve,0)),
  }).then(attempt=>endpoint.postMessage({kind:'result',attempt}));
};
