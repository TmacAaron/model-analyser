import { instantiateModel } from '@model-analyser/core';
import type { Scenario,AssetDocument,InstantiationResult } from '@model-analyser/contracts';
export type ModelInstantiationRequest={scenario:Scenario;assets:AssetDocument[]};
const endpoint=globalThis as unknown as {onmessage:((event:MessageEvent<ModelInstantiationRequest>)=>void)|null;postMessage:(result:InstantiationResult)=>void};
endpoint.onmessage=event=>endpoint.postMessage(instantiateModel(event.data.scenario,event.data.assets));
