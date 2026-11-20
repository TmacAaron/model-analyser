import { NodeId, StateId, StorageId, type Shape } from '@model-analyser/contracts';
import { GraphAuthor, fp32, vector } from './model-authoring.js';

export type Axis = [string, Shape[number]['semantic'], string];
export const sequence = (id: string, size: string): Axis[] => [['b', 'batch', 'B'], ['q', 'token', 'Q'], [id, 'hidden', size]];
export const hidden = sequence('h', 'H');
const heads = (headCount: string, width: string): Axis[] => [
  ['b', 'batch', 'B'], ['q', 'token', 'Q'], ['head', 'head', headCount], ['d', 'hidden', width],
];
export function matrixWeight(graph: GraphAuthor, id: string, rows: string, columns = 'H') {
  graph.tensor(id, [['out', 'hidden', rows], ['in', 'hidden', columns]], { category: 'weight' });
}
export function normWeight(graph: GraphAuthor, id: string, width: string) {
  graph.tensor(id, [['d', 'hidden', width]], { category: 'weight' });
}

function statePort(node: string, portId: string) {
  return { kind: 'node' as const, nodeId: NodeId.parse(node), portId };
}

export function addGatedAttention(graph: GraphAuthor) {
  const length = 'if(C + Q <= M, C + Q, 1 / 0)';
  const causal = '(C * Q + Q * (Q + 1) / 2)';
  matrixWeight(graph, 'q-weight', '2 * NH * D');
  matrixWeight(graph, 'k-weight', 'NK * D');
  matrixWeight(graph, 'v-weight', 'NK * D');
  for (const id of ['q-proj', 'attn-gate']) graph.tensor(id, heads('NH', 'D'));
  for (const id of ['k-proj', 'v-new']) graph.tensor(id, heads('NK', 'D'));
  graph.node('qkv', 'Q/K/V and attention-gate projections', ['normed', 'q-weight', 'k-weight', 'v-weight'],
    ['q-proj', 'attn-gate', 'k-proj', 'v-new'], { useful: '4 * B * Q * H * D * (NH + NK)' });
  normWeight(graph, 'q-norm-weight', 'D');
  normWeight(graph, 'k-norm-weight', 'D');
  graph.tensor('query', heads('NH', 'D'));
  graph.tensor('key-new', heads('NK', 'D'));
  graph.node('qk-norm-rope', 'Per-head RMSNorm and partial RoPE', ['q-proj', 'k-proj', 'q-norm-weight', 'k-norm-weight'],
    ['query', 'key-new'], { useful: 'B * Q * (NH + NK) * (5 * D + 3 * R)', computeClass: vector });
  const cache = ['cache-k', 'cache-v'];
  for (const id of cache) graph.tensor(id, [
    ['b', 'batch', 'B'], ['s', 'token', length], ['head', 'head', 'NK'], ['d', 'hidden', 'D'],
  ], { category: 'state' });
  const appendBytes = '2 * B * Q * NK * D';
  graph.node('cache-update', 'Append current K/V', ['key-new', 'v-new'], cache, undefined, {
    accessBytes: { 'cache-k': appendBytes, 'cache-v': appendBytes },
  });
  graph.graph.states.push({
    stateId: StateId.parse('kv'), name: 'GQA key/value cache', stateKind: 'kv', allocationBasis: 'step_end',
    storageIds: cache.map(id => StorageId.parse(id)), creator: { kind: 'initialized' },
    readers: [statePort('qk', 'cache-k'), statePort('av', 'cache-v')],
    writers: cache.map(id => statePort('cache-update', id)), updatePolicy: { kind: 'append' },
  });
  const scores: Axis[] = [['b', 'batch', 'B'], ['head', 'head', 'NH'], ['q', 'token', 'Q'], ['s', 'token', length]];
  graph.tensor('scores', scores);
  graph.node('qk', 'Grouped causal QKᵀ', ['query', 'cache-k'], ['scores'], {
    useful: '2 * B * NH * ' + causal + ' * D', executed: '2 * B * NH * Q * (C + Q) * D',
  });
  graph.tensor('probabilities', scores);
  graph.tensor('softmax-work', scores, { category: 'workspace', dtype: fp32 });
  graph.node('softmax', 'Scale and causal softmax', ['scores'], ['probabilities'], {
    useful: '6 * B * NH * ' + causal, executed: '6 * B * NH * Q * (C + Q)', computeClass: vector,
  }, { temporaries: ['softmax-work'] });
  graph.tensor('attended', heads('NH', 'D'));
  graph.node('av', 'Attention-weighted values', ['probabilities', 'cache-v'], ['attended'], {
    useful: '2 * B * NH * ' + causal + ' * D', executed: '2 * B * NH * Q * (C + Q) * D',
  });
  graph.tensor('gated-attention', heads('NH', 'D'));
  graph.node('output-gate', 'Sigmoid attention output gate', ['attended', 'attn-gate'], ['gated-attention'],
    { useful: '5 * B * Q * NH * D', computeClass: vector });
  matrixWeight(graph, 'o-weight', 'H', 'NH * D');
  graph.tensor('attention-output', hidden);
  graph.node('o-proj', 'Attention output projection', ['gated-attention', 'o-weight'], ['attention-output'], {
    useful: '2 * B * Q * NH * D * H',
  });
}

export function addDeltaAttention(graph: GraphAuthor, splitChannels = false) {
  const keyWidth = 'LK * DK', valueWidth = 'LV * DV', channels = '(2 * LK * DK + LV * DV)';
  // The checkpoint groups all Q rows before K and V. Model them as three
  // independent head partitions so a rank owns the matching convolution channels.
  const components = splitChannels ? [
    { id: 'q', heads: 'LK', width: 'DK' }, { id: 'k', heads: 'LK', width: 'DK' }, { id: 'v', heads: 'LV', width: 'DV' },
  ] : [{ id: '', heads: channels, width: '1' }];
  const part = (component: (typeof components)[number]) => component.id ? '-' + component.id : '';
  const mixed = (component: (typeof components)[number]) => 'delta-mixed' + part(component);
  const qkvWeight = (component: (typeof components)[number]) => 'delta-qkv-weight' + part(component);
  for (const component of components) {
    if (splitChannels) {
      graph.tensor(qkvWeight(component), [['head', 'head', component.heads], ['d', 'hidden', component.width], ['in', 'hidden', 'H']], { category: 'weight' });
      graph.tensor(mixed(component), heads(component.heads, component.width));
    } else {
      matrixWeight(graph, qkvWeight(component), channels);
      graph.tensor(mixed(component), sequence('channels', channels));
    }
  }
  graph.node('delta-qkv', 'Linear Q/K/V projection', ['normed', ...components.map(qkvWeight)], components.map(mixed), {
    useful: '2 * B * Q * H * ' + channels,
  });
  for (const [id, resultName] of [['delta-output-gate', 'linear-z'], ['beta', 'beta-logits'], ['decay', 'decay-logits']] as const) {
    const width = id === 'delta-output-gate' ? valueWidth : 'LV';
    matrixWeight(graph, id + '-weight', width);
    graph.tensor(resultName, id === 'delta-output-gate' ? heads('LV', 'DV') : sequence('head', 'LV'));
    graph.node(id + '-proj', id === 'delta-output-gate' ? 'SiLU output-gate projection' :
      id === 'beta' ? 'Delta weight β projection' : 'Decay projection', ['normed', id + '-weight'], [resultName],
    { useful: '2 * B * Q * H * ' + width });
  }

  const convState = (component: (typeof components)[number]) => 'conv-state' + part(component);
  const convNext = (component: (typeof components)[number]) => 'conv-next' + part(component);
  const convWeight = (component: (typeof components)[number]) => 'conv-weight' + part(component);
  const convRead: Record<string, string> = {};
  for (const component of components) {
    const weightShape: Axis[] = splitChannels ? [['head', 'head', component.heads], ['d', 'hidden', component.width]]
      : [['channels', 'hidden', channels]];
    weightShape.push(['window', 'custom', 'W']);
    const convShape: Axis[] = [['b', 'batch', 'B'], ...weightShape];
    graph.tensor(convState(component), convShape, { category: 'state' });
    graph.tensor(convNext(component), convShape, { category: 'state', storageId: convState(component) });
    graph.tensor(convWeight(component), weightShape, { category: 'weight' });
    const count = splitChannels ? component.heads + ' * ' + component.width : channels;
    convRead[convState(component)] = 'if(C > 0, 2 * B * ' + count + ' * W, 0)';
  }
  for (const id of ['linear-query', 'linear-key']) graph.tensor(id, heads('LK', 'DK'));
  graph.tensor('linear-value', heads('LV', 'DV'));
  graph.node('convolve', 'Depthwise causal convolution, SiLU and Q/K/V split',
    [...components.map(mixed), ...components.map(convWeight), ...components.map(convState)],
    ['linear-query', 'linear-key', 'linear-value', ...components.map(convNext)],
    { useful: 'B * Q * ' + channels + ' * (2 * W + 5)', computeClass: vector }, {
      accessBytes: convRead,
    });
  graph.graph.states.push({
    stateId: StateId.parse('conv-history'), name: 'DeltaNet convolution history', stateKind: 'recurrent',
    storageIds: components.map(component => StorageId.parse(convState(component))), creator: { kind: 'initialized' }, allocationBasis: 'step_end',
    readers: components.map(component => statePort('convolve', convState(component))),
    writers: components.map(component => statePort('convolve', convNext(component))), updatePolicy: { kind: 'replace' },
  });
  for (const id of ['query-l2', 'key-l2']) graph.tensor(id, heads('LK', 'DK'), { dtype: fp32 });
  graph.node('qk-l2-norm', 'Q/K L2 normalize and scale query', ['linear-query', 'linear-key'], ['query-l2', 'key-l2'],
    { useful: 'B * Q * LK * (7 * DK + 2)', computeClass: vector });
  graph.tensor('beta', sequence('head', 'LV'), { dtype: fp32 });
  graph.node('beta', 'Sigmoid delta weight β', ['beta-logits'], ['beta'], { useful: '4 * B * Q * LV', computeClass: vector });
  for (const id of ['decay-log', 'decay-bias']) normWeight(graph, id, 'LV');
  graph.tensor('decay', sequence('head', 'LV'), { dtype: fp32 });
  graph.node('decay', 'Softplus time step and exponential decay', ['decay-logits', 'decay-log', 'decay-bias'], ['decay'],
    { useful: 'LV + 7 * B * Q * LV', computeClass: vector });

  const matrixShape: Axis[] = [['b', 'batch', 'B'], ['head', 'head', 'LV'], ['k', 'hidden', 'DK'], ['v', 'hidden', 'DV']];
  graph.tensor('delta-state', matrixShape, { category: 'state', dtype: fp32 });
  graph.tensor('delta-next', matrixShape, { category: 'state', dtype: fp32, storageId: 'delta-state' });
  graph.tensor('state-work', matrixShape, { category: 'workspace', dtype: fp32 });
  graph.tensor('delta-output', heads('LV', 'DV'));
  graph.node('recurrent', 'Gated decay, delta update and query readout', ['query-l2', 'key-l2', 'linear-value', 'beta', 'decay', 'delta-state'],
    ['delta-output', 'delta-next'], { useful: 'B * Q * LV * (7 * DK * DV + 2 * DV)', computeClass: vector }, {
      accessBytes: { 'delta-state': 'if(C > 0, 4 * B * LV * DK * DV, 0)' }, temporaries: ['state-work'],
    });
  graph.graph.states.push({
    stateId: StateId.parse('delta-matrix'), name: 'DeltaNet recurrent matrix', stateKind: 'recurrent',
    storageIds: [StorageId.parse('delta-state')], creator: { kind: 'initialized' }, allocationBasis: 'step_end',
    readers: [statePort('recurrent', 'delta-state')], writers: [statePort('recurrent', 'delta-next')], updatePolicy: { kind: 'replace' },
  });
  normWeight(graph, 'value-norm-weight', 'DV');
  graph.tensor('gated-values', heads('LV', 'DV'));
  graph.node('value-norm-gate', 'RMSNorm and SiLU value gate', ['delta-output', 'linear-z', 'value-norm-weight'], ['gated-values'],
    { useful: '11 * B * Q * LV * DV', computeClass: vector });
  matrixWeight(graph, 'delta-o-weight', 'H', valueWidth);
  graph.tensor('attention-output', hidden);
  graph.node('delta-o-proj', 'DeltaNet output projection', ['gated-values', 'delta-o-weight'], ['attention-output'],
    { useful: '2 * B * Q * H * ' + valueWidth });
}
