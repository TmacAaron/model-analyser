import {Provenance,type AnalysisAttempt} from '@model-analyser/contracts';

export type AnalysisSegments={root:ArrayBuffer;provenance:ArrayBuffer[];sections:ArrayBuffer[][]};
const rowsKey='$analysisRows';
const rowsPerPart=128;
const yieldAfterMs=8;
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const metric=(value:unknown)=>record(value)&&value.status==='available'&&record(value.quantity);

export function requireExactJson(value:unknown){
  if(value===undefined||typeof value==='number'&&(!Number.isFinite(value)||Object.is(value,-0)))throw Error('The result requires structured cloning');
}

/** Detach long result arrays so neither endpoint needs to hold one report-sized JSON string. */
export function encodeAnalysisSegments(attempt:AnalysisAttempt):AnalysisSegments{
  const encoder=new TextEncoder(),queue:unknown[][]=[],sources:unknown[]=[];
  const sourceIds=new WeakMap<object,number>(),sourceSignatures=new Map<string,number>();
  function encode(value:unknown):ArrayBuffer{
    return encoder.encode(JSON.stringify(value,function(this:unknown,key,field:unknown){
      requireExactJson(field);
      if(key==='provenance'&&metric(this)){
        if(!record(field))throw Error('Invalid analysis evidence');
        const known=sourceIds.get(field);
        if(known!==undefined)return known;
        const signature=JSON.stringify(field),existing=sourceSignatures.get(signature),id=existing??sources.length;
        if(existing===undefined){sourceSignatures.set(signature,id);sources.push(field);}
        sourceIds.set(field,id);
        return id;
      }
      if(record(field)&&Object.hasOwn(field,rowsKey))throw Error('Reserved analysis section marker');
      if(key&&Array.isArray(field)&&field.length>rowsPerPart){
        const id=queue.push(field)-1;
        return {[rowsKey]:id};
      }
      return field;
    })).buffer;
  }
  function chunks(rows:unknown[],encodePart:(value:unknown[])=>ArrayBuffer){
    const parts:ArrayBuffer[]=[];
    for(let index=0;index<rows.length;index+=rowsPerPart)parts.push(encodePart(rows.slice(index,index+rowsPerPart)));
    return parts;
  }
  const root=encode(attempt),sections:ArrayBuffer[][]=[];
  // Encoding a section can enqueue arrays nested inside its rows, in reference order.
  for(const rows of queue)sections.push(chunks(rows,encode));
  const provenance=chunks(sources,rows=>encoder.encode(JSON.stringify(rows)).buffer);
  return {root,sections,provenance};
}

/** Restore in wire order and release the main thread between batches of parsing work. */
export async function decodeAnalysisSegments(input:unknown,isCurrent:()=>boolean):Promise<unknown>{
  if(!record(input)||!Array.isArray(input.sections)||!Array.isArray(input.provenance))throw Error('Invalid analysis sections');
  const decoder=new TextDecoder('utf-8',{fatal:true}),pool:Provenance[]=[],rows:unknown[][]=input.sections.map(()=>[]);
  let nextSection=0,deadline=performance.now()+yieldAfterMs;
  async function parse(buffer:unknown):Promise<unknown>{
    if(!isCurrent())throw Error('Analysis no longer current');
    if(!(buffer instanceof ArrayBuffer)||!buffer.byteLength)throw Error('Invalid analysis section buffer');
    if(performance.now()>=deadline){
      await new Promise<void>(resolve=>setTimeout(resolve,0));
      if(!isCurrent())throw Error('Analysis no longer current');
      deadline=performance.now()+yieldAfterMs;
    }
    return JSON.parse(decoder.decode(buffer));
  }
  function partRows(part:unknown):unknown[]{
    if(!Array.isArray(part)||!part.length||part.length>rowsPerPart)throw Error('Invalid analysis section rows');
    return part;
  }
  for(const buffer of input.provenance){
    for(const source of partRows(await parse(buffer)))pool.push(Provenance.parse(source));
  }
  function restore(value:unknown):unknown{
    if(Array.isArray(value)){
      for(let index=0;index<value.length;index++)value[index]=restore(value[index]);
      return value;
    }
    if(!record(value))return value;
    if(Object.hasOwn(value,rowsKey)){
      const section=rows[nextSection];
      if(!section||value[rowsKey]!==nextSection||Object.keys(value).length!==1)throw Error('Invalid analysis section reference');
      nextSection++;
      return section;
    }
    for(const [key,field] of Object.entries(value)){
      if(key==='provenance'&&metric(value)){
        if(typeof field!=='number'||!Number.isSafeInteger(field)||field<0||!pool[field])throw Error('Invalid provenance reference');
        value[key]=pool[field];
      }else value[key]=restore(field);
    }
    return value;
  }
  const root=restore(await parse(input.root));
  for(const [index,section] of input.sections.entries()){
    const target=rows[index];
    if(!target||index>=nextSection||!Array.isArray(section)||!section.length)throw Error('Invalid or unreferenced analysis section');
    for(const buffer of section){
      for(const item of partRows(await parse(buffer)))target.push(restore(item));
    }
  }
  if(nextSection!==rows.length)throw Error('Incomplete analysis sections');
  return root;
}
