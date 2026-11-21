import { z } from 'zod';
import { AssetDocument, ProjectDocument, type Scenario } from '@model-analyser/contracts';

export type ModelValidationTask = { taskId: string } & (
  { kind: 'model'; scenario: Scenario; assets: AssetDocument[]; validateLayout?: true } |
  { kind: 'targets'; scenario: Scenario; assets: AssetDocument[]; nodeIds: string[] } |
  { kind: 'config'; asset: AssetDocument; library: AssetDocument[] } |
  { kind: 'ascend'; project: ProjectDocument; scenarioId: string; importId: string; note: string }
);

export const ModelValidationReply = z.strictObject({
  taskId: z.string(),
  reply: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('validated') }),
    z.strictObject({ kind: z.literal('asset'), asset: AssetDocument }),
    z.strictObject({ kind: z.literal('project'), project: ProjectDocument }),
    z.strictObject({ kind: z.literal('error'), message: z.string() }),
  ]),
});
export type ModelValidationReply = z.infer<typeof ModelValidationReply>;
