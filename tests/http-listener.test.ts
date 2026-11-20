import {it,expect} from 'vitest';import {createServer} from 'node:http';import {listenForFetch} from './integration/http-listener.js';
it('closes and rebinds a fetch-blocked ephemeral port before allowing business traffic',async()=>{
 const server=createServer((_request,response)=>{response.statusCode=404;response.end('probe');}),ports:number[]=[];
 try{await listenForFetch(server,async(input,init)=>{const address=server.address();if(!address||typeof address==='string')throw Error();ports.push(address.port);if(ports.length===1)throw new TypeError('fetch failed',{cause:new Error('bad port')});return fetch(input,init);});expect(ports.length).toBeGreaterThanOrEqual(2);expect(server.listening).toBe(true);const address=server.address();if(!address||typeof address==='string')throw Error();expect((await fetch('http://127.0.0.1:'+address.port+'/business')).status).toBe(404);}finally{if(server.listening)await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
it('does not retry or mask other transport errors and closes the attempted listener',async()=>{
 const server=createServer((_request,response)=>response.end('probe'));let attempts=0;await expect(listenForFetch(server,async()=>{attempts++;throw Error('real connection failure');})).rejects.toThrow('real connection failure');expect(attempts).toBe(1);expect(server.listening).toBe(false);
});
