import type { DeviceTopology,StorageSpec,TensorDistribution } from '@model-analyser/contracts';
import { allocateStorage } from './storage.js';
import { allocateDistributedStorage } from './distributed-storage.js';
import { stableStringify } from './input-hash.js';

export type SlotRows={kind:'grouped';tokensPerRow:number}|{kind:'fixed';rows:number};
export const slotRows=(tokens:number,rows:SlotRows|undefined)=>rows?.kind==='fixed'?rows.rows:rows?Math.floor(tokens/rows.tokensPerRow):tokens;
export type SlotStorage={spec:StorageSpec&{allocation:Extract<StorageSpec['allocation'],{kind:'tensor'}>};tokenAxis:string;rows?:SlotRows;distribution?:TensorDistribution};
export type DeviceBudget={deviceId:string;capacityBytes:number;nonKvBytes:number;currentKvBytes:number};

const sum=(a:number,b:number)=>{
  const value=a+b;
  if(!Number.isSafeInteger(value)||value<0)throw Error('KV 分配超出精确整数范围。');
  return value;
};

function gcd(a:number,b:number):number{
  while(b)[a,b]=[b,a%b];
  return a;
}

/** Resizes only the declared token axis, holding the captured allocation rules fixed. */
export function solveKvSlots(rows:SlotStorage[],topology:DeviceTopology,devices:DeviceBudget[],reference:number){
  let stride=1;
  for(const {distribution,tokenAxis,spec,rows:rowRule} of rows){
    if(spec.allocation.quantization?.auxiliaries.some(auxiliary=>auxiliary.count.kind==='formula')){
      throw Error('自定义量化辅助数据公式随长度的变化尚未验证。');
    }
    if(distribution?.kind==='manual'||distribution?.kind==='partial'){
      throw Error('手工或 partial 缓存布局需要明确的可伸缩 token 分配规则。');
    }
    if(distribution?.kind!=='sharded')continue;
    const axis=distribution.axes.find(axis=>axis.tensorAxisId===tokenAxis);
    if(!axis)continue;
    if(rowRule?.kind==='fixed')continue;
    if(distribution.policy.kind==='explicit')throw Error('显式 token 切片未定义延伸到其他长度的规则。');
    if(distribution.policy.kind==='even'){
      if(rowRule)throw Error('压缩行的均匀分片尚未声明可伸缩的逻辑长度。');
      const width=topology.groups.find(group=>group.groupId===distribution.groupId)?.mesh?.axes.find(mesh=>mesh.axisId===axis.meshAxisId)?.size;
      if(!width)throw Error('均匀 token 分片缺少 mesh 大小。');
      stride=sum(0,stride/gcd(stride,width)*width);
    }
  }
  if(reference%stride!==0)throw Error('参考长度与当前 token 分片的对齐要求不同。');
  const context={symbols:{},assets:[]};
  const profiles=new Map<string,{storage:SlotStorage;copies:number}>();
  for(const storage of rows){
    const key=stableStringify([storage.spec.allocation,storage.tokenAxis,storage.rows??null,storage.distribution??null]);
    const known=profiles.get(key);
    if(known)known.copies++;
    else profiles.set(key,{storage,copies:1});
  }
  function bytes(tokens:number){
    const byDevice=new Map(devices.map(row=>[row.deviceId,0]));
    for(const {storage:{spec,distribution,tokenAxis,rows},copies} of profiles.values()){
      const candidate:StorageSpec={...spec,allocation:{...spec.allocation,
        shape:spec.allocation.shape.map(axis=>axis.axisId===tokenAxis?{...axis,size:{kind:'literal',quantity:{value:slotRows(tokens,rows),unit:'count'}}}:axis)}};
      if(distribution){
        const allocation=allocateDistributedStorage(spec.storageId,[candidate],distribution,topology,context);
        if(allocation.status!=='available')throw Error(allocation.diagnostics[0]?.message??'无法重算缓存分片。');
        for(const row of allocation.result.perDevice){
          const total=byDevice.get(row.deviceId);
          if(total===undefined||row.totalBytes.status!=='available')throw Error('缓存分片无法得到完整的逐卡字节数。');
          byDevice.set(row.deviceId,sum(total,row.totalBytes.quantity.value*copies));
        }
      }else{
        const device=devices[0];
        const allocation=allocateStorage(spec.storageId,[candidate],context);
        if(devices.length!==1||!device||allocation.totalBytes.status!=='available')throw Error('缓存缺少有效的物理分配。');
        byDevice.set(device.deviceId,sum(byDevice.get(device.deviceId)??0,allocation.totalBytes.quantity.value*copies));
      }
    }
    return byDevice;
  }
  const baseline=bytes(reference);
  if(devices.some(device=>baseline.get(device.deviceId)!==device.currentKvBytes)){
    throw Error('伸缩后的分配无法复现当前逐卡缓存占用。');
  }
  const next=bytes(sum(reference,stride));
  const more=devices.map(device=>({deviceId:device.deviceId,bytes:(next.get(device.deviceId)??0)-device.currentKvBytes}));
  if(devices.some(device=>device.nonKvBytes>device.capacityBytes)){
    return {status:'no_room' as const,reason:'non_kv' as const,stride,more,limitingDeviceIds:devices.filter(device=>device.nonKvBytes>device.capacityBytes).map(device=>device.deviceId)};
  }
  // For this fixed profile, the supported sharding, packing and auxiliary rules are nondecreasing.
  const findOver=(counts:Map<string,number>)=>devices.filter(device=>(counts.get(device.deviceId)??0)>device.capacityBytes-device.nonKvBytes).map(device=>device.deviceId);
  const fixedOver=findOver(bytes(0));
  if(fixedOver.length)return {status:'no_room' as const,reason:'fixed_cache' as const,stride,more,limitingDeviceIds:fixedOver};
  if(rows.every(row=>row.rows?.kind==='fixed'))return {status:'fixed' as const,stride,more};
  let left=0,right=Math.max(1,reference/stride);
  let over=findOver(bytes(sum(0,right*stride)));
  while(!over.length){
    left=right;right=sum(right,right);
    over=findOver(bytes(sum(0,right*stride)));
  }
  while(right-left>1){
    const midpoint=left+Math.floor((right-left)/2);
    const tested=findOver(bytes(midpoint*stride));
    if(tested.length){right=midpoint;over=tested;}
    else left=midpoint;
  }
  const maximum=left*stride;
  return {status:'available' as const,tokensPerRequest:maximum,stride,more,limitingDeviceIds:over};
}
