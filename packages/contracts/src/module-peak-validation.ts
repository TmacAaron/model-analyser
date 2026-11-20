import type { ParallelResolution,Diagnostic } from './index.js';
import { preTotalPeak } from './memory-peak-validation.js';
import { canonical } from './validation.js';

/** Bind budget evidence back to actual physical allocations and execution, independently of core. */
export function validateModulePeakLayout(result:ParallelResolution):Diagnostic[]{
  const issues:Diagnostic[]=[],report=(message:string)=>issues.push({diagnosticId:'module-peak-layout-'+issues.length,severity:'error',code:'invalid_module_peak_result',message,location:{kind:'scenario',scenarioId:result.scenarioId,fieldPath:'memory.moduleOverrides'}});
  for(const [rows,attempt] of [[result.memory,result.execution],[result.serialBaseline?.memory??[],result.serialBaseline?.execution]] as const){
    const execution=attempt?.status==='available'?attempt.result:undefined;
    for(const row of rows){const m=preTotalPeak(row),e=m.moduleOverrides;if(!e)continue;if(row.sequenceTheoretical)report('布局单步不能携带序列理论峰值');
      if(!execution||execution.completeness!=='complete')report('模块预算必须有完整实际执行范围');
      if(e.axis!==(execution?.policy==='streams'?'second':'order'))report('模块预算扫描坐标与执行策略不同');
      const deviceId=m.deviceScope.kind==='per_device'?m.deviceScope.deviceId:undefined,physical=result.storageAllocations.flatMap(s=>{const d=s.allocation.perDevice.find(d=>d.deviceId===deviceId);return d?[{storageId:s.storageId,category:s.category,bytes:d.totalBytes}]:[];});
      if(canonical(e.allocations.map(({intervals,...a})=>{void intervals;return a;}))!==canonical(physical))report('模块证据必须保留当前设备全部规范分配及原字节');
      const order=execution?.memoryOrder??execution?.steps.map(s=>({nodeId:s.nodeId,executionNodeId:s.nodeId}))??[];
      if(canonical(e.uses.map(u=>({nodeId:u.nodeId,executionNodeId:u.executionNodeId})))!==canonical(order.map(u=>({nodeId:u.nodeId,executionNodeId:u.executionNodeId}))))report('模块使用必须来自完整实际生命周期事件');
      for(const a of e.applications){
        const owned=new Set([...a.memberNodeIds,...a.extraNodeIds]),internal=result.fusions.filter(f=>f.application.memberNodeIds.every(id=>a.memberNodeIds.includes(id)));if(canonical(a.extraNodeIds)!==canonical(internal.map(f=>f.application.extraNodeId)))report('模块附加事件须来自完整内部融合');
        for(const f of result.fusions)if(f.application.memberNodeIds.some(id=>a.memberNodeIds.includes(id))&&!f.application.memberNodeIds.every(id=>a.memberNodeIds.includes(id)))report('模块预算不能与跨模块融合混用');
        const ids=[...new Set(e.uses.filter(u=>owned.has(u.nodeId)&&execution?.steps.some(s=>s.nodeId===u.executionNodeId&&deviceId!==undefined&&s.deviceIds.includes(deviceId))&&(a.extraNodeIds.includes(u.nodeId)?internal.some(f=>f.application.extraNodeId===u.nodeId&&f.perDevice.some(d=>d.deviceId===deviceId)):result.localCosts.nodes.find(n=>n.nodeId===u.nodeId)?.placement.kind==='placed'?result.localCosts.nodes.some(n=>n.nodeId===u.nodeId&&n.placement.kind==='placed'&&n.placement.perDevice.some(d=>d.deviceId===deviceId)):result.communications.some(c=>c.origin?.nodeId===u.nodeId))).map(u=>u.executionNodeId))];if(canonical(ids)!==canonical(a.executionNodeIds))report('模块实际设备参与与执行节点不符');
        if(e.axis==='second'){const steps=ids.map(id=>execution?.steps.find(s=>s.nodeId===id));if(a.start!==Math.min(...steps.map(s=>s?.startSeconds??NaN))||a.end!==Math.max(...steps.map(s=>s?.endSeconds??NaN)))report('模块时间预算必须跨越真实调用起止');}
      }
      if(e.axis==='second'){
        const temporal=result.temporalMemory;if(!temporal)report('时间模块预算缺少物理生命周期证据');else {
          for(const key of ['initialStorageIds','outputStorageIds','carriedStorageIds'] as const)if(canonical(e[key])!==canonical(temporal[key]))report('模块预算边界与时间生命周期不同');
          const expected=temporal.lifetimes.filter(l=>l.deviceId===deviceId).map(l=>({storageId:l.storageId,category:l.category,intervals:l.intervals.map(i=>({start:i.startSeconds,end:i.endSeconds}))}));if(canonical(e.allocations.map(({bytes,...a})=>{void bytes;return a;}))!==canonical(expected))report('模块预算不能伪造保留对象生命周期');
          if(canonical(e.uses)!==canonical(temporal.uses.filter(u=>u.deviceId===deviceId).map(({deviceId,...u})=>{void deviceId;return u;})))report('模块预算使用与物理时间证据不同');
        }
      }else for(const a of e.allocations){
        const indices=e.uses.flatMap((u,i)=>[...u.reads,...u.writes,...u.temporary].includes(a.storageId)?[i]:[]),initial=e.initialStorageIds.includes(a.storageId),output=e.outputStorageIds.includes(a.storageId),last=Math.max(0,e.uses.length-1),persistent=['weight','state','graph','runtime','reserve'].includes(a.category),scratch=['workspace','communication'].includes(a.category);let intervals:{start:number;end:number}[]=[];
        if(persistent||scratch&&!indices.length)intervals=[{start:0,end:last}];else if(indices.length||initial||output){const touched=[...indices,...(initial?[0]:[]),...(output?[last]:[])];intervals=scratch&&!initial&&!output&&!e.carriedStorageIds.includes(a.storageId)?indices.map(i=>({start:i,end:i})):[{start:Math.min(...touched),end:Math.max(...touched)}];}
        if(canonical(a.intervals)!==canonical(intervals))report('串行模块预算必须保留规范对象完整生命周期');
      }
      if(m.peakPoint.kind==='order'&&e.axis==='order'&&m.peakPoint.index!==e.peakCoordinate||m.peakPoint.kind==='time'&&e.axis==='second'&&m.peakPoint.seconds!==e.peakCoordinate)report('模块预算峰值坐标与扫描不符');
      // Single-step evidence cannot smuggle in an unexplained persistent state delta.
      const state=e.allocations.filter(a=>a.category==='state').reduce((n,a)=>n+(a.bytes.status==='available'?a.bytes.quantity.value:0),0),rawState=e.theoretical.categoryBreakdown.find(c=>c.category==='state')?.bytes;
      if(rawState?.status==='available'&&rawState.quantity.value!==state)report('单步模块理论常驻状态须等于实际分配');
    }
  }return issues;
}
