/** Independent scalar DAG and byte ledger: no engine, generated asset or expression imports. */
export function dsaOracle(profile:'source-mask'|'sparse-gather'|'dense'='source-mask',policy:'serial'|'ideal'|'shared_bandwidth'='serial',allocation:'dynamic'|'provisioned'='dynamic',B=1,C=31,H=8,A=2,I=2,K=4,M=128){
  const T=4,R=8,D=4,P=2,V=4,J=8,L=C+1,S=Math.min(K,L),F=profile==='sparse-gather'?S:L,index=profile!=='dense',rows=allocation==='dynamic'?L:M;
  if(allocation==='provisioned'&&L>M)throw Error('Context exceeds reserved rows');
  const weights=2*H*T+4*T+2*T*A*(D+P)+2*H*(R+P)+4*R+2*A*R*(D+V)+2*A*V*H+(index?2*T*I*J+2*H*J+8*J+4*H*I:0),state=B*rows*(2*(R+P)+(index?J+4:0));
  type Event={id:string;reads:string[];writes:string[];deps:string[];stream:'main'|'index';hbm:number;m16:number;m8:number;m32:number;vu:number;ve:number;seconds:number;start:number;end:number};
  const events:Event[]=[],sizes=new Map<string,number>(Object.entries({x:2*B*H,qr0:2*B*T,qr:2*B*T,q:2*B*A*(D+P),qn:2*B*A*D,qp:2*B*A*P,raw:2*B*(R+P),kv:2*B*R,kp:2*B*P,absorbed:2*B*A*R,iq0:2*B*I*J,iq:2*B*I*J,iq8:B*I*J,iqs:4*B*I,ik0:2*B*J,ik:2*B*J,x32:4*B*H,iw0:4*B*I,iw:4*B*I,iscore:4*B*L,top:8*B*S,gkv:2*B*S*R,gpe:2*B*S*P,sk:2*B*A*F,sp:2*B*A*F,score:2*B*A*F,mask:4*B*L,prob:2*B*A*F,attended:2*B*A*R,values:2*B*A*V,y:2*B*H}));
  const producer=new Map<string,string>();
  function add(id:string,reads:string[],writes:string[],hbm:number,m16=0,vu=0,extra:{m8?:number;m32?:number;ve?:number;stream?:'index'}={}){
    const deps=[...new Set(reads.map(t=>producer.get(t)).filter((s):s is string=>s!==undefined))],m8=extra.m8??0,m32=extra.m32??0,ve=extra.ve??vu;
    events.push({id,reads,writes,deps,stream:extra.stream??'main',hbm,m16,m8,m32,vu,ve,seconds:Math.max(m16/1000+m8/2000+m32/500+ve/1000,hbm/100),start:0,end:0});for(const t of writes)producer.set(t,id);
  }
  add('qa',['x'],['qr0'],2*B*H+2*H*T+2*B*T,2*B*H*T);add('qn',['qr0'],['qr'],4*B*T+4*T,0,5*B*T);add('qb',['qr'],['q'],2*B*T+2*T*A*(D+P)+2*B*A*(D+P),2*B*T*A*(D+P));add('qr',['q'],['qn','qp'],4*B*A*(D+P),0,3*B*A*P);
  add('ka',['x'],['raw'],2*B*H+2*H*(R+P)+2*B*(R+P),2*B*H*(R+P));add('kn',['raw'],['kv','kp'],4*B*(R+P)+4*R,0,5*B*R+3*B*P);add('cache',['kv','kp'],['kv-cache','pe-cache'],4*B*(R+P),0,0,{ve:2*B*R});add('absorb',['qn'],['absorbed'],2*B*A*D+2*A*D*R+2*B*A*R,2*B*A*D*R);
  if(index){
    add('iq',['qr'],['iq0'],2*B*T+2*T*I*J+2*B*I*J,2*B*T*I*J,0,{stream:'index'});add('iqrot',['iq0'],['iq'],4*B*I*J,0,3*B*I*P+4*B*I*J,{stream:'index'});add('iqquant',['iq'],['iq8','iqs'],3*B*I*J+4*B*I,0,0,{ve:2*B*I*J,stream:'index'});
    add('ik',['x'],['ik0'],2*B*H+2*H*J+2*B*J,2*B*H*J,0,{stream:'index'});add('iknorm',['ik0'],['ik'],4*B*J+8*J,0,7*B*J+3*B*P+4*B*J,{stream:'index'});add('ikquant',['ik'],['index-cache','index-scale'],3*B*J+4*B,0,0,{ve:2*B*J,stream:'index'});
    add('cast',['x'],['x32'],6*B*H,0,0,{ve:B*H,stream:'index'});add('iw',['x32'],['iw0'],4*B*H+4*H*I+4*B*I,0,0,{m32:2*B*H*I,stream:'index'});add('iws',['iw0','iqs'],['iw'],12*B*I,0,3*B*I,{stream:'index'});
    add('scan',['iq8','iw','index-cache','index-scale'],['iscore'],B*I*J+4*B*I+B*L*(J+4)+4*B*L,0,3*B*L*I,{m8:2*B*L*I*J,stream:'index'});add('top',['iscore'],['top'],4*B*L+8*B*S,0,B*L*(S+2),{stream:'index'});
  }
  let cache='kv-cache',pe='pe-cache';if(profile==='sparse-gather'){add('gather',['kv-cache','pe-cache','top'],['gkv','gpe'],4*B*S*(R+P)+8*B*S);cache='gkv';pe='gpe';}
  add('qkk',['absorbed',cache],['sk'],2*B*A*R+2*B*F*R+2*B*A*F,2*B*A*F*R);add('qkp',['qp',pe],['sp'],2*B*A*P+2*B*F*P+2*B*A*F,2*B*A*F*P);add('sum',['sk','sp'],['score'],6*B*A*F,0,2*B*A*F);
  if(profile==='source-mask'){add('mask',['top'],['mask'],8*B*S+4*B*L,0,B*L+B*S,{stream:'index'});add('apply',['score','mask'],['score'],4*B*A*L+4*B*L,0,B*A*L);}
  add('softmax',['score'],['prob'],4*B*A*F,0,5*B*A*F);add('av',['prob',cache],['attended'],2*B*A*F+2*B*F*R+2*B*A*R,2*B*A*F*R);add('expand',['attended'],['values'],2*B*A*R+2*A*V*R+2*B*A*V,2*B*A*R*V);add('out',['values'],['y'],2*B*A*V+2*A*V*H+2*B*H,2*B*A*V*H);
  // FIFO topological traversal, independently constructed from this scalar ledger.
  const get=(id:string)=>{const e=events.find(e=>e.id===id);if(!e)throw Error(id);return e;},next=new Map<string,string[]>(),remaining=new Map(events.map(e=>[e.id,e.deps.length])),queue=events.filter(e=>!e.deps.length).map(e=>e.id),ordered:Event[]=[];
  for(const e of events)for(const d of e.deps)next.set(d,[...(next.get(d)??[]),e.id]);for(let i=0;i<queue.length;i++){const id=queue[i];if(!id)throw Error();ordered.push(get(id));for(const to of next.get(id)??[]){const n=(remaining.get(to)??0)-1;remaining.set(to,n);if(!n)queue.push(to);}}if(ordered.length!==events.length)throw Error('Ledger cycle');
  const prior=new Map<string,string>();for(const e of ordered){const previous=prior.get(policy==='serial'?'serial':e.stream);if(previous&&!e.deps.includes(previous))e.deps.push(previous);prior.set(policy==='serial'?'serial':e.stream,e.id);}
  const allMemoryBound=events.every(e=>e.seconds===e.hbm/100);
  if(policy!=='shared_bandwidth')for(const e of ordered){e.start=Math.max(0,...e.deps.map(id=>get(id).end));e.end=e.start+e.seconds;}
  else{
    if(!allMemoryBound)throw Error('Fluid HBM oracle requires memory-bound leaves');const done=new Set<string>(),active=new Map<string,number>();let clock=0;
    while(done.size<events.length){for(const e of ordered)if(!done.has(e.id)&&!active.has(e.id)&&e.deps.every(id=>done.has(id))){e.start=clock;active.set(e.id,e.hbm);}if(!active.size)throw Error('Ledger stalled');const dt=Math.min(...active.values())*active.size/100;clock+=dt;const service=dt*100/active.size;for(const [id,bytes] of active){const left=bytes-service;if(left<1e-8){get(id).end=clock;done.add(id);active.delete(id);}else active.set(id,left);}}
  }
  const seconds=Math.max(...events.map(e=>e.end)),born=new Map<string,number>([['x',0]]),last=new Map<string,number>();for(const e of ordered){for(const t of e.writes)born.set(t,Math.min(born.get(t)??Infinity,e.start));for(const t of e.reads)last.set(t,Math.max(last.get(t)??0,e.end));}last.set('y',seconds);
  let activation=0;for(const time of events.map(e=>e.start)){let live=0;for(const [id,size] of sizes){const start=born.get(id),end=last.get(id)??events.filter(e=>e.writes.includes(id)).reduce((n,e)=>Math.max(n,e.end),0);if(start!==undefined&&start<=time+1e-10&&time<end-1e-10)live+=size;}activation=Math.max(activation,live);}
  return {profile,policy,allocation,B,C,H,A,I,K,M,activeRows:L,reservedRows:rows,selected:S,attentionPositions:F,weights,state,activation,peak:weights+state+activation,seconds,hbm:events.reduce((n,e)=>n+e.hbm,0),matrix16:events.reduce((n,e)=>n+e.m16,0),matrix8:events.reduce((n,e)=>n+e.m8,0),matrix32:events.reduce((n,e)=>n+e.m32,0),vectorUseful:events.reduce((n,e)=>n+e.vu,0),vector:events.reduce((n,e)=>n+e.ve,0),allMemoryBound,events:events.map(e=>({id:e.id,start:e.start,end:e.end,hbm:e.hbm}))};
}
