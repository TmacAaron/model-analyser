import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import * as contracts from '../packages/contracts/src/index.js';
import { contractJsonSchema } from '../packages/contracts/src/json-schema.js';
await mkdir('schemas/generated',{recursive:true});
for(const [name,schema] of Object.entries(contracts)) {
  if(schema instanceof z.ZodType) await writeFile(`schemas/generated/${name}.schema.json`,JSON.stringify(contractJsonSchema(schema),null,2)+'\n');
}
