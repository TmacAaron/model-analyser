import type {Server} from 'node:http';
/** OS-selected ephemeral ports can be blocked by the runtime's fetch policy. */
export async function listenForFetch(server:Server,probe:typeof fetch=fetch){
 for(let attempt=0;attempt<16;attempt++){
  await new Promise<void>((resolve,reject)=>{const fail=(error:Error)=>{server.off('error',fail);reject(error);};server.once('error',fail);server.listen(0,'127.0.0.1',()=>{server.off('error',fail);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw Error('Missing test listener address');
  try{const response=await probe('http://127.0.0.1:'+address.port+'/api/v1/__test_port_probe',{signal:AbortSignal.timeout(5000)});await response.arrayBuffer();return;}
  catch(error){await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));const cause=error instanceof Error?error.cause:undefined;if(!(cause instanceof Error)||cause.message!=='bad port')throw error;}
 }
 throw Error('Runtime rejected16 OS-selected test listener ports');
}
