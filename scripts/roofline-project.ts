import { ProjectDocument,type AssetDocument } from '@model-analyser/contracts';
/** GEMM: 256M operations and 48M+256 byte. P=400 op/s, B=100 B/s. */
export function makeRooflineProject(base:ProjectDocument,computeEfficiency=1,memoryEfficiency=1):ProjectDocument{
  const p=ProjectDocument.parse(base),variant='c'+computeEfficiency+'-m'+memoryEfficiency;p.projectId='example:project:roofline-'+variant;p.name='GEMM Roofline · '+variant;p.measurements=[];
  // Copy the changed definitions and all reverse dependencies, never publish two
  // different values under the original C01 immutable asset ID/revision.
  const ids=new Map(p.assetSnapshots.filter(a=>['hardware','operator','module','model'].includes(a.definition.kind)).map(a=>[a.assetId,'example:'+a.definition.kind+':roofline-'+variant+':'+a.assetId]));
  function remap(v:unknown):void{if(!v||typeof v!=='object')return;const record=v as Record<string,unknown>;if(typeof record.assetId==='string'&&typeof record.revision==='number'){const next=ids.get(record.assetId as AssetDocument['assetId']);if(next)record.assetId=next;}for(const child of Object.values(record))remap(child);}
  remap(p);
  for(const a of p.assetSnapshots){if(a.definition.kind==='hardware'){a.name='Artificial Roofline 400 op/s · 100 B/s';a.sources=[{kind:'note',text:'Independent artificial GEMM reference: 400 matrix operations/s, 100 HBM byte/s, original nominal capacity. Not a device specification or benchmark.'}];for(const c of a.definition.hardware.computeCapabilities)if(c.computeClass.resource==='matrix')c.operationsPerSecond=400;for(const m of a.definition.hardware.memoryCapabilities)if(m.key==='hbm')m.bytesPerSecond=100;}if(a.definition.kind==='operator'&&a.definition.operator.cost.timing.kind==='roofline_bound'){a.definition.operator.cost.timing.computeEfficiency=computeEfficiency;a.definition.operator.cost.timing.memoryEfficiency=memoryEfficiency;}}
  return ProjectDocument.parse(p);
}
