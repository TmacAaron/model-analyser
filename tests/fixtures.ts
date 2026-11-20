import { AssetDocument } from '@model-analyser/contracts';
import { readFileSync } from 'node:fs';
export const fixture=()=>AssetDocument.parse(JSON.parse(readFileSync('assets/builtin/formula/gemm.json','utf8')));
