import type { CommunicationDefinition,GraphTemplate } from './index.js';

/** Intrinsic collective interface; names are stable across modules and repeats. */
export function collectivePorts(communication:CommunicationDefinition):Pick<GraphTemplate,'inputs'|'outputs'>{
  return {inputs:[{portId:'source',tensorId:communication.source.tensorId}],outputs:[{portId:'destination',tensorId:communication.destination.tensorId}]};
}
