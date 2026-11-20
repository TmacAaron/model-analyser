import type {CostObservation} from './cost-observation.js';
// Bounded operation graph from actual evaluateCost observations.
import type {CostResult,MetricValue,Quantity} from '@model-analyser/contracts';
type Unit=Quantity['unit'];
export type TraceNumber=number|'positive_infinity'|'negative_infinity'|'nan'|'negative_zero';
export type TimingNode={id:string;operation:'input'|'literal'|'return'|'zero_when_work_zero'|'multiply'|'divide'|'log'|'subtract'|'exp'|'sum'|'max';inputs:string[];value:TraceNumber;unit:Unit;source?:Record<string,unknown>};
export type TimingDag={nodes:TimingNode[];root?:string;completeTiming:boolean;truncated:boolean;guards:Record<string,unknown>[];errors:{code:string;message:string}[]};
export function pack(value:number):TraceNumber{if(Number.isNaN(value))return 'nan';if(value===Infinity)return 'positive_infinity';if(value===-Infinity)return 'negative_infinity';if(Object.is(value,-0))return 'negative_zero';return value;}
export function unpack(value:TraceNumber){return typeof value==='number'?value:value==='positive_infinity'?Infinity:value==='negative_infinity'?-Infinity:value==='negative_zero'?-0:NaN;}
type MetricInput={timingNodeId:string;quantity:Quantity}&(
 {field:'hbmBytes'}|{field:'executedOperations';computeIndex:number;computeClass:CostResult['compute'][number]['computeClass'];segmentId:string}
);

/** Connect recorded inputs to their original cost field, including unmerged segments. */
export function rooflineMetricInputs(dag:TimingDag,cost:CostResult,segmentIdAt:(index:number)=>string|undefined){
 const inputs:MetricInput[]=[];
 for(const node of dag.nodes){
  const source=node.source;
  if(source?.['kind']!=='metric_boundary')continue;
  function quantity(metric:MetricValue){
   if(metric.status!=='available'||metric.quantity.unit!==node.unit||metric.quantity.value!==unpack(node.value))throw Error('Roofline 读取值与同设备的实际指标不同');
   return metric.quantity;
  }
  if(source['field']==='hbmBytes'){
   inputs.push({timingNodeId:node.id,field:'hbmBytes',quantity:quantity(cost.hbmBytes)});
   continue;
  }
  const index=source['evaluationIndex'];
  if(typeof index!=='number'||!Number.isSafeInteger(index)||index<0)throw Error('Roofline 缺少实际计算段序号');
  const segmentId=segmentIdAt(index),segment=cost.compute[index];
  if(segmentId===undefined||!segment||source['field']!==`compute[${JSON.stringify(segmentId)}].executedOperations`)throw Error('Roofline 的原始计算段位置不同');
  inputs.push({timingNodeId:node.id,field:'executedOperations',computeIndex:index,computeClass:segment.computeClass,segmentId,quantity:quantity(segment.executedOperations)});
 }
 return inputs;
}

function number(event:Record<string,unknown>,key:string){const value=event[key];if(typeof value!=='number')throw Error('Missing recorded number '+key);return value;}
function string(event:Record<string,unknown>,key:string){const value=event[key];if(typeof value!=='string')throw Error('Missing recorded string '+key);return value;}
function origin(event:Record<string,unknown>){const value=event['origin'];if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Missing actual duration origin');return value as Record<string,unknown>;}
function key(event:Record<string,unknown>){const o=origin(event);return o['kind']==='memory'?'hbm':o['kind']==='compute'&&typeof o['segmentId']==='string'?'compute['+JSON.stringify(o['segmentId'])+']':(()=>{throw Error('Unidentified recorded computation');})();}
/** Builds edges from explicit recorded roles/indices, never by equal numbers. */
export function timingDag(events:readonly CostObservation[],limit=256):TimingDag{
 if(!Number.isSafeInteger(limit)||limit<1||limit>256)throw Error('耗时来源节点预算须为1至256');
 const nodes:TimingNode[]=[],ids=new Set<string>(),guards:Record<string,unknown>[]=[],errors:{code:string;message:string}[]=[],durations=new Map<number,string|undefined>(),fallbacks=new Map<string,Record<string,unknown>>();let truncated=false,sum:string|undefined,memory:string|undefined,combined:string|undefined,root:string|undefined;
 function add(id:string,operation:TimingNode['operation'],inputs:(string|undefined)[],value:number,unit:Unit,source?:Record<string,unknown>){if(truncated)return undefined;if(nodes.length>=limit){truncated=true;return undefined;}if(inputs.some(i=>i===undefined||!ids.has(i)))return undefined;if(ids.has(id))throw Error('Duplicate observation identity '+id);ids.add(id);nodes.push({id,operation,inputs:inputs as string[],value:pack(value),unit,...(source?{source}:{})});return id;}
 for(const event of events){const kind=event.kind;
  if(kind==='error'){errors.push({code:string(event,'code'),message:string(event,'message')});continue;}
  if(kind==='compute_capability'||kind==='memory_capability'){const matches=event.matches;if(guards.length>=limit){truncated=true;continue;}guards.push({kind,...(kind==='compute_capability'?{segmentId:event.segmentId,computeClass:event.computeClass}:{}),matchingCount:event.matchingCount,matches:matches.slice(0,2),declaredEfficiency:event.declaredEfficiency});continue;}
  if(kind==='log_fallback'){fallbacks.set(key(event),event);continue;}
  if(kind==='duration'){
   const o=origin(event),field=key(event),workUnit:Unit=o['kind']==='memory'?'byte':'operation',capacityUnit:Unit=o['kind']==='memory'?'byte_per_second':'operation_per_second';
   if(typeof o['capabilityIndex']!=='number'||o['capabilityIndex']<0)throw Error('No actual hardware capability index');
   const work=add(field+'.work','input',[],number(event,'work'),workUnit,{kind:'metric_boundary',field:o['kind']==='memory'?'hbmBytes':field+'.executedOperations',...(o['evaluationIndex']===undefined?{}:{evaluationIndex:o['evaluationIndex']})}),capacity=add(field+'.capacity','input',[],number(event,'peak'),capacityUnit,{kind:'hardware_field',capabilityIndex:o['capabilityIndex'],capabilityKind:o['capabilityKind'],field:o['kind']==='memory'?'memoryCapabilities.bytesPerSecond':'computeCapabilities.operationsPerSecond',...(o['computeClass']===undefined?{}:{computeClass:o['computeClass']})}),efficiency=add(field+'.efficiency',o['capabilityKind']==='effective'?'literal':'input',[],number(event,'efficiency'),'ratio',{kind:o['capabilityKind']==='effective'?'effective_capacity_no_extra_factor':'timing_field',field:o['kind']==='memory'?'memoryEfficiency':'computeEfficiency'});
   let duration:string|undefined;
   if(event['method']==='zero')duration=add(field+'.seconds','zero_when_work_zero',[work],number(event,'seconds'),'second',{skipped:['multiply','divide','log','exp']});
   else{
    const denominator=add(field+'.denominator','multiply',[capacity,efficiency],number(event,'denominator'),capacityUnit),direct=add(field+'.direct','divide',[work,denominator],number(event,'direct'),'second');
    if(event['method']==='division')duration=add(field+'.seconds','return',[direct],number(event,'seconds'),'second');
    else if(event['method']==='log_fallback'){
     const f=fallbacks.get(field);if(!f)throw Error('Missing actual log fallback');
     const logWork=add(field+'.logWork','log',[work],number(f,'logWork'),'scalar'),logCapacity=add(field+'.logCapacity','log',[capacity],number(f,'logPeak'),'scalar'),logEfficiency=add(field+'.logEfficiency','log',[efficiency],number(f,'logEfficiency'),'scalar'),first=add(field+'.logDifference1','subtract',[logWork,logCapacity],number(f,'firstDifference'),'scalar'),second=add(field+'.logDifference2','subtract',[first,logEfficiency],number(f,'logSeconds'),'scalar');duration=add(field+'.seconds','exp',[second],number(event,'seconds'),'second',{reason:'direct result was zero or nonfinite',directAttempt:direct});
    }else throw Error('Unknown recorded duration branch');
   }
   if(o['kind']==='memory')memory=duration;else{if(typeof o['evaluationIndex']!=='number')throw Error('Missing actual compute evaluation index');durations.set(o['evaluationIndex'],duration);}continue;
  }
  if(kind==='sum_step'){
   if(event['field']!=='compute_seconds')throw Error('Unknown observed sum');const index=number(event,'index');if(index===0)sum=add('compute_seconds.identity','literal',[],0,'second',{kind:'empty_sum_identity'});sum=add('compute_seconds.step['+index+']','sum',[sum,durations.get(index)],number(event,'value'),'second',{index,recordedLeft:pack(number(event,'left')),recordedRight:pack(number(event,'right'))});continue;
  }
  if(kind==='sum_complete'){
   if(event['field']!=='compute_seconds')throw Error('Unknown sum completion');if(number(event,'count')===0)sum=add('compute_seconds.identity','literal',[],0,'second',{kind:'empty_sum_identity'});sum=add('compute_seconds.total','return',[sum],number(event,'value'),'second',{count:number(event,'count')});continue;
  }
  if(kind==='overlap'){const operation=event['operation'];if(operation!=='max'&&operation!=='sum')throw Error('Unknown overlap branch');combined=add('timing.overlap',operation,[sum,memory],number(event,'value'),'second');continue;}
  if(kind==='launch'){const launch=add('timing.launch','input',[],number(event,'launchSeconds'),'second',{kind:'timing_field',field:'launchSeconds'});root=add('timing.seconds','sum',[combined,launch],number(event,'seconds'),'second');continue;}
  throw Error('Unknown timing observation '+kind);
 }
 const dag:TimingDag={nodes,...(root?{root}:{}),completeTiming:!!root&&!truncated&&errors.length===0,truncated,guards,errors};validateTimingDag(dag);return dag;
}
/** Numerical consistency only; authentic source consistency still requires replay. */
export function validateTimingDag(dag:TimingDag){
 const values=new Map<string,number>();for(const node of dag.nodes){if(values.has(node.id))throw Error('Duplicate DAG node');const inputs=node.inputs.map(id=>{if(!values.has(id))throw Error('Missing earlier DAG operand '+id);return values.get(id)??NaN;}),n=unpack(node.value);let computed:number;
  switch(node.operation){case'input':case'literal':if(inputs.length)throw Error('Input has operands');computed=n;break;case'return':if(inputs.length!==1)throw Error('Invalid return');computed=inputs[0]??NaN;break;case'zero_when_work_zero':if(inputs.length!==1||inputs[0]!==0)throw Error('False zero-work branch');computed=0;break;case'multiply':if(inputs.length!==2)throw Error('Invalid multiplication');computed=(inputs[0]??NaN)*(inputs[1]??NaN);break;case'divide':if(inputs.length!==2)throw Error('Invalid division');computed=(inputs[0]??NaN)/(inputs[1]??NaN);break;case'log':if(inputs.length!==1)throw Error('Invalid log');computed=Math.log(inputs[0]??NaN);break;case'subtract':if(inputs.length!==2)throw Error('Invalid subtraction');computed=(inputs[0]??NaN)-(inputs[1]??NaN);break;case'exp':if(inputs.length!==1)throw Error('Invalid exp');computed=Math.exp(inputs[0]??NaN);break;case'sum':if(inputs.length!==2)throw Error('Invalid addition');computed=(inputs[0]??NaN)+(inputs[1]??NaN);break;case'max':if(inputs.length!==2)throw Error('Invalid max');computed=Math.max(inputs[0]??NaN,inputs[1]??NaN);break;default:throw Error('Invalid operation');}
  if(!Object.is(computed,n))throw Error('Recorded operand/result mismatch at '+node.id);if(node.operation==='sum'&&node.source?.['recordedLeft']!==undefined){if(!Object.is(inputs[0],unpack(node.source['recordedLeft'] as TraceNumber))||!Object.is(inputs[1],unpack(node.source['recordedRight'] as TraceNumber)))throw Error('Recorded sum order mismatch');}values.set(node.id,n);
 }
 if(dag.root&&!values.has(dag.root))throw Error('Missing timing root');if(dag.completeTiming&&(!dag.root||dag.truncated||dag.errors.length))throw Error('False timing completion');return dag;
}
