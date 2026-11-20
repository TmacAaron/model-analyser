import type { AssetDocument,Scenario } from '@model-analyser/contracts';
import { estimateKvCapacity,type KvCapacityAttempt } from '@model-analyser/core';

export type KvCapacityRequest={scenario:Scenario;assets:AssetDocument[]};
const endpoint=globalThis as unknown as {
  onmessage:((event:MessageEvent<KvCapacityRequest>)=>void)|null;
  postMessage:(message:KvCapacityAttempt)=>void;
};

endpoint.onmessage=({data})=>{
  void estimateKvCapacity(data.scenario,data.assets).then(attempt=>endpoint.postMessage(attempt));
};
