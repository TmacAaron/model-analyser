import type { TensorPartitionResult } from '@model-analyser/contracts';
import { canonical } from '../../contracts/src/validation.js';
const partialTag=(p:TensorPartitionResult)=>p.distribution.kind==='partial'?
  p.distribution.partition?canonical([p.distribution.reduceOperation,p.distribution.partition.tensorAxisId]):p.distribution.reduceOperation:null;
export const tensorLayoutSignature=(p:TensorPartitionResult)=>canonical({partial:partialTag(p),manual:p.coverage==='manual',dtype:p.dtype,placements:[...p.placements].sort((a,b)=>a.deviceId<b.deviceId?-1:1).map(({deviceId,logicalShape,allocatedShape,copies,slices})=>({deviceId,logicalShape,allocatedShape,copies,slices}))});
export function canReadTensorLocally(source:TensorPartitionResult,target:TensorPartitionResult):boolean{
  if(tensorLayoutSignature(source)===tensorLayoutSignature(target))return true;
  if(source.coverage==='manual'||target.coverage==='manual')return false;
  if(partialTag(source)!==partialTag(target)||canonical(source.dtype)!==canonical(target.dtype))return false;
  return target.placements.every(to=>{const from=source.placements.find(p=>p.deviceId===to.deviceId);return from&&from.copies>=to.copies&&to.slices.every(s=>{const a=from.slices.find(a=>a.axisId===s.axisId);return a&&a.start<=s.start&&a.end>=s.end;});});
}
/** Cover a required rectangular view using zero or more already available pieces. */
export function canReadTensorPieces(sources:TensorPartitionResult[],target:TensorPartitionResult):boolean{
  return target.placements.every(to=>{
    if(to.logicalElements===0)return true;
    const matching=sources.filter(s=>partialTag(s)===partialTag(target)&&canonical(s.dtype)===canonical(target.dtype));
    if(target.coverage==='manual')return matching.some(s=>canReadTensorLocally({...s,placements:s.placements.filter(p=>p.deviceId===to.deviceId)},{...target,placements:[to]}));
    type Box={start:number;end:number}[];let uncovered:Box[]=[to.slices.map(s=>({start:s.start,end:s.end}))];
    for(const s of matching){if(s.coverage==='manual')continue;for(const from of s.placements){if(from.deviceId!==to.deviceId||from.copies<to.copies)continue;
      const cover=to.slices.map(slice=>from.slices.find(a=>a.axisId===slice.axisId));if(cover.some(a=>a===undefined))continue;const next:Box[]=[];
      for(const box of uncovered){const intersection=box.map((a,i)=>({start:Math.max(a.start,cover[i]?.start??0),end:Math.min(a.end,cover[i]?.end??0)}));if(intersection.some(a=>a.start>=a.end)){next.push(box);continue;}let middle=box.map(a=>({...a}));
        for(let axis=0;axis<box.length;axis++){const current=middle[axis],cut=intersection[axis];if(!current||!cut)continue;if(current.start<cut.start){const piece=middle.map(a=>({...a}));piece[axis]={start:current.start,end:cut.start};next.push(piece);}if(cut.end<current.end){const piece=middle.map(a=>({...a}));piece[axis]={start:cut.end,end:current.end};next.push(piece);}middle=middle.map((a,i)=>i===axis?{...cut}:a);}
      }
      uncovered=next;if(!uncovered.length)return true;if(uncovered.length>4096)return false;
    }}return uncovered.length===0;
  });
}
