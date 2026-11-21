import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { AssetDocument } from '@model-analyser/contracts';
import { canonical, validateAssets } from '../packages/contracts/src/validation.js';
import { makeGlm52Assets } from './glm52-model.js';
import { makeGlm52ParallelAssets } from './glm52-parallel.js';
import { makeGlm52FP8WeightPreset } from './glm52-fp8-weights.js';
import { makeGlm52FP8ExecutionAssets } from './glm52-fp8-execution.js';

const unique = new Map<string, AssetDocument>();
const latest = makeGlm52ParallelAssets();
const checkpoint = makeGlm52FP8WeightPreset(latest);
for (const asset of [...makeGlm52Assets(), ...makeGlm52ParallelAssets(2), ...latest, checkpoint, ...makeGlm52FP8ExecutionAssets(latest, checkpoint)]) {
  const key = asset.assetId + '@' + asset.revision;
  const prior = unique.get(key);
  if (prior) assert.equal(canonical(prior), canonical(asset), key);
  else unique.set(key, asset);
}
const assets = [...unique.values()];
assert.deepEqual(validateAssets(assets), []);
for (const asset of assets) {
  const filename = 'assets/builtin/' + asset.definition.kind + '/' + asset.assetId.split(':').slice(2).join('-') +
    (asset.revision === 1 ? '' : '-r' + asset.revision) + '.json';
  try {
    const stored = AssetDocument.parse(JSON.parse(await readFile(filename, 'utf8')));
    assert.equal(canonical(stored), canonical(asset), filename);
  } catch (error) {
    if (!process.argv.includes('--write') || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    await writeFile(filename, JSON.stringify(asset, null, 2) + '\n', { flag: 'wx' });
  }
}
console.log('Verified ' + assets.length + ' GLM-5.2 assets.');
