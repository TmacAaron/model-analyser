import { createHash } from 'node:crypto';
import { z } from 'zod';
import * as contracts from '../packages/contracts/src/index.js';
import { canonical } from '../packages/contracts/src/validation.js';
import { contractJsonSchema } from '../packages/contracts/src/json-schema.js';

type ObjectValue=Record<string,unknown>;
const object=(value:unknown):ObjectValue=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected schema object');return value as ObjectValue;};
const schema=(value:unknown):z.ZodType=>{if(!(value instanceof z.ZodType))throw Error('Unsupported non-classic Zod node');return value;};
export type NegativeProbe={kind:'json';value:unknown}|{kind:'undefined'};
export const probeValue=(probe:NegativeProbe):unknown=>probe.kind==='json'?probe.value:undefined;
export type CoverageFixture={schemaVersion:1;scope:string;roots:{name:string;valid:unknown;invalid:NegativeProbe}[];unions:{id:string;locations:string[];branches:{label:string;valid:unknown;invalid:NegativeProbe;invalidTag?:NegativeProbe}[]}[]};

export function contractRoots():Map<string,z.ZodType>{
  const roots=new Map<string,z.ZodType>();for(const [name,value] of Object.entries(contracts))if(value instanceof z.ZodType)roots.set(name,value);
  // The generic HTTP envelope is a factory rather than an exported schema value.
  for(const [name,data] of Object.entries({assets:z.array(contracts.AssetIndexEntry),asset:contracts.AssetDocument,drafts:z.array(contracts.AssetDraft),projects:z.array(contracts.ProjectDocument),project:contracts.ProjectDocument,projectDrafts:z.array(contracts.ProjectDraft),scan:contracts.ScanReport,catalog:contracts.WorkspaceCatalog,assetDraft:contracts.AssetDraft,projectDraft:contracts.ProjectDraft,snapshot:z.array(contracts.AssetDocument),decodeProject:contracts.ProjectImportDocument,decodeConfig:contracts.ConfigSource,decodeMeasurements:contracts.MeasurementFile,saveDraft:contracts.SaveDraftResponse,commit:contracts.CommitResponse,saveProject:contracts.SaveProjectResponse,saveProjectDraft:contracts.SaveProjectDraftResponse,ack:contracts.RequestAck,upgradePlan:contracts.DependencyUpgradePlan,upgradeOperation:contracts.DependencyUpgradeOperation,upgradeHistory:contracts.DependencyUpgradeHistory}))roots.set('HTTP.'+name,contracts.apiResponse(data));
  return new Map([...roots].sort(([a],[b])=>a<b?-1:a>b?1:0));
}

/** Discover every actual union, including nested/anonymous branches, from Zod. */
export function contractUnionInventory(roots=contractRoots()){
  const names=new Map<z.ZodType,string>();for(const [name,s] of roots)if(!names.has(s))names.set(s,name);
  const seen=new Set<z.ZodType>(),unions=new Map<string,{id:string;locations:string[];schema:z.ZodType;branches:z.ZodType[]}>();
  function visit(s:z.ZodType,path:string){if(seen.has(s))return;seen.add(s);path=names.get(s)??path;
    const branches=s instanceof z.ZodUnion?s.options.map(schema):s instanceof z.ZodNullable?[schema(s.unwrap()),z.null()]:undefined;
    if(branches){const json=z.toJSONSchema(s,{target:'draft-2020-12',unrepresentable:'throw'}),id=createHash('sha256').update(canonical(json)).digest('hex').slice(0,16),prior=unions.get(id);if(prior)prior.locations.push(path);else unions.set(id,{id,locations:[path],schema:s,branches});for(const [i,b] of branches.entries())visit(b,path+'.branch['+i+']');return;}
    if(s instanceof z.ZodObject){for(const [key,value] of Object.entries(s.shape))visit(schema(value),path+'.'+key);if(s.def.catchall)visit(schema(s.def.catchall),path+'.{extra}');return;}
    if(s instanceof z.ZodArray){visit(schema(s.element),path+'[]');return;}
    if(s instanceof z.ZodRecord){visit(schema(s.keyType),path+'.{key}');visit(schema(s.valueType),path+'.{value}');return;}
    if(s instanceof z.ZodTuple){s.def.items.forEach((item,i)=>visit(schema(item),path+'['+i+']'));if(s.def.rest)visit(schema(s.def.rest),path+'[]');return;}
    if(s instanceof z.ZodOptional||s instanceof z.ZodDefault||s instanceof z.ZodReadonly){visit(schema(s.unwrap()),path);return;}
    if(s instanceof z.ZodLazy){visit(schema(s.unwrap()),path+'.json');return;}
    if(s instanceof z.ZodIntersection){visit(schema(s.def.left),path+'.left');visit(schema(s.def.right),path+'.right');return;}
    if(!['string','number','boolean','literal','enum','null','never'].includes(s.type))throw Error('Add explicit union traversal for Zod node '+s.type+' at '+path);
  }
  for(const [name,s] of roots)visit(s,name);return [...unions.values()].sort((a,b)=>a.id.localeCompare(b.id,'en'));
}

/** Minimal STRUCTURAL examples, never a substitute for reference/graph semantics. */
export function structuralExample(s:z.ZodType):unknown{
  const root=object(contractJsonSchema(s));
  function at(ref:string):ObjectValue{if(ref==='#')return root;if(!ref.startsWith('#/'))throw Error('External schema ref forbidden');let current:unknown=root;for(const part of ref.slice(2).split('/').map(p=>p.replaceAll('~1','/').replaceAll('~0','~')))current=object(current)[part];return object(current);}
  function make(input:unknown,depth=0):unknown{
    if(depth>80)throw Error('Structural example exceeds recursion budget');const node=object(input);if(typeof node.$ref==='string'){const {$ref,...constraints}=node;return make({...at($ref),...constraints},depth+1);}
    if(Object.hasOwn(node,'const'))return node.const;if(Array.isArray(node.enum))return node.enum[0];
    const options=node.anyOf??node.oneOf;if(Array.isArray(options))return make(options[0],depth+1);
    if(Array.isArray(node.type)){return make({...node,type:node.type[0]},depth+1);}
    if(node.type==='object'){const properties=node.properties?object(node.properties):{},required=Array.isArray(node.required)?node.required:[];return Object.fromEntries(required.map(key=>{if(typeof key!=='string'||!properties[key])throw Error('Invalid required property');return [key,make(properties[key],depth+1)];}));}
    if(node.type==='array'){const count=typeof node.minItems==='number'?node.minItems:0;return Array.from({length:count},(_,i)=>make(Array.isArray(node.prefixItems)?node.prefixItems[i]:node.items,depth+1));}
    if(node.type==='string'){
      if(node.pattern===/^[a-f0-9]{64}$/.source)return '0'.repeat(64);
      if(node.pattern===/^(0|[1-9]\d{0,19})$/.source)return '0';
      if(node.format==='date-time')return '2026-11-14T00:00:00.000Z';if(node.format==='date')return '2026-11-14';if(node.format==='uri')return 'https://example.test/source';
      const value='x'.repeat(Math.max(1,typeof node.minLength==='number'?node.minLength:1));if(typeof node.pattern==='string'&&!new RegExp(node.pattern).test(value))throw Error('Add explicit seed for pattern '+node.pattern);return value;
    }
    if(node.type==='number'||node.type==='integer'){let n=typeof node.minimum==='number'?Math.max(0,node.minimum):0;if(typeof node.exclusiveMinimum==='number')n=Math.max(n,node.exclusiveMinimum+1);return node.type==='integer'?Math.ceil(n):n;}
    if(node.type==='boolean')return false;if(node.type==='null')return null;
    throw Error('Unsupported structural schema '+JSON.stringify(node));
  }
  const example=make(root),valid=s.safeParse(example);if(!valid.success)throw Error('Structural seed does not pass Zod: '+JSON.stringify(valid.error.issues));return example;
}
function invalidExample(s:z.ZodType,valid:unknown):NegativeProbe{
  const candidates:unknown[]=[...(valid&&typeof valid==='object'&&!Array.isArray(valid)?[{...object(valid),__unknown_contract_field__:true}]:[]),null,'',-1,{},[],true,'__unknown_contract_branch__'];
  for(const value of candidates)if(!s.safeParse(value).success)return {kind:'json',value};
  // z.json() accepts every JSON value; its only negative fixture is necessarily
  // outside JSON. Store the probe instruction instead of silently serializing it.
  if(s.safeParse(undefined).success)throw Error('No supported negative probe');return {kind:'undefined'};
}
function invalidTag(s:z.ZodType,valid:unknown):NegativeProbe|undefined{
  if(!valid||typeof valid!=='object'||Array.isArray(valid))return undefined;
  for(const key of ['kind','type','status','ok','documentType','version'])if(Object.hasOwn(valid,key)){const value={...object(valid),[key]:'__unknown_contract_branch__'};if(!s.safeParse(value).success)return {kind:'json',value};}return undefined;
}
export function buildContractCoverage():CoverageFixture{
  const roots=contractRoots(),unions=contractUnionInventory(roots);
  return {schemaVersion:1,scope:'Structural acceptance/rejection only. These fixtures do not prove reference, graph, result arithmetic, persistence or runtime semantics.',roots:[...roots].sort(([a],[b])=>a.localeCompare(b,'en')).map(([name,s])=>{const valid=structuralExample(s);return {name,valid,invalid:invalidExample(s,valid)};}),unions:unions.map(u=>({id:u.id,locations:[...u.locations].sort(),branches:u.branches.map((s,i)=>{const valid=structuralExample(s),tag=invalidTag(u.schema,valid),label=valid&&typeof valid==='object'&&!Array.isArray(valid)?Object.entries(object(valid)).filter(([key,v])=>['kind','type','status','ok','documentType','version'].includes(key)&&['string','boolean'].includes(typeof v)).map(([k,v])=>k+'='+String(v)).join(',')||'branch-'+i:'branch-'+i;return {label,valid,invalid:invalidExample(u.schema,valid),...(tag?{invalidTag:tag}:{})};})}))};
}
