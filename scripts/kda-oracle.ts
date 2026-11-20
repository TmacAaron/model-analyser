/** Independent scalar ledger, without graph builder, core or formula parser imports. */
export function kdaOracle(profile:'hybrid'|'all-kda'|'all-mla'='hybrid',allocation:'source'|'inplace'='source',B=1,C=15,H=8,N=2){
  const D=4,W=4,R=4,P=2,L=C+1,kdas=profile==='all-kda'?4:profile==='all-mla'?0:3,mlas=4-kdas,kw=2*H+8*H*N*D+6*N*D*W+4*H*D+4*N*D*D+4*N+4*N*D+2*H*N+2*D,mw=2*H+2*H*N*(D+P)+2*H*(R+P)+2*R+4*R*N*D+2*N*D*H;
  const weights=kdas*kw+mlas*mw,state=B*(kdas*(6*N*D*W+4*N*D*D)+mlas*2*L*N*(2*D+P));
  type E={id:string;reads:string[];writes:string[];deps:string[];hbm:number;matrix:number;useful:number;vector:number;workspace:number;seconds:number;start:number;end:number};const events:E[]=[],sizes=new Map<string,number>([['x',2*B*H]]),producer=new Map<string,string>();
  const add=(id:string,reads:string[],writes:Record<string,number>,hbm:number,matrix=0,useful=0,conversion=0,workspace=0)=>{const deps=[...new Set(reads.map(r=>producer.get(r)).filter((s):s is string=>s!==undefined))];events.push({id,reads,writes:Object.keys(writes),deps,hbm,matrix,useful,vector:useful+conversion,workspace,seconds:Math.max(matrix/2000+(useful+conversion)/1000,hbm/100),start:0,end:0});for(const [t,size] of Object.entries(writes)){sizes.set(t,size);producer.set(t,id);}};
  for(let layer=0;layer<4;layer++){
    const kda=profile==='all-kda'||profile==='hybrid'&&layer<3,p='l'+layer+'/',x=layer===0?'x':'l'+(layer-1)+'/z',id=(s:string)=>p+s;
    add(id('norm'),[x],{[id('input')]:2*B*H},4*B*H+2*H,0,5*B*H);
    if(kda){
      for(const part of ['q','k','v']){add(id(part+'p'),[id('input')],{[id(part+'raw')]:2*B*N*D},2*B*H+2*H*N*D+2*B*N*D,2*B*H*N*D);add(id(part+'c'),[id(part+'raw')],{[id(part)]:2*B*N*D},2*N*D*W+B*N*D*(4*W+2),0,B*N*D*(2*W+3),B*N*D*(2*W+1));}
      for(const gate of ['f','g']){add(id(gate+'a'),[id('input')],{[id(gate+'a')]:2*B*D},2*B*H+2*H*D+2*B*D,2*B*H*D);add(id(gate+'b'),[id(gate+'a')],{[id(gate+'raw')]:2*B*N*D},2*B*D+2*N*D*D+2*B*N*D,2*B*N*D*D);}
      add(id('decay'),[id('fraw')],{[id('decay')]:4*B*N*D},6*B*N*D+4*N+4*N*D,0,B*N*(5*D+2),B*N*D);
      add(id('betap'),[id('input')],{[id('betaraw')]:2*B*N},2*B*H+2*H*N+2*B*N,2*B*H*N);add(id('beta'),[id('betaraw')],{[id('beta')]:4*B*N},6*B*N,0,4*B*N,B*N);
      add(id('rnn'),[id('q'),id('k'),id('v'),id('decay'),id('beta')],{[id('rnnout')]:2*B*N*D},12*B*N*D+4*B*N+8*B*N*D*D,0,B*N*(7*D*D+8*D+2),4*B*N*D,allocation==='source'?4*B*N*D*D:0);
      add(id('onorm'),[id('rnnout'),id('graw')],{[id('gated')]:2*B*N*D},6*B*N*D+2*D,0,10*B*N*D);add(id('out'),[id('gated')],{[id('y')]:2*B*H},2*B*N*D+2*N*D*H+2*B*H,2*B*H*N*D);
    }else{
      add(id('q'),[id('input')],{[id('q')]:2*B*N*(D+P)},2*B*H+2*H*N*(D+P)+2*B*N*(D+P),2*B*H*N*(D+P));add(id('ka'),[id('input')],{[id('raw')]:2*B*(R+P)},2*B*H+2*H*(R+P)+2*B*(R+P),2*B*H*(R+P));add(id('kn'),[id('raw')],{[id('latent')]:2*B*R,[id('pe')]:2*B*P},4*B*(R+P)+2*R,0,5*B*R);add(id('kb'),[id('latent')],{[id('expanded')]:4*B*N*D},2*B*R+4*R*N*D+4*B*N*D,4*B*R*N*D);
      add(id('cache'),[id('expanded'),id('pe')],{[id('cache-ready')]:0},4*B*N*D+2*B*P+2*B*N*(2*D+P)*(allocation==='source'?C+L:1),0,0,0,allocation==='source'?2*B*C*N*(2*D+P):0);
      add(id('qk'),[id('q'),id('cache-ready')],{[id('scores')]:2*B*N*L},2*B*N*(D+P)+2*B*L*N*(D+P)+2*B*N*L,2*B*N*L*(D+P));add(id('soft'),[id('scores')],{[id('prob')]:2*B*N*L},4*B*N*L,0,6*B*N*L);add(id('av'),[id('prob'),id('cache-ready')],{[id('attended')]:2*B*N*D},2*B*N*L+2*B*L*N*D+2*B*N*D,2*B*N*L*D);add(id('out'),[id('attended')],{[id('y')]:2*B*H},2*B*N*D+2*N*D*H+2*B*H,2*B*N*D*H);
    }
    add(id('residual'),[x,id('y')],{[id('z')]:2*B*H},6*B*H,0,B*H);
  }
  const get=(id:string)=>{const e=events.find(e=>e.id===id);if(!e)throw Error(id);return e;},next=new Map<string,string[]>(),remaining=new Map(events.map(e=>[e.id,e.deps.length])),queue=events.filter(e=>!e.deps.length).map(e=>e.id),ordered:E[]=[];for(const e of events)for(const d of e.deps)next.set(d,[...(next.get(d)??[]),e.id]);for(let i=0;i<queue.length;i++){const id=queue[i];if(!id)throw Error();ordered.push(get(id));for(const to of next.get(id)??[]){const n=(remaining.get(to)??0)-1;remaining.set(to,n);if(!n)queue.push(to);}}if(ordered.length!==events.length)throw Error('Ledger cycle');let clock=0;for(const e of ordered){e.start=clock;e.end=clock+e.seconds;clock=e.end;}
  const born=new Map<string,number>([['x',0]]),last=new Map<string,number>();for(const e of ordered){for(const t of e.writes)born.set(t,e.start);for(const t of e.reads)last.set(t,Math.max(last.get(t)??0,e.end));}last.set('l3/z',clock);let transient=0,activation=0,workspace=0,peakNode='';for(const e of ordered){let a=0;for(const [id,bytes] of sizes){const start=born.get(id),end=last.get(id)??events.filter(e=>e.writes.includes(id)).reduce((n,e)=>Math.max(n,e.end),0);if(start!==undefined&&start<=e.start+1e-10&&e.start<end-1e-10)a+=bytes;}if(a+e.workspace>transient){transient=a+e.workspace;activation=a;workspace=e.workspace;peakNode=e.id;}}
  return {profile,allocation,B,C,H,N,kdas,mlas,weights,state,activation,workspace,peak:weights+state+transient,peakNode,seconds:clock,hbm:events.reduce((s,e)=>s+e.hbm,0),matrix:events.reduce((s,e)=>s+e.matrix,0),vectorUseful:events.reduce((s,e)=>s+e.useful,0),vector:events.reduce((s,e)=>s+e.vector,0),perKdaWeights:kw,perMlaWeights:mw,events:ordered.map(e=>({id:e.id,seconds:e.seconds,hbm:e.hbm,workspace:e.workspace}))};
}

/** Math fixture with already normalized Q/K, alpha=exp(g), no floating-point kernel claim. */
export function kdaStep(state:number[][],q:number[],k:number[],v:number[],alpha:number[],beta:number){
  const width=k.length,values=v.length;if(state.length!==width||q.length!==width||alpha.length!==width||state.some(row=>row.length!==values))throw Error('Invalid recurrent dimensions');
  const decayed=state.map((row,i)=>row.map(x=>x*(alpha[i]??0))),predicted=v.map((_,j)=>decayed.reduce((n,row,i)=>n+(row[j]??0)*(k[i]??0),0)),delta=v.map((x,j)=>beta*(x-(predicted[j]??0))),next=decayed.map((row,i)=>row.map((x,j)=>x+(k[i]??0)*(delta[j]??0))),output=v.map((_,j)=>next.reduce((n,row,i)=>n+(row[j]??0)*(q[i]??0)/Math.sqrt(width),0));return {next,output};
}
