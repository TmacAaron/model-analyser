import { resolveParallelPlan } from '@model-analyser/core';
import type { Scenario,AssetDocument,ParallelResolutionAttempt } from '@model-analyser/contracts';
export type ParallelWorkerRequest={scenario:Scenario;assets:AssetDocument[]};
const endpoint=globalThis as unknown as {onmessage:((event:MessageEvent<ParallelWorkerRequest>)=>void)|null;postMessage:(attempt:ParallelResolutionAttempt)=>void};
endpoint.onmessage=event=>{void resolveParallelPlan(event.data.scenario,event.data.assets).then(attempt=>endpoint.postMessage(attempt));};
