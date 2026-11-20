/** Independent batched stage ledger: no generated graph, core or expression imports. */
export function kdaPrefillOracle(profile:'hybrid'|'all-kda'|'all-mla'='hybrid',route:'short'|'chunk'='short',B=1,Q=profile==='all-mla'?8:route==='chunk'?65:8,H=8,N=2){
  const D=4,W=4,R=4,P=2,nt=Math.ceil(Q/64),tail=Q%64,full=Math.floor(Q/64),padded=64*nt,sq=4096*full+tail*tail,inc=2080*full+tail*(tail+1)/2,strict=sq-inc,cubic=64*4095/3*full+tail*(tail*tail-1)/3,kdas=profile==='all-kda'?4:profile==='all-mla'?0:3,mlas=4-kdas;
  const kw=2*H+8*H*N*D+6*N*D*W+4*H*D+4*N*D*D+4*N+4*N*D+2*H*N+2*D,mw=2*H+2*H*N*(D+P)+2*H*(R+P)+2*R+4*R*N*D+2*N*D*H,weights=kdas*kw+mlas*mw,state=B*(kdas*(6*N*D*W+4*N*D*D)+mlas*2*Q*N*(2*D+P));
  type E={id:string;reads:string[];writes:string[];deps:string[];hbm:number;mu:number;me:number;vu:number;ve:number;workspace:number;seconds:number;start:number;end:number};const events:E[]=[],sizes=new Map<string,number>([['x',2*B*Q*H]]),producer=new Map<string,string>();
  const add=(id:string,reads:string[],writes:Record<string,number>,hbm:number,mu=0,vu=0,extra:{me?:number;ve?:number;workspace?:number}={})=>{const deps=[...new Set(reads.map(r=>producer.get(r)).filter((s):s is string=>s!==undefined))],me=extra.me??mu,ve=extra.ve??vu;events.push({id,reads,writes:Object.keys(writes),deps,hbm,mu,me,vu,ve,workspace:extra.workspace??0,seconds:Math.max(me/2000+ve/1000,hbm/100),start:0,end:0});for(const [t,size] of Object.entries(writes)){sizes.set(t,size);producer.set(t,id);}};
  if(mlas)add('mask',[],{mask:2*B*Q*Q},2*B*Q*Q,0,0,{ve:B*Q*Q});
  for(let layer=0;layer<4;layer++){
    const kda=profile==='all-kda'||profile==='hybrid'&&layer<3,p='l'+layer+'/',x=layer===0?'x':'l'+(layer-1)+'/z',id=(s:string)=>p+s,start=events.length;
    add(id('norm'),[x],{[id('input')]:2*B*Q*H},4*B*Q*H+2*H,0,5*B*Q*H);
    if(kda){
      const m=Math.min(Q,W-1),hist=m*(W-1)-m*(m-1)/2;
      for(const part of ['q','k','v']){add(id(part+'p'),[id('input')],{[id(part+'raw')]:2*B*Q*N*D},2*B*Q*H+2*H*N*D+2*B*Q*N*D,2*B*Q*H*N*D);add(id(part+'c'),[id(part+'raw')],{[id(part)]:2*B*Q*N*D},2*N*D*W+2*B*N*D*(Q*W+Q+2*W),0,B*N*D*(2*(Q*W-hist)+3*Q),{ve:B*Q*N*D*(4*W+4)});}
      for(const gate of ['f','g']){add(id(gate+'a'),[id('input')],{[id(gate+'a')]:2*B*Q*D},2*B*Q*H+2*H*D+2*B*Q*D,2*B*Q*H*D);add(id(gate+'b'),[id(gate+'a')],{[id(gate+'raw')]:2*B*Q*N*D},2*B*Q*D+2*N*D*D+2*B*Q*N*D,2*B*Q*N*D*D);}
      add(id('decay'),[id('fraw')],{[id('decay')]:4*B*Q*N*D},6*B*Q*N*D+4*N+4*N*D,0,B*Q*N*(5*D+2),{ve:B*Q*N*(6*D+2)});add(id('betap'),[id('input')],{[id('betaraw')]:2*B*Q*N},2*B*Q*H+2*H*N+2*B*Q*N,2*B*Q*H*N);add(id('beta'),[id('betaraw')],{[id('beta')]:4*B*Q*N},6*B*Q*N,0,4*B*Q*N,{ve:5*B*Q*N});
      if(route==='short')add(id('rnn'),[id('q'),id('k'),id('v'),id('decay'),id('beta')],{[id('rnnout')]:2*B*Q*N*D},12*B*Q*N*D+4*B*Q*N+8*B*N*D*D,0,B*Q*N*(7*D*D+8*D+2),{ve:B*Q*N*(7*D*D+12*D+2),workspace:4*B*N*D*D});
      else{
        add(id('qknorm'),[id('q'),id('k')],{[id('qn')]:2*B*Q*N*D,[id('kn')]:2*B*Q*N*D},8*B*Q*N*D,0,B*Q*N*(6*D+2),{ve:B*Q*N*(10*D+2)});add(id('prefix'),[id('decay')],{[id('prefix')]:4*B*Q*N*D},8*B*Q*N*D,0,B*N*D*(Q-nt));
        add(id('intra'),[id('qn'),id('kn'),id('prefix'),id('beta')],{[id('aqk')]:4*B*Q*N*64,[id('akk')]:4*B*Q*N*64},8*B*Q*N*D+4*B*Q*N+8*B*Q*N*64,0,B*N*(5*D*sq+2*inc+strict),{ve:B*N*Q*64*(10*D+3)+2*B*Q*N*D});
        add(id('solve'),[id('akk')],{[id('solved')]:2*B*Q*N*64},6*B*Q*N*64,0,B*N*(cubic+Q),{ve:B*N*nt*(64*4095/3+64)+B*Q*N*64});
        add(id('wy'),[id('kn'),id('v'),id('beta'),id('solved'),id('prefix')],{[id('w')]:2*B*Q*N*D,[id('u')]:2*B*Q*N*D,[id('kg')]:2*B*Q*N*D},14*B*Q*N*D+4*B*Q*N+2*B*Q*N*64,4*B*N*D*inc,7*B*Q*N*D,{me:4*B*N*Q*64*D,ve:12*B*Q*N*D});
        add(id('inter'),[id('kg'),id('w'),id('u'),id('prefix')],{[id('history')]:2*B*nt*N*D*D,[id('vn')]:2*B*Q*N*D},12*B*Q*N*D+2*B*nt*N*D*D+8*B*N*D*D,4*B*N*Q*D*D,B*N*(Q*D+nt*(D*D+D)),{me:4*B*N*padded*D*D,ve:B*N*(padded*D+nt*(D*D+D))+B*N*(2*nt*D*D+Q*D),workspace:4*B*N*D*D});
        add(id('chunkout'),[id('qn'),id('vn'),id('prefix'),id('aqk'),id('history')],{[id('rnnout')]:2*B*Q*N*D},10*B*Q*N*D+4*B*Q*N*64+2*B*nt*N*D*D,2*B*N*Q*D*D+2*B*N*D*inc,4*B*Q*N*D,{me:2*B*N*padded*D*D+2*B*N*Q*64*D,ve:4*B*N*padded*D+B*Q*N*64+3*B*Q*N*D});
      }
      add(id('onorm'),[id('rnnout'),id('graw')],{[id('gated')]:2*B*Q*N*D},6*B*Q*N*D+2*D,0,10*B*Q*N*D);add(id('out'),[id('gated')],{[id('y')]:2*B*Q*H},2*B*Q*N*D+2*N*D*H+2*B*Q*H,2*B*Q*H*N*D);for(const e of events.slice(start))e.workspace+=6*B*N*D*W;
    }else{
      add(id('q'),[id('input')],{[id('q')]:2*B*Q*N*(D+P)},2*B*Q*H+2*H*N*(D+P)+2*B*Q*N*(D+P),2*B*Q*H*N*(D+P));add(id('ka'),[id('input')],{[id('raw')]:2*B*Q*(R+P)},2*B*Q*H+2*H*(R+P)+2*B*Q*(R+P),2*B*Q*H*(R+P));add(id('kn'),[id('raw')],{[id('latent')]:2*B*Q*R,[id('pe')]:2*B*Q*P},4*B*Q*(R+P)+2*R,0,5*B*Q*R);add(id('kb'),[id('latent')],{[id('expanded')]:4*B*Q*N*D},2*B*Q*R+4*R*N*D+4*B*Q*N*D,4*B*Q*R*N*D);
      add(id('cache'),[id('expanded'),id('pe')],{[id('cache-ready')]:0},4*B*Q*N*D+2*B*Q*P+2*B*Q*N*(2*D+P));const pairs=Q*(Q+1)/2;
      add(id('qk'),[id('q'),id('cache-ready')],{[id('score')]:2*B*N*Q*Q},4*B*Q*N*(D+P)+2*B*N*Q*Q,2*B*N*pairs*(D+P),0,{me:2*B*N*Q*Q*(D+P)});add(id('apply'),[id('score'),'mask'],{[id('score')]:2*B*N*Q*Q},4*B*N*Q*Q+2*B*Q*Q,0,B*N*Q*Q);add(id('soft'),[id('score')],{[id('prob32')]:4*B*N*Q*Q},6*B*N*Q*Q,0,6*B*N*pairs,{ve:7*B*N*Q*Q});add(id('cast'),[id('prob32')],{[id('prob')]:2*B*N*Q*Q},6*B*N*Q*Q,0,0,{ve:B*N*Q*Q});add(id('av'),[id('prob'),id('cache-ready')],{[id('attended')]:2*B*Q*N*D},2*B*N*Q*Q+4*B*Q*N*D,2*B*N*pairs*D,0,{me:2*B*N*Q*Q*D});add(id('out'),[id('attended')],{[id('y')]:2*B*Q*H},2*B*Q*N*D+2*N*D*H+2*B*Q*H,2*B*Q*N*D*H);
    }
    add(id('residual'),[x,id('y')],{[id('z')]:2*B*Q*H},6*B*Q*H,0,B*Q*H);
  }
  const get=(id:string)=>{const e=events.find(e=>e.id===id);if(!e)throw Error(id);return e;},next=new Map<string,string[]>(),remaining=new Map(events.map(e=>[e.id,e.deps.length])),queue=events.filter(e=>!e.deps.length).map(e=>e.id),ordered:E[]=[];for(const e of events)for(const d of e.deps)next.set(d,[...(next.get(d)??[]),e.id]);for(let i=0;i<queue.length;i++){const id=queue[i];if(!id)throw Error();ordered.push(get(id));for(const to of next.get(id)??[]){const n=(remaining.get(to)??0)-1;remaining.set(to,n);if(!n)queue.push(to);}}if(ordered.length!==events.length)throw Error('Ledger cycle');let clock=0;for(const e of ordered){e.start=clock;e.end=clock+e.seconds;clock=e.end;}
  const born=new Map<string,number>([['x',0]]),last=new Map<string,number>();for(const e of ordered){for(const t of e.writes)born.set(t,Math.min(born.get(t)??Infinity,e.start));for(const t of e.reads)last.set(t,Math.max(last.get(t)??0,e.end));}last.set('l3/z',clock);let transient=0,activation=0,workspace=0,peakNode='';for(const e of ordered){let a=0;for(const [id,bytes] of sizes){const start=born.get(id),end=last.get(id)??events.filter(e=>e.writes.includes(id)).reduce((n,e)=>Math.max(n,e.end),0);if(start!==undefined&&start<=e.start+1e-9&&e.start<end-1e-9)a+=bytes;}if(a+e.workspace>transient){transient=a+e.workspace;activation=a;workspace=e.workspace;peakNode=e.id;}}
  return {profile,route,B,Q,H,N,chunks:nt,lastChunkRows:tail||64,causalPairs:inc,weights,state,activation,workspace,peak:weights+state+transient,peakNode,seconds:clock,hbm:events.reduce((s,e)=>s+e.hbm,0),matrixUseful:events.reduce((s,e)=>s+e.mu,0),matrix:events.reduce((s,e)=>s+e.me,0),vectorUseful:events.reduce((s,e)=>s+e.vu,0),vector:events.reduce((s,e)=>s+e.ve,0),events:ordered.map(e=>({id:e.id,hbm:e.hbm,seconds:e.seconds,workspace:e.workspace}))};
}

/** Independent block triangular-system form; inputs Q/K are already L2 normalized. */
export function kdaChunkMath(q:number[][],k:number[][],v:number[][],alpha:number[][],beta:number[],initial:number[][],block=64){
  const count=q.length,D=initial.length,V=initial[0]?.length??0;let state=initial.map(row=>[...row]);const output:number[][]=[];
  for(let start=0;start<count;start+=block){const length=Math.min(block,count-start),prefix:number[][]=[],delta:number[][]=[];
    for(let i=0;i<length;i++)prefix.push(Array.from({length:D},(_,d)=>Math.log(alpha[start+i]?.[d]??1)+(prefix[i-1]?.[d]??0)));
    for(let i=0;i<length;i++){const at=start+i,b=beta[at]??0;const current=Array.from({length:V},(_,j)=>b*((v[at]?.[j]??0)-state.reduce((n,row,d)=>n+(k[at]?.[d]??0)*Math.exp(prefix[i]?.[d]??0)*(row[j]??0),0)));delta[i]=current;for(let prev=0;prev<i;prev++){const coefficient=b*Array.from({length:D},(_,d)=>(k[at]?.[d]??0)*Math.exp((prefix[i]?.[d]??0)-(prefix[prev]?.[d]??0))*(k[start+prev]?.[d]??0)).reduce((n,x)=>n+x,0);for(let j=0;j<V;j++)current[j]=(current[j]??0)-coefficient*(delta[prev]?.[j]??0);}}
    for(let i=0;i<length;i++){const row=Array.from({length:V},(_,j)=>state.reduce((n,h,d)=>n+(q[start+i]?.[d]??0)/Math.sqrt(D)*Math.exp(prefix[i]?.[d]??0)*(h[j]??0),0));for(let prev=0;prev<=i;prev++){const coefficient=Array.from({length:D},(_,d)=>(q[start+i]?.[d]??0)/Math.sqrt(D)*Math.exp((prefix[i]?.[d]??0)-(prefix[prev]?.[d]??0))*(k[start+prev]?.[d]??0)).reduce((n,x)=>n+x,0);for(let j=0;j<V;j++)row[j]=(row[j]??0)+coefficient*(delta[prev]?.[j]??0);}output.push(row);}
    state=state.map((row,d)=>row.map((x,j)=>Math.exp(prefix[length-1]?.[d]??0)*x+Array.from({length},(_,i)=>Math.exp((prefix[length-1]?.[d]??0)-(prefix[i]?.[d]??0))*(k[start+i]?.[d]??0)*(delta[i]?.[j]??0)).reduce((n,x)=>n+x,0)));
  }
  return {output,next:state};
}
