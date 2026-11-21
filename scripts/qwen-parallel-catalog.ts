import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { AssetDocument } from '@model-analyser/contracts';
import { canonical, validateAssets } from '../packages/contracts/src/validation.js';
import { makeQwenParallelAssets } from './qwen-parallel-assets.js';
import { addQwenPipelinePreset } from './qwen-pipeline.js';

const assets = makeQwenParallelAssets();
assets.push(...assets.filter(asset => asset.definition.kind === 'model').map(addQwenPipelinePreset));
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
    if (kind === 'formula' || !process.argv.includes('--write') || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    await writeFile(file, JSON.stringify(asset, null, 2) + '\n', { flag: 'wx' });
  }
}
console.log('Verified the Qwen3 parallel model revisions, decoder and referenced formulas.');
