/** Independent scalar ledger for the four-layer, one-query source fragment. No project/core imports. */
export function csa2Oracle(B=1,C=5,H=4,profile:'independent'|'kv-only'|'csa2'='csa2',storage:'packed'|'bf16'='packed',policy:'serial'|'ideal'='serial'){
  const D=16,J=8,R=2,O=2,W=2,K=2,BS=2,N=C+1,k=Math.min(K,N),recent=Math.min(K,N-Math.floor((N-1)/BS)*BS),w=Math.min(W,N),groups=profile==='independent'?4:1,indexers=profile==='csa2'?2:4,mainRow=storage==='packed'?9:32,indexRow=storage==='packed'?5:16,windowRow=storage==='packed'?17:32;
  const commonWeights=2*(H*R+R*D+H*D+D*O+O*H+R+D)+4,globalWeights=2*(H*D+D*J+D+J),indexWeights=2*(R*J+H),weights=4*commonWeights+groups*globalWeights+indexers*indexWeights,state=B*(groups*N*(mainRow+indexRow)+4*w*windowRow);
  type Event={id:string;read:string[];write:string[];matrix:number;vector:number;hbm:number;seconds:number;start:number;end:number};
  const events:Event[]=[],sizes=new Map<string,number>([['input',2*B*H]]),producer=new Map<string,Event>(),lastRead=new Map<string,Event>(),layerTimes:number[]=[];
  let offset=0;
  for(let i=0;i<4;i++){
    const full=profile==='independent'||i===0,indexer=full||profile==='kv-only'||i===2,source=indexer?i:i===1?0:2,valid=i===0||!indexer&&source===0?k:recent,P=w+valid,prefix=i+'/',x=i===0?'input':(i-1)+'/z',local=new Map<string,Event>();
    const s=(id:string,bytes:number)=>{sizes.set(prefix+id,bytes);return prefix+id;};
    const qra=s('qra',2*B*R),qr=s('qr',2*B*R),qb=s('qb',2*B*D),q=s('q',2*B*D),win=s('raw-window',2*B*D),raw=s('raw-main',2*B*D),latent=s('latent',2*B*D),ik=s('raw-index',2*B*J),iq0=s('iq0',2*B*J),iq=s('iq',2*B*J),iw=s('iw',2*B),logits=s('logits',4*B*N),post=s('post',4*B*N),masked=s('masked',4*B*N),idx=i+'/indices',candidate='candidates',gather=s('gather',2*B*D*P),scores=s('scores',4*B*P),probs=s('probs',4*B*P),attn=s('attn',2*B*D),rot=s('rot',2*B*D),o=s('o',2*B*O),y=s('y',2*B*H),z=s('z',2*B*H);
    if(indexer)sizes.set(idx,4*B*k);if(i===0)sizes.set(candidate,B*N);
    const bytes=(ids:string[])=>ids.reduce((n,id)=>n+(sizes.get(id)??0),0);
    const add=(id:string,read:string[],write:string[],m=0,v=0,extra=0)=>{const hbm=bytes(read)+bytes(write)+extra,e:Event={id:prefix+id,read,write,matrix:m,vector:v,hbm,seconds:Math.max((m+v)/1000,hbm/100),start:0,end:0};local.set(id,e);return e;};
    add('qa',[x],[qra],2*B*H*R,0,2*H*R);add('qn',[qra],[qr],0,5*B*R,2*R);add('qb',[qr],[qb],2*B*R*D,0,2*R*D);add('qr',[qb],[q],0,6*B*D/4);
    add('wp',[x],[win],2*B*H*D,0,2*H*D);add('ww',[win],[],0,8*B*D,2*D+B*windowRow);
    if(full){add('mp',[x],[raw],2*B*H*D,0,2*H*D);add('mn',[raw],[latent],0,5*B*D,2*D);add('ik',[latent],[ik],2*B*D*J,0,2*D*J);add('ip',[ik],[],0,8*B*J,2*J+B*indexRow);}
    if(indexer){
      add('iq',[qr],[iq0],2*B*R*J,0,2*R*J);add('iqp',[iq0],[iq],0,8*B*J);add('iw',[x],[iw],2*B*H,0,2*H);add('is',[iq],[logits],2*B*N*J,storage==='packed'?2*B*N*J:0,B*N*indexRow);add('ia',[logits,iw],[post],0,2*B*N);
      if(i===0)add('candidate',[post],[candidate],0,2*B*N+2*B*Math.ceil(N/BS));else add('mask',[post,candidate],[masked],0,B*N);
      add('topk',[i===0?post:masked],[idx],0,3*B*N);
    }
    if(full)add('mw',[latent],[],0,3*B*D,B*mainRow);
    add('gather',[source+'/indices'],[gather],0,storage==='packed'?2*B*D*P:0,B*(valid*mainRow+w*windowRow));add('qk',[q,gather],[scores],2*B*D*P);add('sm',[scores],[probs],0,5*B*(P+1),4);add('av',[probs,gather],[attn],2*B*D*P);add('or',[attn],[rot],0,6*B*D/4);add('oa',[rot],[o],2*B*D*O,0,2*D*O);add('ob',[o],[y],2*B*O*H,0,2*O*H);add('res',[x,y],[z],0,B*H);
    // Hand-authored legal serial order of the three branches, followed by the attention tail.
    const order=full?['qa','wp','mp','qn','ww','mn','qb','ik','qr','ip']:indexer?['qa','wp','qn','ww','qb','iq','qr']:['qa','wp','qn','ww','qb','qr'];
    if(full)order.push('iq');if(indexer)order.push('iqp','iw','is','ia',i===0?'candidate':'mask','topk');if(full)order.push('mw');order.push('gather','qk','sm','av','or','oa','ob','res');
    const get=(id:string)=>{const e=local.get(id);if(!e)throw Error(id);return e;},end=(id:string)=>get(id).end;
    if(policy==='serial'){let cursor=offset;for(const id of order){const e=get(id);e.start=cursor;e.end=cursor+e.seconds;cursor=e.end;}layerTimes.push(cursor-offset);offset=cursor;}
    else {
      const at=(id:string,start:number)=>{const e=get(id);e.start=start;e.end=start+e.seconds;};
      at('qa',offset);at('qn',end('qa'));at('qb',end('qn'));at('qr',end('qb'));at('wp',offset);at('ww',end('wp'));
      if(full){at('mp',offset);at('mn',end('mp'));at('ik',end('mn'));at('ip',end('ik'));}
      let indexReady=offset;
      if(indexer){at('iq',Math.max(end('qn'),full?end('ip'):offset));at('iqp',end('iq'));at('iw',end('iqp'));at('is',end('iw'));at('ia',end('is'));const select=i===0?'candidate':'mask';at(select,end('ia'));at('topk',end(select));indexReady=end('topk');}
      if(full){at('mw',indexReady);indexReady=end('mw');}
      at('gather',Math.max(end('qr'),end('ww'),indexReady));let cursor=end('gather');for(const id of ['qk','sm','av','or','oa','ob','res']){at(id,cursor);cursor=end(id);}layerTimes.push(cursor-offset);offset=cursor;
    }
    for(const id of order){const e=get(id);events.push(e);for(const out of e.write)producer.set(out,e);for(const input of e.read){const old=lastRead.get(input);if(!old||old.end<e.end)lastRead.set(input,e);}}
  }
  let activationPeak=0,peakAt=0;const samples=[...new Set(events.map(e=>e.start))];
  for(const time of samples){let live=0;for(const [id,bytes] of sizes){const birth=id==='input'?0:producer.get(id)?.start,death=id==='3/z'?offset:lastRead.get(id)?.end??producer.get(id)?.end;if(birth!==undefined&&death!==undefined&&birth<=time+1e-12&&time<death-1e-12)live+=bytes;}if(live>activationPeak){activationPeak=live;peakAt=time;}}
  const hbm=events.reduce((n,e)=>n+e.hbm,0),matrix=events.reduce((n,e)=>n+e.matrix,0),vector=events.reduce((n,e)=>n+e.vector,0),usefulVector=events.reduce((n,e)=>n+(/\/(gather|is)$/.test(e.id)?0:e.vector),0);
  return {B,C,H,profile,storage,policy,N,slots:k,recentValid:recent,globalGroups:groups,indexers,weights,state,activationPeak,peak:weights+state+activationPeak,peakAt,hbm,matrix,vector,usefulVector,conversionVector:vector-usefulVector,seconds:offset,layerTimes,allMemoryBound:events.every(e=>e.hbm/100>=(e.matrix+e.vector)/1000)};
}
