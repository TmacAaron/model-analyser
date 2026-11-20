import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { AssetDocument } from '@model-analyser/contracts';
import { canonical, validateAssets } from '../packages/contracts/src/validation.js';
import { makeDeepSeekV4Assets } from './deepseek-v4-model.js';

const assets = makeDeepSeekV4Assets();
assert.deepEqual(validateAssets(assets), []);
const write = process.argv.includes('--write');
for (const asset of assets) {
  const filename = 'assets/builtin/' + asset.definition.kind + '/' + asset.assetId.split(':').slice(2).join('-') + '.json';
  try {
    const stored = AssetDocument.parse(JSON.parse(await readFile(filename, 'utf8')));
    assert.equal(canonical(stored), canonical(asset), filename);
  } catch (error) {
    if (!write || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    await writeFile(filename, JSON.stringify(asset, null, 2) + '\n', { flag: 'wx' });
  }
}
console.log('Verified ' + assets.length + ' DeepSeek-V4 Flash assets.');
