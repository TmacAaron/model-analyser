import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { AssetDocument } from '@model-analyser/contracts';
import { canonical, validateAssets } from '../packages/contracts/src/validation.js';
import { makeDeepSeekV4Assets } from './deepseek-v4-model.js';
import { makeDeepSeekV41Assets } from './deepseek-v41-model.js';
import { makeDeepSeekFlashParallelAssets } from './deepseek-v4-parallel.js';
import { makeDeepSeekFlashPublishedWeightPreset } from './deepseek-flash-published-weights.js';

const v41 = process.argv.includes('--v41');
const unique = new Map<string, AssetDocument>();
const latest = makeDeepSeekFlashParallelAssets(v41);
for (const asset of [...(v41 ? makeDeepSeekV41Assets() : makeDeepSeekV4Assets()),
  ...makeDeepSeekFlashParallelAssets(v41, 2), ...makeDeepSeekFlashParallelAssets(v41, 3), ...latest,
  makeDeepSeekFlashPublishedWeightPreset(latest, v41)]) {
  const key = asset.assetId + '@' + asset.revision;
  const prior = unique.get(key);
  if (prior) assert.equal(canonical(prior), canonical(asset), key);
  else unique.set(key, asset);
}
const assets = [...unique.values()];
assert.deepEqual(validateAssets(assets), []);
const write = process.argv.includes('--write');
for (const asset of assets) {
  const filename = 'assets/builtin/' + asset.definition.kind + '/' + asset.assetId.split(':').slice(2).join('-') +
    (asset.revision === 1 ? '' : '-r' + asset.revision) + '.json';
  try {
    const stored = AssetDocument.parse(JSON.parse(await readFile(filename, 'utf8')));
    assert.equal(canonical(stored), canonical(asset), filename);
  } catch (error) {
    if (!write || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    await writeFile(filename, JSON.stringify(asset, null, 2) + '\n', { flag: 'wx' });
  }
}
console.log('Verified ' + assets.length + ' DeepSeek-' + (v41 ? 'V4.1' : 'V4') + ' Flash assets.');
