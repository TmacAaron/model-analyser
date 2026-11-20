/** Independent scalar ledger: no graph/formula/core imports. Decimal bytes and operations.
 * This implements the explicitly authored materialization, NOT a real SDPA allocator. */
export type GlmDimensions={B:number;Q:number;C:number;H:number;I:number;D:number;NH:number;NK:number;V:number;M:number;L:number;LAST:number};
export const glmDefaults:GlmDimensions={B:1,Q:1,C:2,H:4096,I:13696,D:128,NH:32,NK:2,V:151552,M:8192,L:40,LAST:0};
export const glmSmall:GlmDimensions={B:2,Q:3,C:1,H:4,I:6,D:4,NH:2,NK:1,V:10,M:8,L:2,LAST:0};
export function glmOracle(p:GlmDimensions){
  const {B,Q,C,H,I,D,NH,NK,V,M,L,LAST}=p,S=C+Q,P=LAST===1?1:Q,pairs=C*Q+Q*(Q+1)/2;
  if(Object.entries(p).some(([k,v])=>!Number.isSafeInteger(v)||v<(k==='C'||k==='LAST'?0:1))||S>M||D%4||NH%NK||LAST>1)throw Error('Unsupported oracle dimensions');
  const parameters=L*(H*D*(NH+2*NK)+D*(NH+2*NK)+NH*D*H+3*H*I+2*H)+2*V*H+H,weightBytes=2*parameters,stateBytes=4*B*L*S*NK*D,reserveBytes=D/2;
  type N={id:string;reads:Record<string,number>;writes:Record<string,number>;scratch:number;matrixUseful:number;matrixExecuted:number;vectorUseful:number;vectorExecuted:number};
  const nodes:N[]=[],sizes=new Map<string,number>(),add=(id:string,reads:Record<string,number>,writes:Record<string,number>,matrixUseful=0,matrixExecuted=matrixUseful,vectorUseful=0,vectorExecuted=vectorUseful,scratch=0)=>{nodes.push({id,reads,writes,scratch,matrixUseful,matrixExecuted,vectorUseful,vectorExecuted});for(const [k,v]of Object.entries(writes))if(!k.startsWith('state:'))sizes.set(k,v);};
  const h=2*B*Q*H,q=2*B*Q*NH*D,k=2*B*Q*NK*D,kv=2*B*S*NK*D,expanded=2*B*S*NH*D,score=2*B*NH*Q*S,mask=B*Q*S;
  sizes.set('tokens',8*B*Q);
  add('embedding',{'tokens':8*B*Q,'weight:embedding':h},{hidden:h});
  add('rope-build',{}, {'rope-fp32':2*M*D},0,0,3*M*D/4+3*D/4,3*M*D/4+3*D/4,D+4*M+M*D);
  add('rope-cast',{'rope-fp32':2*M*D},{rope:M*D},0,0,0,M*D/2);
  add('mask-build',{}, {mask},0,0,0,mask);
  let input='hidden';for(let l=0;l<L;l++){
    const prefix=`decoder[${l}]/`,key=(s:string)=>prefix+s,weights=(s:string)=>'weight:'+key(s),state=(s:string)=>'state:'+key(s),put=(id:string,ins:Record<string,number>,outs:Record<string,number>,mu=0,me=mu,vu=0,ve=vu)=>add(key(id),ins,outs,mu,me,vu,ve);
    put('input-norm',{[input]:h,[weights('input-norm')]:2*H},{[key('normed')]:h},0,0,5*B*Q*H);
    put('qkv',{[key('normed')]:h,[weights('qkv')]:2*H*D*(NH+2*NK),[weights('qkv-bias')]:2*D*(NH+2*NK)},{[key('q')]:q,[key('k')]:k,[key('v')]:k},2*B*Q*H*D*(NH+2*NK),undefined,B*Q*D*(NH+2*NK));
    put('rope',{[key('q')]:q,[key('k')]:k,rope:B*Q*D},{[key('q-rot')]:q,[key('k-new')]:k},0,0,3*B*Q*(NH+NK)*D/2);
    put('cache-update',{[key('k-new')]:k,[key('v')]:k},{[state('k')]:k,[state('v')]:k});
    put('expand-kv',{[state('k')]:kv,[state('v')]:kv},{[key('expanded-k')]:expanded,[key('expanded-v')]:expanded});
    const useful=2*B*NH*pairs*D,executed=2*B*NH*Q*S*D;
    put('qk',{[key('q-rot')]:q,[key('expanded-k')]:expanded},{[key('scores')]:score},useful,executed);
    put('score-scale-cast',{[key('scores')]:score},{[key('scaled')]:score*2},0,0,B*NH*pairs,2*B*NH*Q*S);
    put('mask-softmax',{[key('scaled')]:score*2,mask},{[key('prob-fp32')]:score*2},0,0,6*B*NH*pairs,6*B*NH*Q*S);
    put('probability-cast',{[key('prob-fp32')]:score*2},{[key('prob')]:score},0,0,0,B*NH*Q*S);
    put('av',{[key('prob')]:score,[key('expanded-v')]:expanded},{[key('attended')]:q},useful,executed);
    put('o-proj',{[key('attended')]:q,[weights('o')]:2*H*NH*D},{[key('attention-output')]:h},2*B*Q*NH*D*H);
    put('attention-residual',{[input]:h,[key('attention-output')]:h},{[key('residual')]:h},0,0,B*Q*H);
    put('post-norm',{[key('residual')]:h,[weights('post-norm')]:2*H},{[key('post-norm')]:h},0,0,5*B*Q*H);
    put('gate-up',{[key('post-norm')]:h,[weights('gate-up')]:4*H*I},{[key('gate-up')]:4*B*Q*I},4*B*Q*H*I);
    put('silu',{[key('gate-up')]:4*B*Q*I},{[key('activated')]:2*B*Q*I},0,0,6*B*Q*I);
    put('down',{[key('activated')]:2*B*Q*I,[weights('down')]:2*H*I},{[key('down')]:h},2*B*Q*H*I);
    put('mlp-residual',{[key('residual')]:h,[key('down')]:h},{[key('y')]:h},0,0,B*Q*H);input=key('y');
  }
  add('final-norm',{[input]:h,'weight:final-norm':2*H},{normalized:h},0,0,5*B*Q*H);
  add('lm-head',{normalized:2*B*P*H,'weight:lm-head':2*V*H},{logits:2*B*P*V},2*B*P*H*V);
  // Stable FIFO topological order: independent table/mask work may interleave with the first layer.
  // Derive it directly from scalar buffer producers/consumers, without importing engine scheduling.
  const producer=new Map<string,N>();for(const n of nodes)for(const k of Object.keys(n.writes))producer.set(k,n);
  const pending=new Map(nodes.map(n=>[n,new Set(Object.keys(n.reads).flatMap(k=>producer.has(k)?[producer.get(k)!]:[]))])),ready=nodes.filter(n=>pending.get(n)!.size===0),ordered:N[]=[];
  while(ready.length){const n=ready.shift()!;ordered.push(n);for(const candidate of nodes){const deps=pending.get(candidate)!;if(deps.delete(n)&&deps.size===0)ready.push(candidate);}}
  if(ordered.length!==nodes.length)throw Error('Oracle dependency cycle');
  // Resident storages are counted once; activations live until last read, outputs before release.
  const last=new Map<string,number>();ordered.forEach((n,i)=>Object.keys(n.reads).forEach(k=>last.set(k,i)));last.set('logits',ordered.length);
  const live=new Set(['tokens']);let peakBytes=0,peakNode='',hbmBytes=0,seconds=0;
  for(const [i,n]of ordered.entries()){
    Object.keys(n.writes).filter(k=>!k.startsWith('state:')).forEach(k=>live.add(k));const bytes=weightBytes+stateBytes+reserveBytes+[...live].reduce((a,k)=>a+(sizes.get(k)??0),0)+n.scratch;
    if(bytes>peakBytes){peakBytes=bytes;peakNode=n.id;}
    const hbm=Object.values(n.reads).reduce((a,b)=>a+b,0)+Object.values(n.writes).reduce((a,b)=>a+b,0)+2*n.scratch;hbmBytes+=hbm;seconds+=Math.max(n.matrixExecuted+n.vectorExecuted,hbm)/1e12;
    for(const k of live)if((last.get(k)??-1)<=i)live.delete(k);
  }
  const sum=(field:'matrixUseful'|'matrixExecuted'|'vectorUseful'|'vectorExecuted')=>nodes.reduce((a,n)=>a+n[field],0);
  return {parameters,weightBytes,stateBytes,reserveBytes,hbmBytes,seconds,peakBytes,peakNode,nodeCount:nodes.length,matrixUseful:sum('matrixUseful'),matrixExecuted:sum('matrixExecuted'),vectorUseful:sum('vectorUseful'),vectorExecuted:sum('vectorExecuted'),nodes};
}
