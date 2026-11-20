import { replayDeclarationSource,type DeclarationReplayRequest,type DeclarationSourceResponse } from './declaration-source-task.js';
const endpoint=globalThis as unknown as {onmessage:((event:MessageEvent<DeclarationReplayRequest>)=>void)|null;postMessage:(response:DeclarationSourceResponse)=>void};
endpoint.onmessage=event=>{void replayDeclarationSource(event.data).then(proof=>endpoint.postMessage({status:'available',proof}),e=>endpoint.postMessage({status:'error',message:e instanceof Error?e.message:'声明来源复核失败'}));};
