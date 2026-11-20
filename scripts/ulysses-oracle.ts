/** Independent arithmetic for this authored unmasked/materialized MHA only. No core imports. */
export function ulyssesOracle(B=1,S=4,NH=2,D=2,degree=2,mode:'ulysses'|'replicated'='ulysses'){
  const E=NH*D,split=mode==='ulysses',exchange=split&&degree>1;
  if(split&&(S%degree||NH%degree))throw Error('Oracle requires exact sequence/head division');
  const s=split?S/degree:S,h=split?NH/degree:NH,L=2*B*s*E,A=2*B*S*h*D,T=2*B*h*S*S,W=8*E*E;
  const projectionOps=2*B*s*E*E,attentionOps=2*B*h*S*S*D,softmaxOps=5*B*h*S*S,residualOps=B*s*E;
  const projectionBytes=2*L+2*E*E,attentionBytes=2*A+T,softmaxBytes=6*T,residualBytes=3*L;
  const hbmPerDevice=4*projectionBytes+2*attentionBytes+softmaxBytes+residualBytes;
  const leafSeconds=4*Math.max(projectionOps/1000,projectionBytes/100)+2*Math.max(attentionOps/1000,attentionBytes/100)+Math.max(softmaxOps/1000,softmaxBytes/100)+Math.max(residualOps/1000,residualBytes/100);
  const sourcePayload=exchange?L:0,remoteBytes=exchange?L*(degree-1)/degree:0,networkSeconds=exchange?4*(remoteBytes/1000+(degree-1)*.001):0;
  const peakPerDevice=W+Math.max((exchange?5:4)*L,L+3*A+T,L+A+4*T,L+2*A+T,exchange?2*L+A:0,3*L);
  const logicalMatrix=8*B*S*E*E+4*B*NH*S*S*D,logicalVector=5*B*NH*S*S+B*S*E,physicalFactor=split?1:degree;
  return {B,S,NH,D,degree,mode,logicalMatrix,logicalVector,physicalMatrix:logicalMatrix*physicalFactor,physicalVector:logicalVector*physicalFactor,
    matrixPerDevice:4*projectionOps+2*attentionOps,vectorPerDevice:softmaxOps+residualOps,weightPerDevice:W,hbmPerDevice,peakPerDevice,
    sourcePayloadPerExchangePerRank:sourcePayload,remoteBytesPerExchangePerRank:remoteBytes,networkGroupRemoteBytes:remoteBytes*degree*4,networkSeconds,leafSeconds,seconds:leafSeconds+networkSeconds,
    peakCandidates:{projection:(exchange?5:4)*L+W,qk:W+L+3*A+T,softmax:W+L+A+4*T,av:W+L+2*A+T,returnExchange:exchange?W+2*L+A:0,output:W+3*L}};
}
