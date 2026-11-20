/** Independent scalar ledger. Does not import assets, contracts, graphs or the analysis engine. */
export function contextOracle(kind:'pcp'|'dcp',degree:1|2=2,B=1,Q=kind==='pcp'?4:1,C=kind==='pcp'?0:5,H=2,D=2,M=8){
  if(C+Q>M||kind==='pcp'&&Q%degree||kind==='dcp'&&(Q!==1||M%degree))throw Error('Oracle domain');
  const roof=(ops:number,bytes:number)=>Math.max(ops/1000,bytes/100),W=2*(H*D)**2,T=C+Q;
  if(kind==='pcp'){
    const q=Q/degree,X=2*B*q*H*D,G=2*B*Q*H*D,F=2*B*T*H*D,S=4*B*H*q*T,A=2*B*H*q*T,persistent=3*W+2*F,projection=2*B*q*(H*D)**2;
    const ranks=Array.from({length:degree},(_,r)=>{const pairs=q*(C+r*q)+q*(q+1)/2;return {queryStart:r*q,pairs,matrixUseful:3*projection+4*B*H*pairs*D,matrixExecuted:3*projection+4*B*H*q*T*D,vectorUseful:5*B*H*pairs,vectorExecuted:5*B*H*q*T,hbm:8*X+3*W+4*G+2*F+4*S+2*A};});
    const leafSeconds=3*roof(projection,2*X+W)+4*G/100+roof(2*B*H*q*T*D,X+F+S)+roof(5*B*H*q*T,3*S+A)+roof(2*B*H*q*T*D,A+F+X),networkSeconds=degree===1?0:2*((G/degree)*(degree-1)/1000+(degree-1)*.001);
    const peak=persistent+Math.max(4*X,degree>1?2*X+2*G:0,degree>1?X+2*G:3*X,X+S,2*S+A,A+X);
    return {kind,degree,B,Q,C,H,D,M,weightPerDevice:3*W,statePerDevice:2*F,ranks,seconds:leafSeconds+networkSeconds,networkSeconds,peakPerDevice:peak,logicalMatrix:6*B*Q*(H*D)**2+4*B*H*(C*Q+Q*(Q+1)/2)*D,logicalVector:5*B*H*(C*Q+Q*(Q+1)/2)};
  }
  const cap=M/degree,X=2*B*H*D,K=2*B*H*cap*D,S=4*B*H*cap,U=2*B*H*cap,R=4*B*H,N=4*B*H*D,persistent=3*W+2*K,projection=2*B*(H*D)**2;
  const ranks=Array.from({length:degree},(_,r)=>{const valid=Math.max(0,Math.min(cap,T-r*cap)),owns=C>=r*cap&&C<(r+1)*cap,ownedWrites=owns?2*X:0;return {start:r*cap,end:(r+1)*cap,valid,ownedWrites,matrixUseful:3*projection+4*B*H*valid*D,matrixExecuted:3*projection+4*B*H*cap*D,vectorUseful:2*B*H*Math.max(valid-1,0)+3*B*H*valid+B*H*D,vectorExecuted:2*B*H*Math.max(valid-1,0)+3*B*H*cap+B*H*D,hbm:9*X+3*W+ownedWrites+2*K+3*S+3*U+4*R+3*N};});
  const networkSeconds=degree===1?0:(2*R+N)*2*(degree-1)/degree/1000+3*2*(degree-1)*.001;
  const leafSeconds=3*roof(projection,2*X+W)+4*X/100+roof(2*B*H*cap*D,X+K+S)+Math.max(...ranks.map(r=>roof(B*H*Math.max(r.valid-1,0),S+R)))+roof(3*B*H*cap,S+R+U)+Math.max(...ranks.map(r=>roof(B*H*Math.max(r.valid-1,0),U+R)))+roof(2*B*H*cap*D,U+K+N)+roof(B*H*D,2*N+R);
  const peak=persistent+Math.max(4*X,3*X,X+S,S+R,degree>1?S+2*R:0,S+R+U,U+R,U+R+N,degree>1?2*R+N:0,R+2*N);
  return {kind,degree,B,Q,C,H,D,M,weightPerDevice:3*W,statePerDevice:2*K,ranks,seconds:leafSeconds+networkSeconds,networkSeconds,peakPerDevice:peak,logicalMatrix:6*B*(H*D)**2+4*B*H*T*D,logicalVector:2*B*H*Math.max(T-1,0)+3*B*H*T+B*H*D};
}

/** Separate numerical witness for the actual stable merge, including an empty shard. */
export function stableShardAttention(scores:number[],values:number[][],width:number,shards=Math.ceil(scores.length/width)){
  if(!scores.length||width<1||shards*width<scores.length)throw Error('Invalid numerical witness domain');
  const chunks=Array.from({length:shards},(_,i)=>scores.slice(i*width,(i+1)*width)),maxima=chunks.map(c=>c.length?Math.max(...c):-Infinity),m=Math.max(...maxima),denominators:number[]=[],numerators:number[][]=[];
  for(let r=0;r<chunks.length;r++){const c=chunks[r]??[],weights=c.map(x=>Math.exp(x-m));denominators.push(weights.reduce((a,b)=>a+b,0));numerators.push(Array.from({length:values[0]?.length??0},(_,d)=>weights.reduce((n,w,i)=>n+w*(values[r*width+i]?.[d]??0),0)));}
  const denominator=denominators.reduce((a,b)=>a+b,0);return {maxima,denominators,numerators,output:(numerators[0]??[]).map((_,d)=>numerators.reduce((n,row)=>n+(row[d]??0),0)/denominator)};
}

export function pipelineOracle(B=1,Q=1,C=2,H=8,NH=4,NK=2,D=2){
  const T=C+Q,pairs=C*Q+Q*(Q+1)/2,X=2*B*Q*H,Qt=2*B*Q*NH*D,Kt=2*B*Q*NK*D,K=2*B*T*NK*D,S=2*B*NH*Q*T,Scratch=2*S,WQ=2*H*NH*D,WK=2*H*NK*D,weight=2*WQ+2*WK,state=2*K,roof=(o:number,b:number)=>Math.max(o/1000,b/100);
  const bytes=[X+WQ+Qt,X+WK+Kt,X+WK+Kt,4*Kt,Qt+K+S,2*S+2*Scratch,S+K+Qt,Qt+WQ+X,3*X],ops=[2*B*Q*H*NH*D,2*B*Q*H*NK*D,2*B*Q*H*NK*D,0,2*B*NH*Q*T*D,5*B*NH*Q*T,2*B*NH*Q*T*D,2*B*Q*NH*D*H,B*Q*H];
  const stageSeconds=bytes.reduce((n,b,i)=>n+roof(ops[i]??0,b),0),payload=X;
  return {B,Q,C,H,NH,NK,D,stageSeconds,seconds:2*stageSeconds+payload/1000+.001,payload,networkSeconds:payload/1000+.001,weightPerDevice:weight,statePerDevice:state,hbmPerDevice:bytes.reduce((a,b)=>a+b,0),peakPerDevice:weight+state+Math.max(X+Qt+2*Kt,X+Qt+S,X+2*S+Scratch,X+S+Qt,2*X+Qt,3*X),matrixPerDevice:4*B*Q*H*D*(NH+NK)+4*B*NH*pairs*D,matrixExecutedPerDevice:4*B*Q*H*D*(NH+NK)+4*B*NH*Q*T*D,vectorPerDevice:5*B*NH*pairs+B*Q*H,vectorExecutedPerDevice:5*B*NH*Q*T+B*Q*H};
}
