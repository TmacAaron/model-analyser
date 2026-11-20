import { MeasurementImportPreviewRequest } from '@model-analyser/contracts';
import { previewMeasurementImport } from '@model-analyser/core';
self.onmessage=(event:MessageEvent<unknown>)=>{void (async()=>{try{self.postMessage({ok:true,data:await previewMeasurementImport(MeasurementImportPreviewRequest.parse(event.data))});}catch(e){self.postMessage({ok:false,error:{code:'validation',message:e instanceof Error?e.message:'测量预览失败',fieldIssues:[]}});}})();};
