import { GraphAuthor, fp32 } from './model-authoring.js';
import { heads, int32, sequence, vectorWork, weight } from './deepseek-v4-attention.js';

const hidden = sequence('H');

function addSituMlp(graph: GraphAuthor, prefix: string, width: string, output: string) {
  const id = (suffix: string) => prefix + '-' + suffix;
  weight(graph, id('gate-weight'), ['H', width]); weight(graph, id('up-weight'), ['H', width]);
  weight(graph, id('down-weight'), [width, 'H']);
  graph.tensor(id('gate-up-output'), sequence('2 * (' + width + ')'));
  graph.tensor(id('activation'), sequence(width)); graph.tensor(output, hidden);
  graph.node(id('gate-up'), 'SiTU-GLU gate and up projections', ['ffn-input', id('gate-weight'), id('up-weight')],
    [id('gate-up-output')], { useful: '4 * B * Q * H * (' + width + ')' });
  graph.node(id('situ'), 'Bounded SiTU gate and bounded up product', [id('gate-up-output')], [id('activation')],
    vectorWork('15 * B * Q * (' + width + ')'));
  graph.node(id('down'), 'SiTU-GLU down projection', [id('activation'), id('down-weight')], [output],
    { useful: '2 * B * Q * H * (' + width + ')' });
}

export function addKimiFfn(graph: GraphAuthor, dense: boolean) {
  if (dense) {
    addSituMlp(graph, 'dense', 'I', 'ffn-output');
    return;
  }
  weight(graph, 'router-weight', ['H', 'E']); weight(graph, 'router-bias', ['E'], fp32);
  for (const id of ['router-logits', 'router-affinities', 'router-corrected']) graph.tensor(id, sequence('E'), { dtype: fp32 });
  graph.tensor('expert-ids', sequence('K'), { dtype: int32 }); graph.tensor('expert-weights', sequence('K'), { dtype: fp32 });
  graph.node('router', 'Full hidden-width routing projection', ['ffn-input', 'router-weight'], ['router-logits'],
    vectorWork('2 * B * Q * H * E'));
  graph.node('route-affinities', 'Sigmoid expert affinities', ['router-logits'], ['router-affinities'], vectorWork('4 * B * Q * E'));
  graph.node('route-bias', 'Add expert selection bias', ['router-affinities', 'router-bias'], ['router-corrected'], vectorWork('B * Q * E'));
  graph.node('route-topk', 'Select the routed experts', ['router-corrected'], ['expert-ids'], vectorWork('3 * B * Q * E'));
  graph.node('route-normalize', 'Normalize selected original affinities', ['router-affinities', 'expert-ids'], ['expert-weights'],
    vectorWork('2 * B * Q * K'), { accessBytes: { 'router-affinities': '4 * B * Q * K' } });

  weight(graph, 'latent-down-weight', ['H', 'M']); graph.tensor('expert-latent', sequence('M'));
  graph.node('latent-down', 'Project tokens to the routed expert latent width', ['ffn-input', 'latent-down-weight'], ['expert-latent'],
    { useful: '2 * B * Q * H * M' });
  graph.tensor('expert-input', heads('K', 'M'));
  graph.node('dispatch', 'Dispatch latent tokens to selected experts', ['expert-latent', 'expert-ids'], ['expert-input']);
  weight(graph, 'expert-gate-weight', ['E', 'M', 'J']); weight(graph, 'expert-up-weight', ['E', 'M', 'J']);
  weight(graph, 'expert-down-weight', ['E', 'J', 'M']);
  graph.tensor('expert-gate-up-output', heads('K', '2 * J')); graph.tensor('expert-activation', heads('K', 'J'));
  graph.tensor('expert-output', heads('K', 'M')); graph.tensor('combined-latent', sequence('M'));
  const read = '2 * min(E, B * Q * K) * M * J';
  graph.node('expert-gate-up', 'Latent expert gate and up projections', ['expert-input', 'expert-gate-weight', 'expert-up-weight'],
    ['expert-gate-up-output'], { useful: '4 * B * Q * K * M * J' }, { accessBytes: { 'expert-gate-weight': read, 'expert-up-weight': read } });
  graph.node('expert-situ', 'Routed expert SiTU-GLU', ['expert-gate-up-output'], ['expert-activation'], vectorWork('15 * B * Q * K * J'));
  graph.node('expert-down', 'Routed expert latent down projections', ['expert-activation', 'expert-down-weight'], ['expert-output'],
    { useful: '2 * B * Q * K * M * J' }, { accessBytes: { 'expert-down-weight': read } });
  graph.node('combine', 'Weighted sum in the expert latent space', ['expert-output', 'expert-weights'], ['combined-latent'],
    vectorWork('B * Q * M * (2 * K - 1)'));
  weight(graph, 'latent-norm-weight', ['M']); graph.tensor('normalized-latent', sequence('M'));
  graph.node('latent-rmsnorm', 'Normalize the combined expert latent', ['combined-latent', 'latent-norm-weight'], ['normalized-latent'],
    vectorWork('5 * B * Q * M'));
  weight(graph, 'latent-up-weight', ['M', 'H']); graph.tensor('routed-output', hidden);
  graph.node('latent-up', 'Project the routed result to the model width', ['normalized-latent', 'latent-up-weight'], ['routed-output'],
    { useful: '2 * B * Q * M * H' });
  addSituMlp(graph, 'shared', 'S * J', 'shared-output');
  graph.tensor('ffn-output', hidden);
  graph.node('expert-merge', 'Combine routed and shared experts', ['routed-output', 'shared-output'], ['ffn-output'], vectorWork('B * Q * H'));
}
