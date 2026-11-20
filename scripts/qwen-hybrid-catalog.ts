import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { AssetDocument } from '@model-analyser/contracts';
import { canonical, validateAssets } from '../packages/contracts/src/validation.js';
import { makeQwenHybridAssets } from './qwen-hybrid-model.js';

const assets = new Map<string, AssetDocument>();
for (const release of ['qwen35', 'qwen38'] as const) {
  for (const asset of makeQwenHybridAssets(release)) {
    const prior = assets.get(asset.assetId);
    if (prior) assert.equal(canonical(prior), canonical(asset), asset.assetId);
    else assets.set(asset.assetId, asset);
  }
}
assert.deepEqual(validateAssets([...assets.values()]), []);
for (const asset of assets.values()) {
  const path = 'assets/builtin/' + asset.definition.kind + '/' + asset.assetId.split(':').slice(2).join('-') + '.json';
  try {
    const saved = AssetDocument.parse(JSON.parse(await readFile(path, 'utf8')));
    assert.equal(canonical(saved), canonical(asset), path);
  } catch (error) {
    if (!process.argv.includes('--write') || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    await writeFile(path, JSON.stringify(asset, null, 2) + '\n', { flag: 'wx' });
  }
}
console.log('Verified ' + assets.size + ' Qwen hybrid decoder assets.');
