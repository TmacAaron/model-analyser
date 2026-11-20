import type { MemoryEvidence,MetricValue } from './index.js';
/** Missing source references stay unavailable; they never use another allocation's source. */
export function memoryAllocationMetric(evidence:MemoryEvidence,row:MemoryEvidence['allocations'][number]):MetricValue|undefined{
  return memoryEvidenceMetric(evidence,row.bytes);
}
export function memoryEvidenceMetric(evidence:Pick<MemoryEvidence,'provenancePool'>,bytes:MemoryEvidence['allocations'][number]['bytes']):MetricValue|undefined{if(bytes.status==='unavailable')return bytes;const provenance=evidence.provenancePool[bytes.provenanceIndex];if(!provenance)return;const {provenanceIndex,...value}=bytes;void provenanceIndex;return {...value,provenance};}
