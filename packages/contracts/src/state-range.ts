import type { z } from 'zod';
import type { StateSpec } from './index.js';

/** Logical tokens covered by this state, independent of padding and physical copies. */
export function stateTokenRange(tokens: number, policy: z.infer<typeof StateSpec>['updatePolicy']) {
  if (policy.kind === 'append') {
    const group = policy.tokensPerRow ?? 1;
    return { start: 0, end: Math.floor(tokens / group) * group };
  }
  if (policy.kind === 'windowed' && policy.window.kind === 'literal') {
    return { start: Math.max(0, tokens - policy.window.quantity.value), end: tokens };
  }
  return undefined;
}
