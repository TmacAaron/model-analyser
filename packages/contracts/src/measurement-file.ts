import { parseCsv } from './csv.js';
import { DecodeMeasurementsRequest,MeasurementFile,MeasurementRecord,type Diagnostic } from './index.js';
import { canonical } from './validation.js';

export const measurementCsvColumns=['measurementId','scenarioId','inputHash','targetKind','nodeId','eventName','eventSource','phase','deviceIds','interval','count','timeKind','seconds','startSeconds','endSeconds','readBytes','writeBytes','bytesBasis','sourceKind','sourceFile','eventId','mappingBasis','importedFrom'] as const;
const required=['measurementId','scenarioId','targetKind','phase','deviceIds','interval','count','timeKind'];
export function measurementProblems(m:MeasurementRecord):{code:Diagnostic['code'];message:string}[]{
  const issues:{code:Diagnostic['code'];message:string}[]=[],add=(code:string,message:string)=>issues.push({code,message});
  if(new Set(m.deviceIds).size!==m.deviceIds.length)add('duplicate_id','测量设备 ID 重复');
  if(m.time.kind==='single'&&m.count!==1)add('unknown_measurement_scope','single 要求 count=1');
  const seconds=m.time.kind==='span'?m.time.endSeconds-m.time.startSeconds:m.time.seconds,interval=m.time.kind==='mean'?seconds*m.count:seconds,perCall=m.time.kind==='span'||m.time.kind==='sum'?seconds/m.count:seconds;
  if(!Number.isFinite(interval)||!Number.isFinite(perCall)||interval<=0||perCall<=0)add('invalid_measurement_time','测量时间归一化必须为正有限数，span 的结束必须晚于开始');
  if(m.actualBytes){const bytes=m.actualBytes.readBytes+m.actualBytes.writeBytes;if(!Number.isFinite(bytes)||bytes>0&&m.actualBytes.basis==='interval_total'&&bytes/m.count===0)add('numeric_overflow','测量字节合计或按次数归一化超出数值范围');}
  return issues;
}
export function checkMeasurementFile(value:unknown):MeasurementFile{
  const file=MeasurementFile.parse(value),seen=new Set<string>();for(const [i,m] of file.records.entries()){if(seen.has(m.measurementId))throw Error(`记录 ${i+1} 的 measurementId 重复：${m.measurementId}`);seen.add(m.measurementId);const issues=measurementProblems(m);if(issues.length)throw Error(`记录 ${i+1}：${issues.map(i=>i.message).join('；')}`);}return file;
}
const number=(value:string,label:string)=>{if(!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value))throw Error(label+' 必须是十进制数，不接受空值、单位后缀或数字分隔符');const n=Number(value);if(!Number.isFinite(n)||n===0&&/[1-9]/.test(value.split(/[eE]/)[0]??''))throw Error(label+' 超出有限非零数值范围');return n;};
export function decodeMeasurements(input:DecodeMeasurementsRequest):MeasurementFile{
  const request=DecodeMeasurementsRequest.parse(input);if(new TextEncoder().encode(request.text).length>2*1024*1024)throw Error('测量文件超过 2 MiB');const text=request.text.replace(/^\uFEFF/,'');
  if(request.format==='json'){let parsed:unknown;try{parsed=JSON.parse(text) as unknown;}catch{throw Error('测量 JSON 无法解析');}const file=checkMeasurementFile(parsed);return MeasurementFile.parse({...file,records:file.records.map(m=>({...m,source:{...m.source,importedFrom:request.sourceName}}))});}
  const table=parseCsv(text,{maxRows:1001,maxColumns:measurementCsvColumns.length}),header=table[0]?.cells;if(!header)throw Error('CSV 缺少表头');if(new Set(header).size!==header.length)throw Error('CSV 表头重复');const allowed=new Set<string>(measurementCsvColumns);if(header.some(c=>!allowed.has(c)))throw Error('CSV 未知列：'+header.filter(c=>!allowed.has(c)).join(', '));if(required.some(c=>!header.includes(c)))throw Error('CSV 缺少列：'+required.filter(c=>!header.includes(c)).join(', '));
  if(table.length<2||table.length>1001)throw Error('CSV 必须包含 1–1000 条测量');
  const records=table.slice(1).map(row=>{try{
    if(row.cells.length!==header.length)throw Error('列数与表头不一致');const fields=new Map(header.map((key,i)=>[key,row.cells[i]??''])),get=(key:string)=>fields.get(key)??'',numeric=(key:string)=>number(get(key),key),absent=(keys:string[])=>{if(keys.some(k=>get(k)!==''))throw Error('当前目标/时间类型不接受字段：'+keys.filter(k=>get(k)!=='').join(', '));};
    const kind=get('targetKind'),target=kind==='model'?(absent(['nodeId','eventName','eventSource']),{kind}):kind==='unmapped'?(absent(['nodeId']),{kind,eventName:get('eventName'),source:get('eventSource')}):(absent(['eventName','eventSource']),{kind,nodeId:get('nodeId')}),timeKind=get('timeKind'),time=timeKind==='span'?(absent(['seconds']),{kind:timeKind,startSeconds:numeric('startSeconds'),endSeconds:numeric('endSeconds')}):(absent(['startSeconds','endSeconds']),{kind:timeKind,seconds:numeric('seconds')});
    let deviceIds:unknown;try{deviceIds=JSON.parse(get('deviceIds')) as unknown;}catch{throw Error('deviceIds 必须是 JSON 字符串数组');}
    const hasBytes=['readBytes','writeBytes','bytesBasis'].some(k=>get(k)!=='');if(hasBytes&&['readBytes','writeBytes','bytesBasis'].some(k=>get(k)===''))throw Error('readBytes/writeBytes/bytesBasis 必须一起填写');
    return MeasurementRecord.parse({measurementId:get('measurementId'),scenarioId:get('scenarioId'),...(get('inputHash')?{inputHash:get('inputHash')}:{}),target,phase:get('phase'),deviceIds,interval:get('interval'),count:numeric('count'),time,...(hasBytes?{actualBytes:{readBytes:numeric('readBytes'),writeBytes:numeric('writeBytes'),basis:get('bytesBasis')}}:{}),source:{kind:get('sourceKind')||'import',...(get('sourceFile')?{file:get('sourceFile')}:!get('sourceKind')||get('sourceKind')==='import'?{file:request.sourceName}:{}),...(get('eventId')?{eventId:get('eventId')}:{}),...(get('mappingBasis')?{mappingBasis:get('mappingBasis')}:{}),importedFrom:request.sourceName}});
  }catch(e){throw Error(`CSV 第 ${row.line} 行：${e instanceof Error?e.message:'无效记录'}`);}});
  return checkMeasurementFile({documentType:'measurements',schemaVersion:1,records});
}
export function encodeMeasurements(records:MeasurementRecord[],format:'csv'|'json'):string{
  const file=checkMeasurementFile({documentType:'measurements',schemaVersion:1,records});if(format==='json')return JSON.stringify(file,null,2)+'\n';
  const quote=(v:string)=>'"'+v.replaceAll('"','""')+'"';return [measurementCsvColumns.join(','),...file.records.map(m=>{const values:Record<string,string|number>={measurementId:m.measurementId,scenarioId:m.scenarioId,inputHash:m.inputHash??'',targetKind:m.target.kind,phase:m.phase,deviceIds:JSON.stringify(m.deviceIds),interval:m.interval,count:m.count,timeKind:m.time.kind,sourceKind:m.source.kind,sourceFile:m.source.file??'',eventId:m.source.eventId??'',mappingBasis:m.source.mappingBasis??'',importedFrom:m.source.importedFrom??''};if(m.target.kind==='node'||m.target.kind==='module')values.nodeId=m.target.nodeId;if(m.target.kind==='unmapped'){values.eventName=m.target.eventName;values.eventSource=m.target.source;}if(m.time.kind==='span'){values.startSeconds=m.time.startSeconds;values.endSeconds=m.time.endSeconds;}else values.seconds=m.time.seconds;if(m.actualBytes){values.readBytes=m.actualBytes.readBytes;values.writeBytes=m.actualBytes.writeBytes;values.bytesBasis=m.actualBytes.basis;}return measurementCsvColumns.map(c=>quote(String(values[c]??''))).join(',');})].join('\r\n')+'\r\n';
}
export function sameMeasurement(a:MeasurementRecord,b:MeasurementRecord):boolean{const value=(m:MeasurementRecord)=>{const {importedFrom,...source}=m.source;void importedFrom;return {...m,source};};return canonical(value(a))===canonical(value(b));}
export function mergeMeasurements(existing:MeasurementRecord[],incoming:MeasurementRecord[]):MeasurementRecord[]{
  checkMeasurementFile({documentType:'measurements',schemaVersion:1,records:incoming});const result=[...existing.map(m=>MeasurementRecord.parse(m))],byId=new Map(result.map(m=>[m.measurementId,m]));for(const m of incoming){const old=byId.get(m.measurementId);if(old&&!sameMeasurement(old,m))throw Error('同 ID 测量内容冲突，不能覆盖：'+m.measurementId);if(!old){result.push(m);byId.set(m.measurementId,m);}}return result;
}
