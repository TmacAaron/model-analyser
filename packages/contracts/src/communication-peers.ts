import type { CommunicationDefinition, DeviceId } from './index.js';

export function sendRecvPairs(c: CommunicationDefinition) {
  if (c.operation !== 'send_recv') return [];
  if (c.peerPairs) return c.peerPairs;
  return c.sourceDeviceId && c.destinationDeviceId
    ? [{ sourceDeviceId: c.sourceDeviceId, destinationDeviceId: c.destinationDeviceId }]
    : [];
}

export function sendRecvIssue(c: CommunicationDefinition, members?: DeviceId[]) {
  const hasSingle = c.sourceDeviceId !== undefined || c.destinationDeviceId !== undefined;
  if (c.operation !== 'send_recv') return hasSingle || c.peerPairs ? '只有 send_recv 使用点对点设备端点' : undefined;
  const pairs = sendRecvPairs(c);
  const endpoints = pairs.flatMap(pair => [pair.sourceDeviceId, pair.destinationDeviceId]);
  if (!pairs.length || c.peerPairs && hasSingle || new Set(endpoints).size !== endpoints.length ||
      members && endpoints.some(deviceId => !members.includes(deviceId))) {
    return 'send_recv 需要组内不同的发送和接收设备，每台设备只参与一个配对';
  }
}

export function participatesOnCommunicationSide(c: CommunicationDefinition, side: 'source' | 'destination', deviceId: DeviceId) {
  return c.operation !== 'send_recv' || sendRecvPairs(c).some(pair =>
    deviceId === (side === 'source' ? pair.sourceDeviceId : pair.destinationDeviceId));
}
