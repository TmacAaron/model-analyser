import { analyzeScenario } from '@model-analyser/core';
import type { Scenario,AssetDocument,AnalysisAttempt } from '@model-analyser/contracts';
export type AnalysisWorkerRequest={scenario:Scenario;assets:AssetDocument[]};
const endpoint=globalThis as unknown as {onmessage:((event:MessageEvent<AnalysisWorkerRequest>)=>void)|null;postMessage:(attempt:AnalysisAttempt)=>void};
endpoint.onmessage=event=>{void analyzeScenario(event.data.scenario,event.data.assets).then(attempt=>endpoint.postMessage(attempt));};
