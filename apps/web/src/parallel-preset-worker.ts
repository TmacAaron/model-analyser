import { ParallelPresetRequest } from '@model-analyser/contracts';
import { previewParallelPreset } from '@model-analyser/core';
self.onmessage=(event:MessageEvent<unknown>)=>{void (async()=>{try{self.postMessage(await previewParallelPreset(ParallelPresetRequest.parse(event.data)));}catch(e){self.postMessage({status:'unavailable',message:e instanceof Error?e.message:'无法生成并行预设'});}})();};
