import type { CommunicationEvaluation,MetricValue } from './index.js';

/** Check the explicit member ledger independently of the numerical evaluator. */
export function validateMemberPayloadResult(c:CommunicationEvaluation):string[]{
  const declarations=c.definition.perDevicePayloads;
  if(!declarations)return [];
  const issues:string[]=[],members=c.cost.scope.deviceIds,rows=c.perDevice,summary=c.cost.communications[0];
  const value=(m:MetricValue|undefined)=>m?.status==='available'?m.quantity.value:undefined;
  const close=(a:number,b:number)=>Math.abs(a-b)<=1e-12*Math.max(Math.abs(a),Math.abs(b),Number.MIN_VALUE);
  const check=(m:MetricValue|undefined,n:number|undefined,label:string)=>{const actual=value(m);if(n===undefined?!m||m.status!=='unavailable':actual===undefined||!close(actual,n))issues.push(label);};
  const exactMembers=(ids:string[])=>ids.length===members.length&&new Set(ids).size===members.length&&ids.every(id=>members.includes(id as typeof members[number]));
  if(c.definition.operation==='send_recv'||!exactMembers(declarations.map(p=>p.deviceId))||!exactMembers(rows.map(p=>p.deviceId)))issues.push('逐设备通信明细必须唯一完整地覆盖物理成员');
  for(const row of rows){const p=declarations.find(p=>p.deviceId===row.deviceId);if(!p)continue;
    for(const key of ['sendBytes','receiveBytes'] as const)if(p[key].kind==='literal')check(row[key],p[key].quantity.value,'逐设备payload与常量声明不符');
    const sent=value(row.sendBytes),remote=sent===undefined?undefined:sent*p.trafficFactor;
    check(row.algorithmTrafficBytes,remote!==undefined&&Number.isFinite(remote)&&!((sent??0)>0&&p.trafficFactor>0&&remote===0)?remote:undefined,'逐设备算法流量必须只应用一次声明系数');
  }
  if(!summary||c.cost.communications.length!==1){issues.push('通信必须有唯一完整汇总');return issues;}
  const sum=(metrics:MetricValue[])=>{const ns=metrics.map(value);if(ns.some(n=>n===undefined))return undefined;const n=(ns as number[]).reduce((a,b)=>a+b,0);return Number.isFinite(n)?n:undefined;};
  const common=(metrics:MetricValue[])=>{const ns=metrics.map(value),first=ns[0];return first!==undefined&&ns.every(n=>n===first)?first:undefined;};
  check(summary.groupSendBytes,sum(rows.map(p=>p.sendBytes)),'组发送payload必须是逐设备合计');
  check(summary.groupReceiveBytes,sum(rows.map(p=>p.receiveBytes)),'组接收payload必须是逐设备合计');
  for(const [key,scalar] of [['sendBytes','sendBytesPerMember'],['receiveBytes','receiveBytesPerMember'],['algorithmTrafficBytes','algorithmTrafficBytesPerMember']] as const)check(summary[scalar],common(rows.map(p=>p[key])),'非统一成员数量不得以平均值或代表rank替代');
  if(c.definition.timing.kind==='bandwidth_latency'){
    const ns=rows.map(p=>value(p.algorithmTrafficBytes)),max=ns.every(n=>n!==undefined)?Math.max(...ns as number[]):undefined;
    const transfer=max===undefined?undefined:max/c.definition.timing.bytePerSecond;
    const seconds=transfer===undefined||(max??0)>0&&transfer===0?undefined:transfer+c.definition.algorithm.startupRounds*c.definition.timing.latencySeconds;
    check(c.cost.seconds,seconds!==undefined&&Number.isFinite(seconds)?seconds:undefined,'通信跨度必须按最慢实际rank和启动轮数计算');
  }
  return issues;
}
