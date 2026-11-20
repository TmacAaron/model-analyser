import { ConfigurationEditRequest,ConfigurationEditAttempt } from '@model-analyser/contracts';
import { applyConfigurationEdit } from '../../../packages/core/src/configuration-edit.js';
self.onmessage=async(event:MessageEvent<unknown>)=>{try{const input=ConfigurationEditRequest.parse(event.data),project=await applyConfigurationEdit(input.project,input.scenarioId);self.postMessage(ConfigurationEditAttempt.parse({status:'available',project}));}catch(e){self.postMessage(ConfigurationEditAttempt.parse({status:'unavailable',message:e instanceof Error?e.message:'配置验证失败'}));}};
