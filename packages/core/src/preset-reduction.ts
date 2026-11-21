import { NodeId, type CommunicationDefinition, type ParallelPresetRequest, type ParallelPresetTemplate,
  type TensorDistribution } from '@model-analyser/contracts';
import { payloadPerReplica } from './request-replica.js';

export function ringPresetReduction(rule: ParallelPresetTemplate['reductions'][number], target: TensorDistribution, phases: ParallelPresetTemplate['phases'],
  width: number, network: NonNullable<ParallelPresetRequest['network']>, request?: { degree: number; axisId: string }): CommunicationDefinition {
  const groupId=target.groupId;
  const partition=request&&target.kind==='sharded'&&target.axes.length===1&&target.axes[0]?.meshAxisId===request.axisId?target.axes[0]:undefined;
  if(request&&!partition||!request&&target.kind!=='replicated')throw Error('归约输出须保留同一请求切片：'+rule.tensorId);
  const payload=request?payloadPerReplica(rule.payloadBytes,request.degree):rule.payloadBytes;
  return {operation:'all_reduce',groupId,source:{tensorId:rule.tensorId,distribution:{kind:'partial',groupId,
    reduceOperation:rule.operation??'sum',...(partition?{partition}:{})}},destination:{tensorId:rule.tensorId,distribution:target},
    payloadDtype:rule.payloadDtype,sendBytesPerMember:payload,receiveBytesPerMember:payload,
    algorithm:{name:partition?'Concurrent replica ring AllReduce: per-replica payload × 2(P-1)/P':'Declared ring AllReduce: full-message payload × 2(P-1)/P',
      trafficFactor:2*(width-1)/width,startupRounds:2*(width-1)},
    timing:{kind:'bandwidth_latency',bytePerSecond:network.bytesPerSecond,latencySeconds:network.latencySeconds},
    placement:{nodeId:NodeId.parse('$reduce:'+rule.producerNodeId+':'+rule.tensorId),phases,afterNodeIds:[rule.producerNodeId],beforeNodeIds:rule.consumerNodeIds},
    temporaryStorageIds:[]};
}
