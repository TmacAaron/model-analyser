import { z } from 'zod';
const Id=z.string().min(1),Natural=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),NonNegative=z.number().nonnegative(),DeviceId=Id.brand<'DeviceId'>(),NodeId=Id.brand<'NodeId'>(),Phase=z.enum(['prefill','decode']);

// Raw Chrome events are deliberately not domain measurements. Only complete X durations enter this table.
export const TraceEvent = z.strictObject({index:Natural,name:Id,category:z.string(),pid:Id,tid:Id,startSeconds:NonNegative,seconds:z.number().positive(),rawStartMicroseconds:z.number(),rawDurationMicroseconds:z.number().positive(),sourceDevice:z.string().optional(),correlation:z.string().optional()});
export const TraceImport = z.strictObject({version:z.literal('chrome-trace.1'),sourceName:Id,contentHash:Id,originMicroseconds:z.number(),rawEventCount:Natural,ignoredPhases:z.array(z.strictObject({phase:Id,count:Natural})),zeroDurationCount:Natural,events:z.array(TraceEvent).max(100000)});
const unsignedNs=z.string().regex(/^(0|[1-9]\d{0,19})$/);
export const RocmTraceEvent = TraceEvent.omit({rawStartMicroseconds:true,rawDurationMicroseconds:true}).extend({category:z.literal('ROCm kernel'),sourceDevice:Id,rawStartNanoseconds:unsignedNs,rawEndNanoseconds:unsignedNs,dispatchId:Id,sourceQueue:Id,csvLine:Natural.min(2),rawDispatchNanoseconds:unsignedNs.optional(),rawCompleteNanoseconds:unsignedNs.optional()});
export const RocmTraceImport = z.strictObject({version:z.literal('rocm-timestamps.1'),sourceName:Id,contentHash:Id,originNanoseconds:unsignedNs,rawEventCount:Natural,ignoredColumns:z.array(Id),zeroDurationCount:Natural,events:z.array(RocmTraceEvent).max(100000)});
export const ProfilerImport = z.discriminatedUnion('version',[TraceImport,RocmTraceImport]);
export const TraceSelection = z.strictObject({startSeconds:NonNegative.optional(),endSeconds:NonNegative.optional(),category:z.string().optional(),pid:Id.optional(),tid:Id.optional(),sourceDevice:Id.optional(),sourceQueue:Id.optional(),nameContains:z.string().optional(),eventIndices:z.array(Natural).max(1000).optional()});
export const TraceMappingTarget = z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('model')}),z.strictObject({kind:z.literal('module'),nodeId:NodeId}),z.strictObject({kind:z.literal('node'),nodeId:NodeId}),
]);
export const TraceMappingRule = z.strictObject({ruleId:Id,name:Id,category:z.string().optional(),pid:Id.optional(),tid:Id.optional(),sourceDevice:Id.optional(),sourceQueue:Id.optional(),target:TraceMappingTarget});
export const TraceMappingRequest = z.strictObject({trace:ProfilerImport,selection:TraceSelection,rules:z.array(TraceMappingRule).max(1000),overrides:z.array(z.strictObject({eventIndex:Natural,target:TraceMappingTarget})).max(1000),scenarioId:Id,phase:Phase,deviceIds:z.array(DeviceId).min(1),interval:Id});
export type TraceEvent = z.infer<typeof TraceEvent>;
export type TraceImport = z.infer<typeof TraceImport>;
export type RocmTraceEvent = z.infer<typeof RocmTraceEvent>;
export type RocmTraceImport = z.infer<typeof RocmTraceImport>;
export type ProfilerImport = z.infer<typeof ProfilerImport>;
export type ProfilerEvent = TraceEvent | RocmTraceEvent;
export type TraceSelection = z.infer<typeof TraceSelection>;
export type TraceMappingTarget = z.infer<typeof TraceMappingTarget>;
export type TraceMappingRule = z.infer<typeof TraceMappingRule>;
export type TraceMappingRequest = z.infer<typeof TraceMappingRequest>;
