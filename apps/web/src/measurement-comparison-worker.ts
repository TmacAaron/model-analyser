import { runMeasurementComparisons,type MeasurementComparisonMessage } from './measurement-comparison-task.js';
const endpoint=globalThis as unknown as {onmessage:((event:MessageEvent<unknown>)=>void)|null;postMessage:(message:MeasurementComparisonMessage)=>void};
endpoint.onmessage=event=>{void runMeasurementComparisons(event.data,message=>endpoint.postMessage(message)).catch(error=>endpoint.postMessage({kind:'error',message:error instanceof Error?error.message:'测量比较失败'}));};
