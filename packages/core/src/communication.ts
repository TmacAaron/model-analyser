import { CommunicationDefinition,CommunicationAttempt,MetricScope,TensorSpec,DeviceTopology,type Diagnostic } from '@model-analyser/contracts';
import { numericValue,type EvaluationContext } from './storage.js';
import { FormulaError } from './formula.js';
import { partitionTensor } from './partition.js';
import { MetricFactory } from './metrics.js';
import { canReadTensorLocally } from './layout-compatibility.js';
import { canonical,collectRefs } from '../../contracts/src/validation.js';
import type {CommunicationEndpointObserver,CommunicationEndpointSide,CommunicationTimingArithmetic} from './communication-observation.js';
import type {PartitionPageObserver} from './layout-observation.js';

/** Network traffic is explicit; collective names never introduce a second coefficient. */
export function evaluateCommunication(input:CommunicationDefinition,inputScope:MetricScope,tensors:TensorSpec[],inputTopology:DeviceTopology,context:EvaluationContext,observeTiming?:(step:CommunicationTimingArithmetic)=>void,observeEndpoints?:CommunicationEndpointObserver):CommunicationAttempt{
  const diagnostics:Diagnostic[]=[];
  try{
    const c=CommunicationDefinition.parse(input),scope=MetricScope.parse(inputScope),topology=DeviceTopology.parse(inputTopology),group=topology.groups.find(g=>g.groupId===c.groupId);
    if(!group)throw new FormulaError('missing_reference','通信设备组不存在');
    const sendRecv=c.operation==='send_recv',sender=c.sourceDeviceId,receiver=c.destinationDeviceId;
    if(sendRecv){if(!sender||!receiver||sender===receiver||!group.members.includes(sender)||!group.members.includes(receiver))throw new FormulaError('invalid_distribution','send_recv 必须指定组内两个不同设备');}
    else if(sender!==undefined||receiver!==undefined)throw new FormulaError('invalid_distribution','集体通信不能带 send_recv 端点字段');
    const members=sendRecv?group.members.filter(id=>id===sender||id===receiver):group.members;
    if(c.perDevicePayloads&&(sendRecv||c.perDevicePayloads.length!==members.length||new Set(c.perDevicePayloads.map(p=>p.deviceId)).size!==members.length||c.perDevicePayloads.some(p=>!members.includes(p.deviceId))))throw new FormulaError('invalid_member_payloads','逐设备通信声明必须唯一完整地覆盖集体通信的全部物理成员；send_recv沿显式端点路径');
    if(scope.aggregation!=='group_total'||new Set(scope.deviceIds).size!==scope.deviceIds.length||canonical([...scope.deviceIds].sort())!==canonical([...members].sort()))throw new FormulaError('invalid_scope','通信求值需要所有参与物理设备的 group_total 范围；耗时为整个通信的跨度');
    const source=tensors.find(t=>t.tensorId===c.source.tensorId),destination=tensors.find(t=>t.tensorId===c.destination.tensorId);
    if(!source||!destination)throw new FormulaError('missing_reference','通信的源/目标张量不存在');
    if(tensors.filter(t=>t.tensorId===source.tensorId).length!==1||tensors.filter(t=>t.tensorId===destination.tensorId).length!==1)throw new FormulaError('duplicate_id','通信张量 ID 不唯一');
    for(const [index,endpoint] of [c.source,c.destination].entries()){
      const layoutGroup=topology.groups.find(g=>g.groupId===endpoint.distribution.groupId);
      const endpointDevice=index===0?sender:receiver;
      const valid=layoutGroup&&(sendRecv?endpointDevice&&layoutGroup.members.includes(endpointDevice)&&layoutGroup.members.every(id=>group.members.includes(id)):
        canonical([...layoutGroup.members].sort())===canonical([...group.members].sort()));
      if(!valid)throw new FormulaError('invalid_distribution','通信端点必须覆盖对应发送/接收设备，集体通信须覆盖同组成员');
    }
    const pageDevices=observeEndpoints?(c.perDevicePayloads?.map(payload=>payload.deviceId)??members).slice(observeEndpoints.start,observeEndpoints.start+observeEndpoints.limit):undefined;
    function partitionObserver(side:CommunicationEndpointSide):PartitionPageObserver|undefined{
      if(!observeEndpoints||!pageDevices)return;
      const deviceIds=new Set(sendRecv?pageDevices.filter(id=>id===(side==='source'?sender:receiver)):pageDevices);
      return {deviceIds,record:(operation,deviceId)=>observeEndpoints.record(side,operation,deviceId)};
    }
    const from=partitionTensor(source,c.source.distribution,topology,context,partitionObserver('source'));
    const to=partitionTensor(destination,c.destination.distribution,topology,context,partitionObserver('destination'));
    if(from.status==='unavailable'||to.status==='unavailable')return CommunicationAttempt.parse({status:'unavailable',diagnostics:[...(from.status==='unavailable'?from.diagnostics.map(d=>({...d,diagnosticId:'source-'+d.diagnosticId})):[]),...(to.status==='unavailable'?to.diagnostics.map(d=>({...d,diagnosticId:'destination-'+d.diagnosticId})):[])]});
    const dims=(s:typeof from.result.globalShape)=>s.map(a=>({axisId:a.axisId,size:a.size}));
    if(canonical(dims(from.result.globalShape))!==canonical(dims(to.result.globalShape)))throw new FormulaError('invalid_shape','通信前后逻辑张量维度必须一致；布局变换不隐式执行 reshape');
    const sk=c.source.distribution.kind,dk=c.destination.distribution.kind;
    if(sendRecv){const sourceView={...from.result,placements:from.result.placements.filter(p=>p.deviceId===sender).map(p=>({...p,deviceId:receiver??p.deviceId}))},targetView={...to.result,placements:to.result.placements.filter(p=>p.deviceId===receiver)};if(!canReadTensorLocally(sourceView,targetView))throw new FormulaError('invalid_distribution','send_recv 不能隐式归约 partial 或发送源设备不具备的目标切片');}
    const partition=c.source.distribution.kind==='partial'?c.source.distribution.partition:undefined;
    if(partition){
      const target=c.destination.distribution;
      const slices=(result:typeof from.result)=>result.placements.map(({deviceId,slices})=>[deviceId,slices]).sort(([a],[b])=>String(a).localeCompare(String(b)));
      if(c.operation!=='all_reduce'||target.kind!=='sharded'||target.policy.kind!=='even'||target.axes.length!==1||
        target.axes[0]?.tensorAxisId!==partition.tensorAxisId||canonical(slices(from.result))!==canonical(slices(to.result))){
        throw new FormulaError('invalid_distribution','分组 AllReduce 必须保留各设备的同一请求切片');
      }
    }else if(c.operation==='all_reduce'&&(sk!=='partial'||dk!=='replicated'))throw new FormulaError('invalid_distribution','all_reduce 需要 partial → replicated 布局');
    if(c.operation==='reduce_scatter'&&(sk!=='partial'||dk!=='sharded'))throw new FormulaError('invalid_distribution','reduce_scatter 需要 partial → sharded 布局');
    if(c.operation==='all_gather'&&(sk!=='sharded'||dk!=='replicated'))throw new FormulaError('invalid_distribution','all_gather 需要 sharded → replicated 布局');
    if(c.operation==='all_to_all'&&(!['sharded','manual'].includes(sk)||!['sharded','manual'].includes(dk)))throw new FormulaError('invalid_distribution','all_to_all 需要显式分片或手工局部布局');
    const provenance=context.provenance??{assetRefs:context.assets.map(a=>({assetId:a.assetId,revision:a.revision,kind:a.definition.kind})),formulaRefs:collectRefs(c),parameterSources:Object.keys(context.symbols).map(parameterKey=>({parameterKey,source:'evaluation_context'})),assumptions:[
      'Send and receive payload are explicitly declared per member; algorithmTraffic = send payload × trafficFactor, applied exactly once.',
      'Bandwidth/latency time uses per-sender algorithm traffic and startupRounds; the group total time is a collective span, not a sum over devices.',
      'This evaluator models network transfer only. Local HBM reads/writes, staging allocation, reduction arithmetic and quantization conversion work require separate declarations.',
    ]};
    const metrics=new MetricFactory(diagnostics,provenance,'communication','communication-'+c.groupId+'-'+(scope.target.kind==='model'?'model':scope.target.nodeId)),send=numericValue(c.sendBytesPerMember,'byte',context),receive=numericValue(c.receiveBytesPerMember,'byte',context),traffic=c.perDevicePayloads?0:send*c.algorithm.trafficFactor;
    const trafficUnderflow=!c.perDevicePayloads&&send>0&&c.algorithm.trafficFactor>0&&traffic===0;
    const sendMetric=metrics.available(send,'byte'),receiveMetric=metrics.available(receive,'byte'),trafficMetric=trafficUnderflow?metrics.unavailable('numeric_overflow','非零算法流量下溢，不能报告为零'):metrics.available(traffic,'byte');
    const sendCount=sendRecv?1:members.length,receiveCount=sendCount;
    const declared=c.perDevicePayloads?.map(p=>{const sent=numericValue(p.sendBytes,'byte',context),received=numericValue(p.receiveBytes,'byte',context),remote=sent*p.trafficFactor;return {deviceId:p.deviceId,sendBytes:metrics.available(sent,'byte'),receiveBytes:metrics.available(received,'byte'),algorithmTrafficBytes:sent>0&&p.trafficFactor>0&&remote===0?metrics.unavailable('numeric_overflow','非零逐设备算法流量下溢'):metrics.available(remote,'byte')};});
    function common(values:typeof sendMetric[]){const unknown=values.filter(v=>v.status==='unavailable');if(unknown.length)return {status:'unavailable' as const,diagnosticIds:[...new Set(unknown.flatMap(v=>v.diagnosticIds))]};const first=values[0];return first?.status==='available'&&values.every(v=>v.status==='available'&&v.quantity.value===first.quantity.value)?first:metrics.unavailable('nonuniform_member_quantity','各rank数值不同，没有统一的每成员单值；完整数值见逐设备明细与组总量');}
    const communication=declared?{groupId:c.groupId,operation:c.operation,sendBytesPerMember:common(declared.map(p=>p.sendBytes)),receiveBytesPerMember:common(declared.map(p=>p.receiveBytes)),algorithmTrafficBytesPerMember:common(declared.map(p=>p.algorithmTrafficBytes)),groupSendBytes:metrics.sum(declared.map(p=>p.sendBytes),'byte'),groupReceiveBytes:metrics.sum(declared.map(p=>p.receiveBytes),'byte')}:{groupId:c.groupId,operation:c.operation,sendBytesPerMember:sendMetric,receiveBytesPerMember:receiveMetric,algorithmTrafficBytesPerMember:trafficMetric,groupSendBytes:metrics.available(send*sendCount,'byte'),groupReceiveBytes:metrics.available(receive*receiveCount,'byte')};
    let seconds;
    try{
      if(c.timing.kind==='fixed'||c.timing.kind==='custom_formula'){
        const value=c.timing.kind==='fixed'?c.timing.seconds:numericValue(c.timing.seconds,'second',context);
        seconds=metrics.available(value,'second');
        observeTiming?.({kind:c.timing.kind,seconds:value});
      }
      else {
        const maxTraffic=declared?declared.every(p=>p.algorithmTrafficBytes.status==='available')?Math.max(...declared.flatMap(p=>p.algorithmTrafficBytes.status==='available'?[p.algorithmTrafficBytes.quantity.value]:[])):NaN:traffic;
        if(!Number.isFinite(maxTraffic)||!declared&&trafficUnderflow)throw new FormulaError('numeric_overflow','通信算法流量溢出或下溢，无法计算传输时间');
        const transfer=maxTraffic/c.timing.bytePerSecond,startup=c.algorithm.startupRounds*c.timing.latencySeconds;
        if(maxTraffic>0&&transfer===0)throw new FormulaError('numeric_overflow','非零通信传输耗时下溢，不能报告为零');
        const value=transfer+startup;
        seconds=metrics.available(value,'second');
        if(seconds.status==='available')observeTiming?.({kind:'bandwidth_latency',maxTraffic,bytePerSecond:c.timing.bytePerSecond,rounds:c.algorithm.startupRounds,latencySeconds:c.timing.latencySeconds,transfer,startup,seconds:value});
      }
    }catch(e){seconds=metrics.unavailable(e instanceof FormulaError?e.code:'invalid_communication_time',e instanceof Error?e.message:'通信时间不可用');}
    const unmodeled=metrics.unavailable('missing_communication_memory','通信 payload 不确定本地读写/HBM 成本；请分别声明搬运和 staging 空间');
    const cost={scope,compute:[],logicalReadBytes:unmodeled,logicalWriteBytes:unmodeled,hbmBytes:unmodeled,communications:[communication],seconds};
    const perDevice=declared??members.map(deviceId=>({deviceId,sendBytes:sendRecv&&deviceId!==sender?metrics.available(0,'byte'):sendMetric,receiveBytes:sendRecv&&deviceId!==receiver?metrics.available(0,'byte'):receiveMetric,algorithmTrafficBytes:sendRecv&&deviceId!==sender?metrics.available(0,'byte'):trafficMetric}));
    return CommunicationAttempt.parse({status:'available',result:{definition:c,cost,source:from.result,destination:to.result,perDevice,diagnostics}});
  }catch(e){diagnostics.push({diagnosticId:'communication-failure',severity:'error',code:e instanceof FormulaError?e.code:'invalid_communication',message:e instanceof Error?e.message:'通信求值失败',location:{kind:'file',name:'communication'}});return CommunicationAttempt.parse({status:'unavailable',diagnostics});}
}
