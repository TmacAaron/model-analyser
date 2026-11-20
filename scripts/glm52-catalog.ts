import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { AssetDocument } from '@model-analyser/contracts';
import { canonical, validateAssets } from '../packages/contracts/src/validation.js';
import { makeGlm52Assets } from './glm52-model.js';

const assets = makeGlm52Assets();
assert.deepEqual(validateAssets(assets), []);
for (const asset of assets) {
  const filename = 'assets/builtin/' + asset.definition.kind + '/' + asset.assetId.split(':').slice(2).join('-') + '.json';
  try {
    const stored = AssetDocument.parse(JSON.parse(await readFile(filename, 'utf8')));
    assert.equal(canonical(stored), canonical(asset), filename);
  } catch (error) {
    if (!process.argv.includes('--write') || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    await writeFile(filename, JSON.stringify(asset, null, 2) + '\n', { flag: 'wx' });
  }
}
console.log('Verified ' + assets.length + ' GLM-5.2 assets.');
