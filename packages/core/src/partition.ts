import { TensorSpec,TensorDistribution,DeviceTopology,TensorPartitionAttempt,type Shape,type TensorPartitionResult,type Diagnostic } from '@model-analyser/contracts';
import { numericValue,type EvaluationContext } from './storage.js';
import { FormulaError } from './formula.js';
import { canonical } from '../../contracts/src/validation.js';
import type {PartitionObserver,PartitionOperation} from './layout-observation.js';

export const MAX_PARTITION_DEVICES=1024;
const exact=(n:number)=>{if(!Number.isSafeInteger(n)||n<0)throw new FormulaError('numeric_overflow','分布的精确元素数量超出安全整数');return n;};
function elements(sizes:number[],observe?:PartitionObserver['record'],scope:Extract<PartitionOperation,{kind:'elements'}>['scope']='global'){
  const empty=sizes.indexOf(0);
  if(empty>=0){observe?.({kind:'elements',scope,dimensions:sizes,value:0,emptyAxis:empty});return 0;}
  const products:number[]|undefined=observe?[]:undefined;
  const value=sizes.reduce((n,v)=>{const next=exact(n*v);products?.push(next);return next;},1);
  observe?.({kind:'elements',scope,dimensions:sizes,value,...(products?{products}:{})});return value;
}
const shape=(original:Shape,sizes:number[]):Shape=>original.map((a,i)=>({...a,size:{kind:'literal',quantity:{value:sizes[i]??0,unit:'count'}}}));

/** Partition a logical tensor, preserving padding and unused mesh-axis replicas. */
export function partitionTensor(input:TensorSpec,layout:TensorDistribution,inputTopology:DeviceTopology,context:EvaluationContext,observer?:PartitionObserver):TensorPartitionAttempt{
  const diagnostics:Diagnostic[]=[];
  const emit=observer?(operation:PartitionOperation)=>observer.record(structuredClone(operation)):undefined;
  try{
    const tensor=TensorSpec.parse(input),distribution=TensorDistribution.parse(layout),topology=DeviceTopology.parse(inputTopology),group=topology.groups.find(g=>g.groupId===distribution.groupId);
    if(!group)throw new FormulaError('missing_reference','张量分布引用缺少设备组');
    if(new Set(topology.devices.map(d=>d.deviceId)).size!==topology.devices.length||new Set(topology.groups.map(g=>g.groupId)).size!==topology.groups.length)throw new FormulaError('duplicate_id','设备或组 ID 重复');
    if(group.members.length>MAX_PARTITION_DEVICES)throw new FormulaError('distribution_limit',`单组分布最多 ${MAX_PARTITION_DEVICES} 个设备`);
    if(new Set(group.members).size!==group.members.length||group.members.some(id=>!topology.devices.some(d=>d.deviceId===id)))throw new FormulaError('invalid_distribution','设备组成员重复或不存在');
    if(group.mesh){const mesh=group.mesh;
      if(mesh.axes.length>32)throw new FormulaError('distribution_limit','mesh 最多支持 32 个轴');
      if(new Set(mesh.axes.map(a=>a.axisId)).size!==mesh.axes.length||elements(mesh.axes.map(a=>a.size))!==group.members.length||mesh.coordinates.length!==group.members.length||new Set(mesh.coordinates.map(c=>c.deviceId)).size!==group.members.length||new Set(mesh.coordinates.map(c=>c.coordinates.join(','))).size!==group.members.length)throw new FormulaError('invalid_distribution','mesh 必须唯一完整地覆盖每个实际设备');
      for(const c of mesh.coordinates)if(!group.members.includes(c.deviceId)||c.coordinates.length!==mesh.axes.length||c.coordinates.some((v,i)=>v>=(mesh.axes[i]?.size??0)))throw new FormulaError('invalid_distribution','mesh 成员或坐标非法');
    }
    const original=tensor.shape;if(original.length>32)throw new FormulaError('distribution_limit','张量最多支持 32 个分片维度');
    if(new Set(original.map(a=>a.axisId)).size!==original.length)throw new FormulaError('duplicate_id','张量轴 ID 重复');
    const sizes=original.map(a=>numericValue(a.size,'count',context,true)),globalShape=shape(original,sizes),globalElements=elements(sizes,emit);
    const placements:TensorPartitionResult['placements']=[];
    function add(deviceId:DeviceTopology['devices'][number]['deviceId'],local:number[],allocated:number[],slices:TensorPartitionResult['placements'][number]['slices'],copies=1,source=original,shards?:ReadonlyMap<string,PartitionOperation>){
      const observe=observer?.deviceId===deviceId?emit:undefined;
      if(observe)for(const [index,axis] of source.entries()){
        const slice=slices.find(s=>s.axisId===axis.axisId),shard=shards?.get(axis.axisId);
        observe(shard??{kind:'axis',axisId:axis.axisId,method:slice?'whole':'manual',logical:local[index]??0,allocated:allocated[index]??0,...(slice?{extent:slice.end,start:slice.start,end:slice.end}:{})});
      }
      placements.push({deviceId,logicalShape:shape(source,local),allocatedShape:shape(source,allocated),copies,logicalElements:elements(local,observe,'logical'),allocatedElements:elements(allocated,observe,'allocated'),slices});
    }
    const fullSlices=original.map((a,i)=>({axisId:a.axisId,start:0,end:sizes[i]??0,paddedExtent:sizes[i]??0}));
    if(distribution.kind==='replicated'||distribution.kind==='partial')for(const id of group.members)add(id,sizes,sizes,fullSlices);
    else if(distribution.kind==='manual'){
      if(distribution.members.length!==group.members.length||new Set(distribution.members.map(m=>m.deviceId)).size!==group.members.length||distribution.members.some(m=>!group.members.includes(m.deviceId)))throw new FormulaError('invalid_distribution','手工布局必须完整且唯一地覆盖设备组成员');
      for(const m of distribution.members){if(m.localShape.length>32||new Set(m.localShape.map(a=>a.axisId)).size!==m.localShape.length)throw new FormulaError('invalid_distribution','手工局部张量轴重复或超过预算');const local=m.localShape.map(a=>numericValue(a.size,'count',context,true));add(m.deviceId,local,local,[],m.copies,m.localShape);}
    }else{
      const mesh=group.mesh;if(!mesh)throw new FormulaError('invalid_distribution','分片需要完整的设备 mesh');
      if(new Set(distribution.axes.map(a=>a.tensorAxisId)).size!==distribution.axes.length||new Set(distribution.axes.map(a=>a.meshAxisId)).size!==distribution.axes.length)throw new FormulaError('invalid_distribution','一个逻辑轴和 mesh 轴不能重复用于多个分片维度');
      const mappings=distribution.axes.map(a=>{const axis=original.findIndex(s=>s.axisId===a.tensorAxisId),meshAxis=mesh.axes.findIndex(s=>s.axisId===a.meshAxisId);if(axis<0||meshAxis<0)throw new FormulaError('invalid_distribution','分片引用的张量轴或 mesh 轴不存在');return {axis,meshAxis};});
      const policy=distribution.policy,rectangles=new Map<string,TensorPartitionResult['placements'][number]['slices']>();
      if(policy.kind==='explicit'){
        if(policy.slices.length!==group.members.length*mappings.length||policy.slices.some(s=>!group.members.includes(s.deviceId)||!distribution.axes.some(a=>a.tensorAxisId===s.axisId)))throw new FormulaError('invalid_distribution','显式切片必须为每个设备的每个分片轴提供且只提供一项');
      }
      for(const id of group.members){const coordinate=mesh.coordinates.find(c=>c.deviceId===id);if(!coordinate)throw new FormulaError('invalid_distribution','设备缺少 mesh 坐标');const local=[...sizes],allocated=[...sizes],slices=fullSlices.map(s=>({...s}));
        const observedAxes=observer?.deviceId===id?new Map<string,PartitionOperation>():undefined;
        for(const {axis,meshAxis} of mappings){const extent=sizes[axis]??0,width=mesh.axes[meshAxis]?.size??1,rank=coordinate.coordinates[meshAxis]??0;let start:number,end:number,physical:number;
          if(policy.kind==='explicit'){const matches=policy.slices.filter(s=>s.deviceId===id&&s.axisId===original[axis]?.axisId),s=matches[0];if(matches.length!==1||!s||s.end<=s.start||s.end>extent)throw new FormulaError('invalid_distribution','显式切片重复、为空或超出逻辑维度');start=s.start;end=s.end;physical=end-start;}
          else {if(policy.kind==='even'&&extent%width!==0)throw new FormulaError('invalid_distribution','均匀分片要求逻辑维度可整除 mesh 大小；请显式选择 padded 或切片');physical=Math.ceil(extent/width);start=Math.min(extent,rank*physical);end=Math.min(extent,start+physical);}
          local[axis]=end-start;allocated[axis]=physical;slices[axis]={axisId:original[axis]?.axisId??'',start,end,paddedExtent:physical};
          const axisId=original[axis]?.axisId??'';
          observedAxes?.set(axisId,{kind:'axis',axisId,method:policy.kind,extent,start,end,logical:end-start,allocated:physical,mesh:{axisId:mesh.axes[meshAxis]?.axisId??'',width,rank}});
        }
        add(id,local,allocated,slices,1,original,observedAxes);
        if(policy.kind==='explicit'){const shardCoordinate=mappings.map(m=>coordinate.coordinates[m.meshAxis]).join(','),prior=rectangles.get(shardCoordinate);if(prior&&canonical(prior)!==canonical(slices))throw new FormulaError('invalid_distribution','未分片 mesh 轴上的物理副本必须引用相同切片');rectangles.set(shardCoordinate,slices);}
      }
      if(policy.kind==='explicit'){
        const boxes=[...rectangles.values()];let volume=0;
        for(let i=0;i<boxes.length;i++){const a=boxes[i];if(!a)continue;volume=exact(volume+elements(a.map(s=>s.end-s.start)));for(let j=0;j<i;j++){const b=boxes[j];if(b&&a.every((s,k)=>Math.min(s.end,b[k]?.end??0)>Math.max(s.start,b[k]?.start??0)))throw new FormulaError('invalid_distribution','显式切片的不同分片坐标发生重叠');}}
        if(volume!==globalElements)throw new FormulaError('invalid_distribution','显式切片未完整覆盖逻辑张量');
        emit?.({kind:'explicit_coverage',rectangles:boxes.length,covered:volume,globalElements});
      }
    }
    return TensorPartitionAttempt.parse({status:'available',result:{tensorId:tensor.tensorId,dtype:tensor.dtype,groupId:group.groupId,distribution,globalShape,coverage:distribution.kind==='manual'?'manual':distribution.kind==='partial'?'partial':distribution.kind==='sharded'&&distribution.policy.kind==='padded'?'padded':'exact',placements,diagnostics}});
  }catch(e){diagnostics.push({diagnosticId:'partition-failure',severity:'error',code:e instanceof FormulaError?e.code:'invalid_distribution',message:e instanceof Error?e.message:'张量分布失败',location:{kind:'file',name:'tensor-partition'}});return TensorPartitionAttempt.parse({status:'unavailable',diagnostics});}
}
