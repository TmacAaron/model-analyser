import {PROJECT_JSON_DEPTH} from './project-limits.js';
/** Match compact/two-space JSON UTF-8 size without creating its string or a frame per child. */
export function jsonBytes(value:unknown,limit:number,pretty=false,maxDepth=PROJECT_JSON_DEPTH){
 let bytes=0;const add=(n:number)=>{bytes+=n;if(bytes>limit)throw Error('序列化数据超过允许的字节限额');};
 function string(s:string){add(2);for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c>=32&&c<128)add(c===34||c===92?2:1);else if(c<32)add(c===8||c===9||c===10||c===12||c===13?2:6);else if(c<2048)add(2);else if(c>=0xd800&&c<=0xdbff){const low=s.charCodeAt(i+1);if(low>=0xdc00&&low<=0xdfff){add(4);i++;}else add(6);}else if(c>=0xdc00&&c<=0xdfff)add(6);else add(3);}}
 function* keys(object:Record<string,unknown>){for(const key in object)if(Object.hasOwn(object,key)&&object[key]!==undefined)yield key;}
 type Frame={kind:'value';value:unknown;depth:number}|{kind:'array';value:unknown[];index:number;depth:number}|{kind:'object';value:Record<string,unknown>;keys:IterableIterator<string>;index:number;depth:number};
 const active=new WeakSet<object>(),stack:Frame[]=[{kind:'value',value,depth:0}];
 function prefix(index:number,depth:number){if(index)add(1);if(pretty)add(1+2*(depth+1));}
 function close(v:object,index:number,depth:number){if(pretty&&index)add(1+2*depth);add(1);active.delete(v);}
 while(stack.length){const frame=stack.pop();if(!frame)throw Error('invalid_counter_stack');
  if(frame.kind==='array'){if(frame.index===frame.value.length){close(frame.value,frame.index,frame.depth);continue;}prefix(frame.index,frame.depth);const child=frame.value[frame.index++];stack.push(frame,{kind:'value',value:child,depth:frame.depth+1});continue;}
  if(frame.kind==='object'){const next=frame.keys.next();if(next.done){close(frame.value,frame.index,frame.depth);continue;}prefix(frame.index++,frame.depth);string(next.value);add(pretty?2:1);stack.push(frame,{kind:'value',value:frame.value[next.value],depth:frame.depth+1});continue;}
  if(frame.depth>maxDepth)throw Error('JSON嵌套超过允许深度');const v=frame.value;
  if(v===null||v===undefined){add(4);continue;}if(typeof v==='string'){string(v);continue;}if(typeof v==='number'){add(Number.isFinite(v)?JSON.stringify(v).length:4);continue;}if(typeof v==='boolean'){add(v?4:5);continue;}if(typeof v!=='object')throw Error('non_json_value');
  if(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)throw Error('non_json_object');if(active.has(v))throw Error('cyclic_value');active.add(v);add(1);
  if(Array.isArray(v))stack.push({kind:'array',value:v,index:0,depth:frame.depth});else stack.push({kind:'object',value:v as Record<string,unknown>,keys:keys(v as Record<string,unknown>),index:0,depth:frame.depth});
 }
 return bytes;
}
