import { replayCapacitySource,type CapacitySourceRequest,type CapacitySourceResponse } from './capacity-source-task.js';
const endpoint=globalThis as unknown as {onmessage:((event:MessageEvent<CapacitySourceRequest>)=>void)|null;postMessage:(response:CapacitySourceResponse)=>void};
endpoint.onmessage=event=>{void replayCapacitySource(event.data).then(response=>endpoint.postMessage(response));};
