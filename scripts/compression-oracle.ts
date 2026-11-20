/** Scalar resource ledger authored independently of graph assets and engine APIs. */
export function compressionOracle(ratio:1|2|4=2,phase:'prefill'|'decode'='decode',policy:'serial'|'ideal'='serial',allocation:'dynamic'|'provisioned'='dynamic',storage:'packed'|'bf16'='packed',B=1,C=phase==='decode'?255:0,Q=phase==='decode'?1:5,H=4,M=512,W=2){
  if(phase==='prefill'&&C!==0||phase==='decode'&&Q!==1||allocation==='provisioned'&&C+Q>M)throw Error('Outside the declared component contract');
  const D=16,R=ratio,N=Math.floor((C+Q)/R),before=Math.floor(C/R),G=phase==='prefill'?Math.floor(Q/R):N-before,remainder=(C+Q)%R,saved=phase==='prefill'?remainder:Q,retained=phase==='prefill'?Math.min(Q,W):Q,cacheRows=allocation==='dynamic'?N:Math.floor(M/R),mr=storage==='packed'?9:32,wr=storage==='packed'?17:32;
  const weights=(R===1?4:10)*H*D+4*D,state=B*(cacheRows*mr+W*wr+(R>1?8*R*D:0));
  type Event={id:string;reads:string[];writes:string[];deps:string[];hbm:number;matrix16:number;matrix32:number;vectorUseful:number;vector:number;seconds:number;start:number;end:number};
  const events:Event[]=[],sizes=new Map<string,number>([['x',2*B*Q*H],['x32',4*B*Q*H],['value',(R===1?2:4)*B*Q*D],['gate',4*B*Q*D],['prob',4*B*G*R*D],['weighted',4*B*G*R*D],['pooled',4*B*G*D],['pooled16',2*B*G*D],['latent',2*B*G*D],['rotated',2*B*G*D],['window-projected',2*B*Q*D],['window-ready',2*B*Q*D]]);
  const add=(id:string,reads:string[],writes:string[],deps:string[],hbm:number,matrix16=0,matrix32=0,vectorUseful=0,vector=vectorUseful)=>{events.push({id,reads,writes,deps,hbm,matrix16,matrix32,vectorUseful,vector,seconds:Math.max((matrix16+matrix32+vector)/1000,hbm/100),start:0,end:0});};
  if(R>1){
    add('c/cast',['x'],['x32'],[],6*B*Q*H,0,0,0,B*Q*H);add('c/project',['x32'],['value'],['c/cast'],4*B*Q*H+4*H*D+4*B*Q*D,0,2*B*Q*H*D);add('c/gate',['x32'],['gate'],['c/cast'],4*B*Q*H+4*H*D+4*B*Q*D,0,2*B*Q*H*D);
    add('c/save',['value','gate'],[],['c/project','c/gate'],16*B*saved*D);
    add('c/softmax',phase==='prefill'?['gate']:[],['prob'],['c/save'],8*B*G*R*D,0,0,5*B*G*R*D);
    add('c/product',phase==='prefill'?['value','prob']:['prob'],['weighted'],['c/softmax'],12*B*G*R*D,0,0,B*G*R*D);
    add('c/reduce',['weighted'],['pooled'],['c/product'],4*B*G*D*(R+1),0,0,B*G*D*(R-1));add('c/cast-latent',['pooled'],['pooled16'],['c/reduce'],6*B*G*D,0,0,0,B*G*D);
    add('c/norm',['pooled16'],['latent'],['c/cast-latent'],4*B*G*D+(G?2*D:0),0,0,5*B*G*D);
  }else{
    add('c/project',['x'],['value'],[],2*B*Q*H+2*H*D+2*B*Q*D,2*B*Q*H*D);add('c/norm',['value'],['latent'],['c/project'],4*B*G*D+2*D,0,0,5*B*G*D);
  }
  add('c/rotary',['latent'],['rotated'],['c/norm'],4*B*G*D,0,0,6*B*G*D/4);add('c/store',['rotated'],[],['c/rotary'],B*G*(2*D+mr),0,0,0,2*B*G*D);
  add('w/project',['x'],['window-projected'],[],2*B*Q*H+2*H*D+2*B*Q*D,2*B*Q*H*D);add('w/norm',['window-projected'],['window-ready'],['w/project'],4*B*Q*D+2*D,0,0,5*B*Q*D+6*B*Q*D/4);add('w/store',['window-ready'],['window-ready'],['w/norm'],4*B*Q*D+B*retained*wr,0,0,0,2*B*Q*D);
  // Standard independent topological traversal of this hand-written ledger, not the generated graph.
  const next=new Map<string,string[]>(),remaining=new Map(events.map(e=>[e.id,e.deps.length])),queue=events.filter(e=>!e.deps.length).map(e=>e.id),ordered:Event[]=[];
  for(const e of events)for(const dep of e.deps)next.set(dep,[...(next.get(dep)??[]),e.id]);const get=(id:string)=>{const e=events.find(e=>e.id===id);if(!e)throw Error(id);return e;};
  for(let i=0;i<queue.length;i++){const id=queue[i];if(!id)throw Error();ordered.push(get(id));for(const to of next.get(id)??[]){const n=(remaining.get(to)??0)-1;remaining.set(to,n);if(n===0)queue.push(to);}}
  if(ordered.length!==events.length)throw Error('Invalid hand ledger');let clock=0;const streamClock={c:0,w:0};
  for(const e of ordered){const stream=e.id.startsWith('c/')?'c':'w';e.start=policy==='serial'?clock:streamClock[stream];e.end=e.start+e.seconds;if(policy==='serial')clock=e.end;else streamClock[stream]=e.end;}const seconds=policy==='serial'?clock:Math.max(streamClock.c,streamClock.w);
  const born=new Map<string,number>([['x',0]]),last=new Map<string,number>();for(const e of ordered){for(const id of e.writes)born.set(id,Math.min(born.get(id)??Infinity,e.start));for(const id of e.reads)last.set(id,Math.max(last.get(id)??0,e.end));}last.set('latent',seconds);last.set('window-ready',seconds);
  let activation=0,peakAt=0;for(const time of [...new Set(events.map(e=>e.start))]){let live=0;for(const [id,size] of sizes){const a=born.get(id),b=last.get(id)??events.filter(e=>e.writes.includes(id)).reduce((n,e)=>Math.max(n,e.end),0);if(a!==undefined&&a<=time+1e-12&&time<b-1e-12)live+=size;}if(live>activation){activation=live;peakAt=time;}}
  return {ratio,phase,policy,allocation,storage,B,C,Q,H,M,W,completeBefore:before,completeAfter:N,newGroups:G,groupsIncludingPartial:Math.ceil((C+Q)/R),pendingBefore:C%R,pendingAfter:remainder,cacheRows,weights,state,activation,peak:weights+state+activation,peakAt,seconds,compressionSeconds:events.filter(e=>e.id.startsWith('c/')).reduce((n,e)=>n+e.seconds,0),windowSeconds:events.filter(e=>e.id.startsWith('w/')).reduce((n,e)=>n+e.seconds,0),hbm:events.reduce((n,e)=>n+e.hbm,0),matrix16:events.reduce((n,e)=>n+e.matrix16,0),matrix32:events.reduce((n,e)=>n+e.matrix32,0),vectorUseful:events.reduce((n,e)=>n+e.vectorUseful,0),vector:events.reduce((n,e)=>n+e.vector,0),allMemoryBound:events.every(e=>e.hbm/100>=(e.matrix16+e.matrix32+e.vector)/1000)};
}
