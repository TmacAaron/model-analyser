import { z } from 'zod';
/** Share repeated nodes so ordinary validators do not compile giant duplicated functions. */
export const contractJsonSchema=(schema:z.ZodType)=>z.toJSONSchema(schema,{target:'draft-2020-12',unrepresentable:'throw',reused:'ref'});
