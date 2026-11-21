import { AssetDocument, type GraphTemplate } from '@model-analyser/contracts';
import { Equations, GraphAuthor, fp32, int64, literal, symbol } from './model-authoring.js';
import { hidden, parameter, token } from './deepseek-v4-model.js';
import { sequence, vectorWork, weight, type Axis } from './deepseek-v4-attention.js';
import { addKimiKda, addKimiMla } from './kimi-k3-attention.js';
import { addKimiFfn } from './kimi-k3-ffn.js';
import { kimiK3Sources, loadKimiK3 } from './kimi-k3-profile.js';

const archiveShape = (rows: string): Axis[] => [...token, ['depth', 'custom', rows], ['d', 'hidden', 'H']];
const scope = 'builtin:module:kimi-k3-';
const parameterP = parameter('P', 1);

function rmsnorm(graph: GraphAuthor, id: string, input: string, output: string) {
  weight(graph, id + '-weight', ['H']); graph.tensor(output, hidden);
  graph.node(id, 'Hidden-width RMSNorm', [input, id + '-weight'], [output], vectorWork('5 * B * Q * H'));
}

function depthMix(graph: GraphAuthor, prefix: string, archive: string, rows: string, partial: string, output: string) {
  const id = (suffix: string) => prefix + '-depth-' + suffix;
  const count = '(' + rows + ' + 1)';
  weight(graph, id('norm-weight'), ['H']); weight(graph, id('projection'), ['H']);
  graph.tensor(id('scores'), sequence(count), { dtype: fp32 }); graph.tensor(output, hidden);
  graph.node(id('score'), 'AttnRes · score normalized block sources', [archive, partial, id('norm-weight'), id('projection')],
    [id('scores')], vectorWork('H + B * Q * ' + count + ' * 6 * H'));
  graph.node(id('mix'), 'AttnRes · depth softmax and residual mixing', [id('scores'), archive, partial], [output],
    vectorWork('B * Q * (5 * ' + count + ' + (2 * ' + count + ' - 1) * H)'));
}

export function makeKimiK3Assets(revision: 1 | 2 | 3 = 1): AssetDocument[] {
  const schedule = loadKimiK3();
  const parameters = [parameter('B', 1), parameter('Q', 4), parameter('C', 0, 0),
    ...schedule.dimensions.map(([key, value]) => parameter(key, value))];
  const parallel = revision >= 2;
  const formulaParameters = [...parameters, parameterP, parameter('depthBlock', 0, 0)];
  const equations = new Equations('builtin:formula:kimi-k3', parallel ? [...formulaParameters, parameter('RouteSlots', 0, 0)] : formulaParameters,
    kimiK3Sources, parallel ? new Map([['RouteSlots', 'K']]) : undefined);
  const base = { documentType: 'asset' as const, schemaVersion: 1 as const, revision,
    tags: ['kimi', 'kimi-k3', 'kda', 'mla', 'attnres', 'bf16'], sources: kimiK3Sources };
  const modules: AssetDocument[] = [];
  function define(id: string, name: string, graph: GraphAuthor, historical: boolean) {
    const asset = AssetDocument.parse({ ...base, assetId: scope + id, name,
      parameters: historical ? [...parameters, parameterP] : parameters, definition: { kind: 'module', graph: graph.graph } });
    modules.push(asset);
    return asset;
  }
  function remember(graph: GraphAuthor, input: boolean, rows: string) {
    graph.tensor('archive', archiveShape(rows));
    if (input) graph.input('archive');
  }
  function layer(kind: 'first' | 'boundary' | 'kda' | 'mla', name: string) {
    const graph = new GraphAuthor(equations), initial = kind === 'first', boundary = initial || kind === 'boundary';
    graph.tensor('x', hidden); graph.input('x');
    if (!initial) {
      remember(graph, true, 'P');
      depthMix(graph, 'attn', 'archive', 'P', 'x', 'attn-mix');
    } else {
      // The checkpoint declares these learned weights even though the first query has no older source to score.
      weight(graph, 'attn-depth-norm-weight', ['H']); weight(graph, 'attn-depth-projection', ['H']);
    }
    const rows = initial ? '1' : boundary ? 'P + 1' : 'P';
    const archived = boundary ? 'archive-after' : 'archive';
    if (boundary) {
      graph.tensor(archived, archiveShape(rows));
      graph.node('archive-residual', 'Archive completed depth residual and start a new block',
        initial ? ['x'] : ['archive', 'x'], [archived]);
      graph.output(archived, 'archive-out');
    }
    rmsnorm(graph, 'input-rmsnorm', initial ? 'x' : 'attn-mix', 'attn-input');
    if (kind === 'mla') addKimiMla(graph); else addKimiKda(graph);
    const partial = boundary ? 'attention-output' : 'after-attention';
    if (!boundary) {
      graph.tensor(partial, hidden);
      graph.node('attention-residual', 'Accumulate attention into the current depth block', ['x', 'attention-output'], [partial],
        vectorWork('B * Q * H'));
    }
    depthMix(graph, 'ffn', archived, rows, partial, 'ffn-mix');
    rmsnorm(graph, 'post-rmsnorm', 'ffn-mix', 'ffn-input');
    addKimiFfn(graph, initial, revision);
    graph.tensor('y', hidden);
    graph.node('ffn-residual', 'Accumulate FFN into the current depth block', [partial, 'ffn-output'], ['y'], vectorWork('B * Q * H'));
    graph.output('y');
    return define('layer-' + kind, name, graph, !initial);
  }
  const first = layer('first', 'KDA · Dense 首层'), boundary = layer('boundary', 'KDA · Attention Residuals 边界');
  const kda = layer('kda', 'KDA · Latent MoE'), mla = layer('mla', 'Gated MLA · Latent MoE');
  const repeat = (count: number, depth = false): GraphTemplate['nodes'][number]['repeat'] => ({ axis: depth ? 'depthBlock' : 'layer',
    count: literal(count), wiring: 'chain', carry: [{ inputPortId: 'x', outputPortId: 'y' },
      ...(depth ? [{ inputPortId: 'archive', outputPortId: 'archive-out' }] : [])],
  });
  function attach(graph: GraphAuthor, id: string, asset: AssetDocument, input: string, output: string,
    rows?: string, archive?: string, archived?: [string, string], repetition?: GraphTemplate['nodes'][number]['repeat']) {
    graph.tensor(output, hidden);
    if (archived) graph.tensor(archived[0], archiveShape(archived[1]));
    graph.modulePorts(id, asset.name, asset, { x: input, ...(archive ? { archive } : {}) },
      { y: output, ...(archived ? { 'archive-out': archived[0] } : {}) }, asset.parameters, repetition);
    const body = graph.graph.nodes.at(-1)?.body;
    if (rows && body?.kind === 'module') {
      const binding = body.bindings.find(item => item.parameterKey === 'P');
      if (!binding) throw Error('Missing AttnRes depth binding for ' + id);
      binding.value = equations.value(rows, 'count');
    }
  }
  function segment(id: 'cycle' | 'start' | 'block' | 'tail', name: string, cycles?: AssetDocument) {
    const graph = new GraphAuthor(equations), start = id === 'start', cycle = id === 'cycle', tail = id === 'tail';
    graph.tensor('x', hidden); graph.input('x');
    if (!start) remember(graph, true, 'P');
    let archived = 'archive', rows = 'P', prefix = 'x', copies = 3;
    if (!cycle) {
      archived = 'archived'; rows = start ? '1' : 'P + 1';
      attach(graph, 'boundary', start ? first : boundary, 'x', 'after-boundary', start ? undefined : 'P', start ? undefined : 'archive', [archived, rows]);
      graph.output(archived, 'archive-out');
      prefix = 'after-boundary'; copies = 2;
    }
    attach(graph, 'linear', kda, prefix, 'linear-output', rows, archived, undefined, repeat(copies));
    attach(graph, 'full', mla, 'linear-output', cycle ? 'y' : 'full-output', rows, archived);
    if (cycles) attach(graph, 'cycle', cycles, 'full-output', tail ? 'tail-output' : 'y', rows, archived, undefined, tail ? undefined : repeat(2));
    if (tail) attach(graph, 'final-full', mla, 'tail-output', 'y', rows, archived);
    graph.output('y');
    return define(id, name, graph, !start);
  }
  const cycle = segment('cycle', '3 层 KDA + 1 层 Gated MLA');
  const start = segment('start', '首个 Attention Residuals 块', cycle);
  const block = segment('block', '12 层 Attention Residuals 块', cycle);
  const tail = segment('tail', '末尾 9 层 Attention Residuals 块', cycle);

  const graph = new GraphAuthor(equations);
  graph.tensor('tokens', token, { dtype: int64 }); graph.input('tokens');
  weight(graph, 'embedding-weight', ['V', 'H']); graph.tensor('embedding', hidden);
  graph.node('embedding', 'Token embedding lookup', ['tokens', 'embedding-weight'], ['embedding'], undefined,
    { accessBytes: { 'embedding-weight': '2 * B * Q * H' } });
  attach(graph, 'start', start, 'embedding', 'first-output', undefined, undefined, ['first-archive', '1']);
  attach(graph, 'blocks', block, 'first-output', 'main-output', 'depthBlock + 1', 'first-archive', ['main-archive', String(schedule.fullBlocks)],
    repeat(schedule.fullBlocks - 1, true));
  attach(graph, 'tail', tail, 'main-output', 'decoder-output', String(schedule.fullBlocks), 'main-archive', ['decoder-archive', String(schedule.fullBlocks + 1)]);
  depthMix(graph, 'final', 'decoder-archive', String(schedule.fullBlocks + 1), 'decoder-output', 'mixed');
  rmsnorm(graph, 'final-rmsnorm', 'mixed', 'normalized');
  weight(graph, 'lm-head-weight', ['V', 'H']); graph.tensor('logits', [...token, ['v', 'vocab', 'V']]);
  graph.node('lm-head', 'Untied full-position output projection', ['normalized', 'lm-head-weight'], ['logits'], { useful: '2 * B * Q * H * V' });
  graph.output('logits');

  const model = AssetDocument.parse({ ...base, assetId: 'builtin:model:kimi-k3', name: 'Kimi-K3 · 文本解码器', parameters,
    definition: { kind: 'model', family: 'kimi-k3', variant: 'gated-mla-kda-attnres-bf16', graph: graph.graph,
      assumptions: kimiK3Sources.flatMap(source => source.kind === 'note' ? [source.text] : []),
      workloadBindings: (['prefill', 'decode'] as const).flatMap(phase => [
        { phase, parameterKey: 'B', value: symbol('batchSize') }, { phase, parameterKey: 'Q', value: symbol('queryTokensPerRequest') },
        { phase, parameterKey: 'C', value: symbol(phase === 'prefill' ? 'pastTokensPerRequest' : 'contextTokensPerRequest') },
      ]),
    },
  });
  return [model, ...modules, ...equations.assets];
}
