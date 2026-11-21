import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { AssetDocument } from '@model-analyser/contracts';
import { canonical, validateAssets } from '../packages/contracts/src/validation.js';
import { makeQwenParallelAssets } from './qwen-parallel-assets.js';
import { addQwenPipelinePreset } from './qwen-pipeline.js';
import { addQwenContextPreset } from './qwen-context-parallel.js';
import { addQwenDecodeContextPreset, addQwenDecodeRequestParallel } from './qwen-decode-context.js';

const assets = makeQwenParallelAssets();
const pipeline = assets.filter(asset => asset.definition.kind === 'model').map(addQwenPipelinePreset);
const decoder = assets.find(asset => asset.definition.kind === 'module');
if (!decoder) throw Error('Missing Qwen decoder');
const context = addQwenContextPreset(decoder, pipeline);
const contextDecoder = context.find(asset => asset.definition.kind === 'module');
if (!contextDecoder) throw Error('Missing Qwen context decoder');
const decode = addQwenDecodeContextPreset(contextDecoder, context.filter(asset => asset.definition.kind === 'model'));
const decodeLayer = decode.find(asset => asset.definition.kind === 'module');
if (!decodeLayer) throw Error('Missing Qwen Decode context decoder');
assets.push(...pipeline, ...context, ...decode, ...addQwenDecodeRequestParallel(decodeLayer, decode.filter(asset => asset.definition.kind === 'model')));
assert.deepEqual(validateAssets(assets), []);
for (const asset of assets) {
  const kind = asset.definition.kind;
  const basename = kind === 'formula' ? asset.assetId.split(':').slice(2).join('-')
    : encodeURIComponent(asset.assetId) + '-r' + asset.revision;
  const file = 'assets/builtin/' + kind + '/' + basename + '.json';
  try {
    const existing = AssetDocument.parse(JSON.parse(await readFile(file, 'utf8')));
    assert.equal(canonical(asset), canonical(existing), file);
  } catch (error) {
    if ((kind === 'formula' && !/^builtin:formula:qwen-(pcp|dcp):/.test(asset.assetId)) ||
        !process.argv.includes('--write') || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    await writeFile(file, JSON.stringify(asset, null, 2) + '\n', { flag: 'wx' });
  }
}
console.log('Verified the Qwen3 parallel model revisions, decoder and referenced formulas.');
