import { AssetDocument } from '@model-analyser/contracts';
import lock from '../references/hardware/source-lock.json';
import { fp8,fp8Matrix,matrix,vector } from './model-authoring.js';

export function makeHardwareAssets():AssetDocument[]{
  const document=(id:string)=>{const doc=lock.documents.find(d=>d.id===id);if(!doc)throw Error('Missing hardware source '+id);return doc;};
  const fact=(id:string,key:string)=>{const value=Object.entries(document(id).facts).find(([k])=>k===key)?.[1];if(typeof value!=='number'||!Number.isFinite(value)||value<=0)throw Error('Missing positive source fact '+id+'.'+key);return value;};
  const a=document('a100-datasheet'),hc=document('h100-whitepaper'),hm=document('h100-datasheet');
  return [{id:'a100-sxm-80gb',name:'NVIDIA A100 80GB SXM · dense peak',capacity:fact('a100-datasheet','capacityGB')*1e9,compute:fact('a100-datasheet','bf16DenseTFLOPS')*1e12,fp16:fact('a100-datasheet','fp16DenseTFLOPS')*1e12,vector:fact('a100-datasheet','fp32NonTensorTFLOPS')*1e12,hbm:fact('a100-datasheet','hbmGBPerSecond')*1e9,documents:[a,hc],note:'A100 SXM 80GB datasheet: BF16/FP16 dense 312 TFLOPS, FP32 non-Tensor 19.5 TFLOPS, HBM 2039 GB/s. FP32 accumulation semantics cross-checked against H100 whitepaper Table 3; its A100 memory column is not used.'},
      {id:'h100-sxm-80gb',name:'NVIDIA H100 80GB SXM · dense peak',capacity:fact('h100-datasheet','capacityGB')*1e9,compute:fact('h100-whitepaper','bf16DenseFp32AccumulateTFLOPS')*1e12,fp16:fact('h100-whitepaper','fp16DenseFp32AccumulateTFLOPS')*1e12,vector:fact('h100-whitepaper','fp32NonTensorTFLOPS')*1e12,hbm:fact('h100-datasheet','hbmTBPerSecond')*1e12,documents:[hc,hm],note:'H100 SXM5 dense FP16/BF16 with FP32 accumulation 989.4 TFLOPS and non-Tensor FP32 66.9 TFLOPS from whitepaper v1.04 Table 3. Memory 80GB/3.35TB/s from Sep24 SXM datasheet; rounded sparse headlines and NVL values are not used.'}].map(p=>AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'builtin:hardware:nvidia-'+p.id,revision:1,name:p.name,description:'Full-device theoretical nameplate profile; decimal capacity assumption; no measured or collective performance claim.',tags:['hardware','nvidia',p.id,'dense','source-checked-2026-11-14'],parameters:[],sources:[...p.documents.map(d=>({kind:'url',url:d.url,checkedOn:lock.checkedOn})),{kind:'note',text:p.note},...lock.assumptions.map(text=>({kind:'note',text})),{kind:'note',text:'Homogeneous inputDtypes listed once or as two operands are explicit equivalent precision entries. No mixed-type matching or input-count multiplier is inferred.'},...p.documents.map(d=>({kind:'note',text:`Source ${d.id}, page ${d.page}, SHA256 ${d.sha256}; fact lock references/hardware/source-lock.json.`}))],definition:{kind:'hardware',hardware:{capacityBytes:p.capacity,computeCapabilities:[...['bf16','fp16'].flatMap(format=>[1,2].map(count=>({computeClass:{...matrix,inputDtypes:Array.from({length:count},()=>({category:'float',bits:16,format})),multiplyDtype:{category:'float',bits:16,format}},kind:'peak',operationsPerSecond:format==='bf16'?p.compute:p.fp16}))),{computeClass:vector,kind:'peak',operationsPerSecond:p.vector}],memoryCapabilities:[{key:'hbm',kind:'peak',bytesPerSecond:p.hbm}],communicationDefaults:[]}}}));
}

export function makeH100FP8HardwareAsset():AssetDocument {
  const baseline=makeHardwareAssets().find(asset=>asset.assetId==='builtin:hardware:nvidia-h100-sxm-80gb');
  const source=lock.documents.find(doc=>doc.id==='h100-whitepaper');
  const rate=source?.facts.fp8DenseFp32AccumulateTFLOPS;
  if(baseline?.definition.kind!=='hardware'||!rate)throw Error('Missing H100 FP8 source fact');
  const {hardware}=baseline.definition;
  return AssetDocument.parse({...baseline,revision:2,name:'NVIDIA H100 80GB SXM · FP8',sources:[...baseline.sources,
    {kind:'note',text:'H100 SXM5 FP8 E4M3FN dense Tensor Core throughput with FP32 accumulation is 1978.9 TFLOPS, whitepaper v1.04 Table 3.'}],
    definition:{kind:'hardware',hardware:{...hardware,computeCapabilities:[...hardware.computeCapabilities,...[1,2].map(count=>({
      computeClass:{...fp8Matrix,inputDtypes:Array.from({length:count},()=>fp8)},kind:'peak',operationsPerSecond:rate*1e12,
    }))]}}});
}
