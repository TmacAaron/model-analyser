import { AssetDocument,Scenario,DecodeStepContext,type AssetRef,type CostDefinition,type GraphTemplate,type LocalCostRule } from '@model-analyser/contracts';
import { collectRefs,canonical,completeAssetSnapshots } from '../../contracts/src/validation.js';
import { FormulaError } from './formula.js';

/** Deterministic UTF-16 key ordering, independent of locale/Intl implementation. */
export function stableStringify(value:unknown):string{
  if(typeof value==='number'&&!Number.isFinite(value))throw new FormulaError('invalid_input','hash 输入不能包含非有限数');
  if(value===null||typeof value!=='object'){const text=JSON.stringify(value);if(text===undefined)throw new FormulaError('invalid_input','非 JSON hash 输入');return text;}
  if(Array.isArray(value))return '['+value.map(stableStringify).join(',')+']';
  return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+stableStringify(v)).join(',')+'}';
}
const timing=(value:CostDefinition['timing'])=>{if(value.kind==='roofline_bound')return value;const {description,...rest}=value;void description;return rest;};
const cost=(value:CostDefinition)=>({...value,timing:timing(value.timing)});
const localCost=(value:LocalCostRule)=>{const {description,...rest}=value;void description;return {...rest,cost:cost(value.cost)};};
function graph(value:GraphTemplate){return {...value,
  nodes:value.nodes.map(({name,body,...node})=>{void name;return {...node,body:body.kind==='opaque'?{...body,cost:cost(body.cost),...(body.localCost?{localCost:localCost(body.localCost)}:{})}:body.kind==='collective'?{...body,communication:{...body.communication,timing:body.communication.timing.kind==='bandwidth_latency'?body.communication.timing:timing(body.communication.timing)}}:body};}),
  tensors:value.tensors.map(({name,...t})=>{void name;return t;}),storages:value.storages.map(({name,...s})=>{void name;return s;}),states:value.states.map(({name,...s})=>{void name;return s;}),
};}
function assetInput(asset:AssetDocument){
  const d=asset.definition;let definition:unknown=d;
  if(d.kind==='model'||d.kind==='module')definition={...d,graph:graph(d.graph)};
  else if(d.kind==='operator'){const {operator:o}=d;definition={...d,operator:{...o,cost:cost(o.cost),...(o.localCost?{localCost:localCost(o.localCost)}:{}),tensors:o.tensors.map(({name,...t})=>{void name;return t;}),storages:o.storages.map(({name,...s})=>{void name;return s;}),states:o.states.map(({name,...s})=>{void name;return s;})}};}
  else if(d.kind==='formula'){const {description,...formula}=d.formula;void description;definition={kind:d.kind,formula};}
  else if(d.kind==='hardware')definition={...d,hardware:{...d.hardware,communicationDefaults:d.hardware.communicationDefaults.map(({description,...c})=>{void description;return c;})}};
  return {schemaVersion:asset.schemaVersion,assetId:asset.assetId,revision:asset.revision,parameters:asset.parameters.map(({name,description,...p})=>{void name;void description;return p;}),definition};
}
export function calculationInput(input:Scenario,library:AssetDocument[]):{scenario:Scenario;assets:AssetDocument[];canonicalInput:string}{
  const scenario=Scenario.parse(input),pool=library.map(a=>AssetDocument.parse(a)),selected=new Map<string,AssetDocument>();
  function visit(ref:AssetRef,stack:string[]){if(stack.length>64)throw new FormulaError('expansion_limit','计算输入引用深度超过预算');const key=ref.assetId+'@'+ref.revision;if(stack.includes(key))throw new FormulaError('dependency_cycle','计算输入包含循环引用');if(selected.has(key))return;
    const matches=pool.filter(a=>a.assetId===ref.assetId&&a.revision===ref.revision),asset=matches[0];if(!asset)throw new FormulaError('missing_reference',`缺少 ${key}`);
    if(matches.some(a=>canonical(a)!==canonical(asset)))throw new FormulaError('duplicate_id',`快照修订冲突 ${key}`);if(asset.definition.kind!==ref.kind)throw new FormulaError('reference_kind_mismatch',`引用类型不符 ${key}`);
    selected.set(key,asset);for(const child of collectRefs(asset.definition))visit(child,[...stack,key]);
  }
  const {ascendQuantizationImports,...mathScenario}=scenario;void ascendQuantizationImports;for(const ref of collectRefs(mathScenario))visit(ref,[]);
  const assets=[...selected.values()].sort((a,b)=>{const x=a.assetId+'@'+a.revision,y=b.assetId+'@'+b.revision;return x<y?-1:x>y?1:0;});
  const {name,...scenarioInput}=mathScenario;void name;
  const canonicalInput=stableStringify({scenario:{...scenarioInput,numericOverrides:scenario.numericOverrides.map(({description,...o})=>{void description;return o;}),fusionGroups:scenario.fusionGroups.map(g=>({...g,extraCost:cost(g.extraCost),...(g.extraLocalCost?{extraLocalCost:{...g.extraLocalCost,rule:localCost(g.extraLocalCost.rule)}}:{}),timeStrategy:g.timeStrategy.kind==='sum_members'?g.timeStrategy:{kind:'override',timing:timing(g.timeStrategy.timing)}}))},assets:assets.map(assetInput)});
  return {scenario,assets:completeAssetSnapshots(assets,pool),canonicalInput};
}
export async function computeInputHash(scenario:Scenario,assets:AssetDocument[],stepContext?:DecodeStepContext):Promise<string>{const base=calculationInput(scenario,assets).canonicalInput,input=stepContext?stableStringify({input:base,stepContext:DecodeStepContext.parse(stepContext)}):base;const hash=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(input));return [...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
