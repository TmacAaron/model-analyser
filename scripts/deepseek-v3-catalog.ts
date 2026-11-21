import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { AssetDocument } from '@model-analyser/contracts';
import { canonical, validateAssets } from '../packages/contracts/src/validation.js';
import { makeDeepSeekAssets } from './deepseek-model.js';
import { loadDeepSeekV3Profile } from './deepseek-v3-profile.js';
import { makeDeepSeekV3ParallelAssets } from './deepseek-v3-parallel.js';
import { makeDeepSeekV3FP8WeightPreset } from './deepseek-v3-fp8-weights.js';

const catalog = new Map<string, AssetDocument>();
for (const release of ['v3', 'r1'] as const) {
  const previous = ([5, 6, 7] as const).flatMap(revision => {
    const assets = makeDeepSeekV3ParallelAssets(release, revision);
    return [...assets, makeDeepSeekV3FP8WeightPreset(assets, release)];
  });
  const latest = makeDeepSeekV3ParallelAssets(release);
  for (const asset of [...makeDeepSeekAssets('absorbed', loadDeepSeekV3Profile(release)),
    ...([2, 3, 4] as const).flatMap(revision => makeDeepSeekV3ParallelAssets(release, revision)),
    ...previous, ...latest, makeDeepSeekV3FP8WeightPreset(latest, release)]) {
    const key = asset.assetId + '@' + asset.revision;
    const existing = catalog.get(key);
    if (existing) assert.equal(canonical(asset), canonical(existing), key);
    else catalog.set(key, asset);
  }
}
assert.deepEqual(validateAssets([...catalog.values()]), []);

const fileFor = (asset: AssetDocument) =>
  'assets/builtin/' + asset.definition.kind + '/' + asset.assetId.split(':').slice(2).join('-') +
  (asset.revision > 1 && /:deepseek-(?:v3|r1)(?:-|$)/.test(asset.assetId) ? '-r' + asset.revision : '') + '.json';
async function verify(asset: AssetDocument, write: boolean) {
  const file = fileFor(asset);
  try {
    const stored = AssetDocument.parse(JSON.parse(await readFile(file, 'utf8')));
    assert.equal(canonical(stored), canonical(asset), file);
  } catch (error) {
    if (!write || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    await writeFile(file, JSON.stringify(asset, null, 2) + '\n', { flag: 'wx' });
  }
}
// Existing V2 releases share the authoring path and keep their published contents.
for (const variant of ['expanded', 'absorbed'] as const) {
  for (const asset of makeDeepSeekAssets(variant)) await verify(asset, false);
}
for (const asset of catalog.values()) await verify(asset, process.argv.includes('--write'));
console.log('Verified ' + catalog.size + ' assets for DeepSeek-V3 and DeepSeek-R1.');
