import { describe,it,expect } from 'vitest';
import { z } from 'zod';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { AssetDocument, AssetDraft, ValueExpr, ProjectDocument } from '@model-analyser/contracts';
import { validateAssets, canonical } from '../packages/contracts/src/validation.js';
import { decodeDocument } from '../apps/local/src/store.js';
import { stringify } from 'yaml';
import { fixture } from './fixtures.js';
describe('strict contracts',()=>{
  it('rejects unknown fields, string numbers, invalid and future revisions',()=>{
    const asset=fixture();for(const patch of [{extra:1},{revision:0},{revision:'latest'},{revision:'1'},{schemaVersion:2}])expect(AssetDocument.safeParse({...asset,...patch}).success).toBe(false);
  });
  it('accepts incomplete drafts separately from formal assets',()=>{
    const draft={documentType:'asset_draft',schemaVersion:1,draftId:'d',assetId:'a',assetKind:'formula',baseRevision:null,draftGeneration:1,updatedAt:new Date().toISOString(),candidate:{name:'未完成'}};
    expect(AssetDraft.safeParse(draft).success).toBe(true);expect(AssetDocument.safeParse(draft.candidate).success).toBe(false);
    const ajv=new Ajv2020({strict:false});addFormats(ajv);const validate=ajv.compile(z.toJSONSchema(AssetDraft));for(const storageFormat of ['json','yaml','toml',1]){const value={...draft,storageFormat};expect(Boolean(validate(value))).toBe(AssetDraft.safeParse(value).success);expect(AssetDraft.safeParse(value).success).toBe(storageFormat==='json'||storageFormat==='yaml');}
  });
  it('exports recursive expressions without loosening them',()=>{expect(z.toJSONSchema(ValueExpr, {target:'draft-2020-12'})).toHaveProperty('$schema');expect(z.toJSONSchema(ProjectDocument)).toHaveProperty('additionalProperties',false);});
  it('agrees with JSON Schema for representative structure inputs',()=>{
    const ajv=new Ajv2020({strict:false});addFormats(ajv);const validate=ajv.compile(z.toJSONSchema(AssetDocument));
    const asset=fixture();for(const candidate of [asset,{...asset,unknown:true},{...asset,revision:0},{...asset,name:3},{...asset,sources:[{kind:'url',url:'not a url'}]}])expect(Boolean(validate(candidate))).toBe(AssetDocument.safeParse(candidate).success);
  });
  it('normalizes JSON and YAML identically and refuses tags, duplicates and excessive aliases',()=>{
    const asset=fixture();expect(canonical(decodeDocument(JSON.stringify(asset),'json'))).toBe(canonical(decodeDocument(stringify(asset),'yaml')));
    for(const text of ['a: 1\na: 2','a: !javascript x','x: .inf'])expect(()=>decodeDocument(text,'yaml')).toThrow();
  });
  it('reports missing references, wrong kinds, and recursive references',()=>{
    const make=(id:string,target:string)=>AssetDocument.parse({...fixture(),assetId:id,definition:{kind:'module',graph:{inputs:[],outputs:[],nodes:[{nodeId:'n',name:'n',phases:['decode'],portBindings:[],stateBindings:[],body:{kind:'module',asset:{assetId:target,revision:1,kind:'module'},bindings:[]}}],edges:[],dependencies:[],tensors:[],storages:[],states:[]}}});
    const a=make('a','b'),b=make('b','a');expect(validateAssets([a],[a]).map(d=>d.code)).toContain('missing_reference');
    expect(validateAssets([a,b]).map(d=>d.code)).toContain('dependency_cycle');
    expect(validateAssets([make('a',fixture().assetId)],[make('a',fixture().assetId),fixture()]).map(d=>d.code)).toContain('reference_kind_mismatch');
  });
  it('rejects malformed and unbound formulas before commit',()=>{
    const asset=fixture();if(asset.definition.kind!=='formula')throw Error();
    for(const expression of ['globalThis.fetch(1)','x+2','pow(1)','sum(3,1,2,3)'])expect(validateAssets([{...asset,definition:{kind:'formula',formula:{...asset.definition.formula,expression}}}]).length).toBeGreaterThan(0);
  });
});
