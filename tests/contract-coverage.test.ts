import { it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildContractCoverage,contractRoots,contractUnionInventory,probeValue } from '../scripts/contract-coverage.js';
import { canonical } from '../packages/contracts/src/validation.js';
import { contractJsonSchema } from '../packages/contracts/src/json-schema.js';

it('keeps every exported/HTTP schema and nested union branch represented in checked-in positive and negative structural fixtures',()=>{
  const expected=buildContractCoverage(),stored=JSON.parse(readFileSync('examples/contracts/union-coverage.json','utf8')) as unknown,hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');expect(hash(stored),'Schema inventory changed; regenerate reference:contracts and inspect the branch diff.').toBe(hash(expected));
  const ajv=new Ajv2020({strict:false,strictNumbers:true,inlineRefs:false,code:{optimize:false}});addFormats(ajv);const roots=contractRoots();for(const f of expected.roots){const s=roots.get(f.name);if(!s)throw Error();const check=ajv.compile(contractJsonSchema(s));expect(s.safeParse(f.valid).success,f.name).toBe(true);expect(Boolean(check(f.valid)),f.name+' JSON Schema').toBe(true);expect(s.safeParse(probeValue(f.invalid)).success,f.name+' negative').toBe(false);expect(Boolean(check(probeValue(f.invalid))),f.name+' JSON Schema negative').toBe(false);}
  const inventory=contractUnionInventory(roots);for(const u of inventory){const f=expected.unions.find(x=>x.id===u.id);if(!f)throw Error('Union absent '+u.locations.join(','));expect(f.branches.length).toBe(u.branches.length);const check=ajv.compile(contractJsonSchema(u.schema));for(const [i,b] of u.branches.entries()){const sample=f.branches[i];if(!sample)throw Error();expect(b.safeParse(sample.valid).success,u.locations[0]+' '+sample.label).toBe(true);expect(u.schema.safeParse(sample.valid).success).toBe(true);expect(Boolean(check(sample.valid))).toBe(true);expect(u.schema.safeParse(probeValue(sample.invalid)).success).toBe(false);expect(Boolean(check(probeValue(sample.invalid)))).toBe(false);if(sample.invalidTag){expect(u.schema.safeParse(probeValue(sample.invalidTag)).success).toBe(false);expect(Boolean(check(probeValue(sample.invalidTag)))).toBe(false);}}}
},60000);
