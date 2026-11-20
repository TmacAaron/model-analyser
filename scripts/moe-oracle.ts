/** Independent arithmetic for the fixed top-2 routing and materialized buffers. No core imports. */
export function moeOracle(B=1,Q=4,H=4,I=8,tp:1|2=2,policy:'serial'|'streams'='serial',profile:'balanced'|'concentrated'='balanced'){
  const T=B*Q,n=2*tp,A=profile==='balanced'?2:1;
  if(T%n||I%tp)throw Error('Oracle requires exact source-token and expert-inner partitions');
  const X=2*H*T/n,W=8*H+12*H*I/tp,L=T*(2*H+12)/tp,G=T*(2*H+12),D=2*T*H,M=12*T,F=2*T*I/tp,Wa=2*A*H*I/tp,R=G/n,U=(2*H+4)*T/n;
  const roof=(ops:number,bytes:number)=>Math.max(ops/1000,bytes/100);
  const routerBytes=2*X+8*H+80*T/n+L,ownerBytes=3*L+2*G+(3+1/tp)*D+3*Wa+36*T+6*F,rootBytes=2*(R+U)+6*X+8*T/n;
  const routerSeconds=roof(8*H*T/n,X+8*H+16*T/n)+roof(12*T/n,40*T/n)+(X+24*T/n+L)/100;
  const ownerSeconds=2*L/100+2*G/100+3*roof(2*T*H*I/tp,D+Wa+8*T+F)+roof(5*T*I/tp,3*F)+(D/tp+M+L)/100;
  const rootSeconds=2*(R+U)/100+roof(3*T*H/n,3*X+8*T/n)+roof(T*H/n,3*X);
  const dispatchSeconds=(tp===1?L/2:L)/1000+(n-1)*.001,agSeconds=tp===2?L/1000+.001:0,rsSeconds=tp===2?D/2/1000+.001:0,combineSeconds=(tp===1?G/2:L)/1000+(n-1)*.001;
  const networkSeconds=dispatchSeconds+2*(agSeconds+rsSeconds+combineSeconds),leafSeconds=routerSeconds+2*ownerSeconds+rootSeconds;
  const peakCandidates={topk:40*T/n,pack:24*T/n+L,prepare:2*L,gather:tp===2?L+G:0,unpack:2*G,up:D+M+2*F,activation:M+3*F,down:M+F+D,reduce:tp===2?M+D+D/tp:0,repack:M+D/tp+L,return:Math.max(L+R+U,R+2*U,2*U+X,2*X)};
  return {B,Q,H,I,tp,policy,profile,physicalDevices:n,touchedPerOwner:A,logicalMatrix:8*T*H+12*T*H*I,logicalVector:12*T+10*T*I+4*T*H,
    matrixPerDevice:8*H*T/n+6*T*H*I/tp,vectorPerDevice:12*T/n+5*T*I/tp+4*T*H/n,weightPerDevice:W,activeWeightReadPerGemm:Wa,hbmPerDevice:routerBytes+ownerBytes+rootBytes,
    peakPerDevice:W+X+Math.max(...Object.values(peakCandidates)),peakCandidates,sourcePayload:L,dispatchRemote:tp===1?[L/2,L/2]:[L/2,L,L,L/2],dispatchSeconds,agSeconds,rsSeconds,combineSeconds,
    networkGroupRemoteBytes:tp===1?2*L:6*L+4*L+2*D,networkSeconds,leafSeconds,routerSeconds,ownerSeconds,rootSeconds,
    seconds:leafSeconds+networkSeconds-(policy==='streams'?ownerSeconds+agSeconds+rsSeconds:0)};
}
