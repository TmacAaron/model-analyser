import { AssetDocument,GraphTemplate,ProjectDocument,Scenario,NodeId,TensorId,StorageId,type Shape } from '@model-analyser/contracts';
import { collectRefs } from '../packages/contracts/src/validation.js';
import { GraphAuthor,Equations,bf16,fp32,matrix,vector,literal,symbol,ref } from './model-authoring.js';
import { makeKdaProject,type KdaProfile } from './kda-project.js';
import lock from '../references/parallel/kda-prefill-source-lock.json' with {type:'json'};
export type KdaPrefillRoute='short'|'chunk';
type Axis=[string,Shape[number]['semantic'],string];
/** Stage-specific batched authoring. Existing fixed decode snapshots are never changed. */
export function makeKdaPrefillProject(profile:KdaProfile='hybrid',route:KdaPrefillRoute='short'):ProjectDocument{
  const base=makeKdaProject(profile),baseModel=base.assetSnapshots.find(a=>a.definition.kind==='model');if(!baseModel)throw Error();
  const common=baseModel.parameters,sources:AssetDocument['sources']=[{kind:'url',url:lock.url,checkedOn:lock.checkedOn},{kind:'note',text:lock.authoredAssumptions.join(' ')}],effective=profile==='all-mla'?'dense':route,prefix='builtin:kda-prefill:'+profile+':'+effective;
  const params=(which:'short'|'chunk'|'dense')=>common.map(p=>p.type!=='integer'?p:p.key==='C'?{...p,min:0,max:0,default:{kind:'integer' as const,value:0}}:p.key==='Q'?{...p,min:which==='chunk'?65:2,max:which==='short'?64:256,default:{kind:'integer' as const,value:which==='chunk'?65:8}}:p);
  const eq=new Equations('builtin:kda-prefill:formula',common,sources);
  const rename=(v:unknown):unknown=>typeof v==='string'?v.replace(/^builtin:kda:formula:/,'builtin:kda-prefill:formula:'):Array.isArray(v)?v.map(rename):typeof v==='object'&&v!==null?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,rename(x)])):v;
  eq.assets=base.assetSnapshots.filter(a=>a.definition.kind==='formula').map(a=>AssetDocument.parse({...rename(a) as object,sources}));
  const qAxis:Shape[number]={axisId:'q',semantic:'token',size:symbol('Q')},h:Axis[]=[['b','batch','B'],['q','token','Q'],['h','hidden','H']],nd:Axis[]=[['b','batch','B'],['q','token','Q'],['n','head','N'],['d','hidden','D']];
  const chunks='ceil(Q / 64)',rem='Q - 64 * floor(Q / 64)',sq='(floor(Q / 64) * 4096 + ('+rem+') * ('+rem+'))',inc='(floor(Q / 64) * 2080 + ('+rem+') * ('+rem+' + 1) / 2)',strict='('+sq+' - '+inc+')',cub='(floor(Q / 64) * 64 * 4095 / 3 + ('+rem+') * (('+rem+') * ('+rem+') - 1) / 3)',padded='(64 * '+chunks+')';
  function makeModule(kind:'kda'|'mla'){
    const original=base.assetSnapshots.find(a=>a.definition.kind==='module'&&a.assetId==='builtin:kda:module:'+kind+':source');if(original?.definition.kind!=='module')throw Error('Missing source module');
    const g=new GraphAuthor(eq);g.graph=GraphTemplate.parse(rename(original.definition.graph));g.graph.nodes=[];g.graph.edges=[];g.graph.dependencies=[];g.graph.inputs=[];g.graph.outputs=[];
    g.graph.storages=g.graph.storages.filter(s=>s.category!=='workspace');
    const activation=new Set(g.graph.storages.filter(s=>s.category==='activation').map(s=>s.storageId));
    for(const s of g.graph.storages)if(activation.has(s.storageId)&&s.allocation.kind==='tensor')s.allocation.shape.splice(1,0,qAxis);
    for(const t of g.graph.tensors)if(activation.has(t.storageId))t.shape.splice(1,0,qAxis);
    g.input('X','x');
    function tensor(id:string,axes:Axis[],dtype=bf16,storageId?:string){g.tensor(id,axes,{dtype,...(storageId?{storageId}:{})});}
    function node(id:string,name:string,ins:string[],outs:string[],useful?:string,executed=useful,vec=false,accessBytes?:Record<string,string>){g.node(id,name,ins,outs,useful?{useful,executed:executed??useful,computeClass:vec?vector:matrix}:undefined,{...(accessBytes?{accessBytes}:{})});}
    function segment(id:string,useful:string,executed=useful,vec=true,name='conversion'){const n=g.graph.nodes.find(n=>n.nodeId===id);if(n?.body.kind!=='opaque')throw Error();n.body.cost.compute.push({segmentId:name,computeClass:vec?vector:matrix,usefulOperations:eq.value(useful,'operation'),executedOperations:eq.value(executed,'operation')});}
    function workspace(id:string,bytes:string,owners:string[]){g.graph.storages.push({storageId:StorageId.parse(id),name:id,category:'workspace',sharingDomain:'request',allocation:{kind:'bytes',value:eq.value(bytes,'byte')}});for(const owner of owners){const n=g.graph.nodes.find(n=>n.nodeId===owner);if(n?.body.kind!=='opaque')throw Error();n.body.cost.temporaryStorageIds.push(StorageId.parse(id));}}
    node('input-norm','Batched attention input RMSNorm',['X','WN'],['Input'],'5 * B * Q * H',undefined,true);
    if(kind==='kda'){
      const m='min(Q, W - 1)',hist='('+m+' * (W - 1) - '+m+' * ('+m+' - 1) / 2)';
      for(const part of ['Q','K','V']){
        node(part.toLowerCase()+'-project',part+' batched projection',['Input','W'+part],[part+'Raw'],'2 * B * Q * H * N * D');
        node(part.toLowerCase()+'-conv',part+' multi-token convolution and new final cache',[part+'Raw','C'+part,'WC'+part],[part,'C'+part+'After'],'B * N * D * (2 * (Q * W - '+hist+') + 3 * Q)','B * Q * N * D * (2 * W + 3)',true,{[part+'Raw']:'2 * B * N * D * (Q * W - '+hist+' + min(Q, W))',['C'+part]:'2 * B * N * D * ('+hist+' + max(0, W - Q))',['C'+part+'After']:'2 * B * N * D * W'});segment(part.toLowerCase()+'-conv','0','B * Q * N * D * (2 * W + 1)');
      }
      for(const gate of ['F','G']){node(gate.toLowerCase()+'-a',gate+' batched gate projection',['Input','W'+gate+'A'],[gate+'A'],'2 * B * Q * H * D');node(gate.toLowerCase()+'-b',gate+' batched gate expansion',[gate+'A','W'+gate+'B'],[gate+'Raw'],'2 * B * Q * N * D * D');}
      node('decay','Batched FP32 channel decay proxy',['FRaw','ALog','DTBias'],['Decay'],'B * Q * N * (5 * D + 2)',undefined,true);segment('decay','0','B * Q * N * D');
      node('beta-project','Batched head beta projection',['Input','WB'],['BetaRaw'],'2 * B * Q * H * N');node('beta','Batched FP32 sigmoid beta',['BetaRaw'],['Beta'],'4 * B * Q * N',undefined,true);segment('beta','0','B * Q * N');
      if(route==='short'){
        node('recurrent','Multi-token recurrent kernel; one matrix load/store',['Q','K','V','Decay','Beta','Memory'],['RecurrentOut','MemoryAfter'],'B * Q * N * (7 * D * D + 8 * D + 2)',undefined,true);segment('recurrent','0','4 * B * Q * N * D');workspace('NextMatrix','4 * B * N * D * D',['recurrent']);
      }else{
        tensor('QNorm',nd);tensor('KNorm',nd);tensor('GatePrefix',nd,fp32);
        const block:Axis[]=[['b','batch','B'],['q','token','Q'],['n','head','N'],['c','custom','64']];tensor('Aqk',block,fp32);tensor('AkkRaw',block,fp32);tensor('AkkSolved',block);
        for(const id of ['WYw','WYu','KG','VNew'])tensor(id,nd);tensor('ChunkStates',[['b','batch','B'],['c','custom',chunks],['n','head','N'],['k','hidden','D'],['v','hidden','D']]);
        node('qk-norm','Chunk input Q/K L2 normalization',['Q','K'],['QNorm','KNorm'],'B * Q * N * (6 * D + 2)',undefined,true);segment('qk-norm','0','4 * B * Q * N * D');
        node('gate-prefix','Chunk-local FP32 gate prefix sums',['Decay'],['GatePrefix'],'B * N * D * (Q - '+chunks+')',undefined,true);
        node('chunk-intra','FP32 gated intra-chunk Aqk and Akk scalar proxy',['QNorm','KNorm','GatePrefix','Beta'],['Aqk','AkkRaw'],'B * N * (5 * D * '+sq+' + 2 * '+inc+' + '+strict+')','B * N * Q * 64 * (10 * D + 3)',true);segment('chunk-intra','0','2 * B * Q * N * D');
        node('chunk-solve','Unit-lower triangular inverse proxy, BF16 solved output',['AkkRaw'],['AkkSolved'],'B * N * ('+cub+' + Q)','B * N * '+chunks+' * (64 * 4095 / 3 + 64)',true);segment('chunk-solve','0','B * Q * N * 64');
        node('chunk-wy','BF16 WY preparation with gated key output',['KNorm','V','Beta','AkkSolved','GatePrefix'],['WYw','WYu','KG'],'4 * B * N * D * '+inc,'4 * B * N * Q * 64 * D');segment('chunk-wy','7 * B * Q * N * D','7 * B * Q * N * D',true,'gates');segment('chunk-wy','0','5 * B * Q * N * D');
        node('chunk-inter','Inter-chunk state, new values and FP32 final matrix',['KG','WYw','WYu','GatePrefix','Memory'],['ChunkStates','VNew','MemoryAfter'],'4 * B * N * Q * D * D','4 * B * N * '+padded+' * D * D');segment('chunk-inter','B * N * (Q * D + '+chunks+' * (D * D + D))','B * N * ('+padded+' * D + '+chunks+' * (D * D + D))',true,'decay-residual');segment('chunk-inter','0','B * N * (2 * '+chunks+' * D * D + Q * D)');workspace('NextMatrix','4 * B * N * D * D',['chunk-inter']);
        node('chunk-output','BF16 causal intra plus cross-state output',['QNorm','VNew','GatePrefix','Aqk','ChunkStates'],['RecurrentOut'],'2 * B * N * Q * D * D + 2 * B * N * D * '+inc,'2 * B * N * '+padded+' * D * D + 2 * B * N * Q * 64 * D');segment('chunk-output','4 * B * Q * N * D','4 * B * N * '+padded+' * D',true,'gates-add');segment('chunk-output','0','B * Q * N * 64 + 3 * B * Q * N * D');
        for(const s of g.graph.states)if(s.stateId==='matrix')for(const e of [...s.readers,...s.writers])if(e.kind==='node')e.nodeId=NodeId.parse('chunk-inter');
      }
      node('output-norm-gate','Batched gated RMSNorm',['RecurrentOut','GRaw','WON'],['Gated'],'10 * B * Q * N * D',undefined,true);node('out','Batched KDA output projection',['Gated','WO'],['Y'],'2 * B * Q * H * N * D');
      // Allocation-only conservative retention of old/new convolution tuples for the module.
      workspace('OldConvolutionTuple','6 * B * N * D * W',g.graph.nodes.map(n=>n.nodeId));
    }else{
      tensor('CausalMask',[['b','batch','B'],['q','token','Q'],['t','token','Q']]);g.input('CausalMask','mask');
      node('query','Batched NoPE query projection',['Input','WQ'],['Query'],'2 * B * Q * H * N * (D + P)');node('kv-a','Batched MLA latent projection',['Input','WKVA'],['RawKV'],'2 * B * Q * H * (R + P)');node('kv-norm','Batched latent normalization',['RawKV','WKVN'],['Latent','PE'],'5 * B * Q * R',undefined,true);node('kv-expand','Batched expanded K/V projection',['Latent','WKVB'],['Expanded'],'4 * B * Q * R * N * D');
      node('cache','Cold prefill writes all expanded K/V rows',['Expanded','PE','Keys','Values'],['KeysAfter','ValuesAfter'],undefined,undefined,false,{Keys:'0',Values:'0',KeysAfter:'2 * B * Q * N * (D + P)',ValuesAfter:'2 * B * Q * N * D'});
      const pairs='(Q * (Q + 1) / 2)';node('qk','Dense executed QK, causal useful pairs',['Query','KeysAfter'],['Scores'],'2 * B * N * '+pairs+' * (D + P)','2 * B * N * Q * Q * (D + P)');
      const scoreShape:Axis[]=[['b','batch','B'],['q','token','Q'],['n','head','N'],['t','token','Q']];tensor('MaskedScores',scoreShape,bf16,'Scores');tensor('Probability32',scoreShape,fp32);
      node('apply-mask','Shared causal mask, in-place BF16 scores',['Scores','CausalMask'],['MaskedScores'],'B * N * Q * Q',undefined,true);
      node('softmax','Materialized FP32 scaled softmax',['MaskedScores'],['Probability32'],'6 * B * N * '+pairs,'6 * B * N * Q * Q',true);segment('softmax','0','B * N * Q * Q');
      node('prob-cast','FP32 probabilities to BF16',['Probability32'],['Probabilities'],'0','B * N * Q * Q',true);
      node('av','Dense executed AV, causal useful pairs',['Probabilities','ValuesAfter'],['Attended'],'2 * B * N * '+pairs+' * D','2 * B * N * Q * Q * D');node('out','Batched MLA output projection',['Attended','WO'],['Y'],'2 * B * Q * N * D * H');
    }
    node('residual','Batched attention residual',['X','Y'],['Z'],'B * Q * H',undefined,true);g.output('Z','y');for(const n of g.graph.nodes)n.phases=['prefill'];
    return AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'builtin:kda-prefill:module:'+kind+(kind==='kda'?':'+route:''),revision:1,name:(kind==='kda'?'KDA '+route:'MLA dense')+' source-pattern prefill',parameters:params(kind==='mla'?'dense':route),sources,tags:['research','kda','prefill'],definition:{kind:'module',graph:g.graph}});
  }
  const kinds=Array.from({length:4},(_,i)=>profile==='all-kda'?'kda':profile==='all-mla'?'mla':i===3?'mla':'kda'),modules=new Map<string,AssetDocument>();for(const kind of kinds)if(!modules.has(kind))modules.set(kind,makeModule(kind as 'kda'|'mla'));
  const root=new GraphAuthor(eq);root.tensor('X',h);root.input('X','x');
  if(kinds.includes('mla')){root.tensor('CausalMask',[['b','batch','B'],['q','token','Q'],['t','token','Q']]);root.node('causal-mask','Shared causal-mask construction',[],['CausalMask'],{useful:'0',executed:'B * Q * Q',computeClass:vector});}
  for(let i=0;i<4;i++){const kind=kinds[i],module=kind?modules.get(kind):undefined;if(!module)throw Error();root.tensor('Z'+i,h);root.module('layer'+i,module.name,module,i===0?'X':'Z'+(i-1),'Z'+i,common);if(kind==='mla'){const n=root.graph.nodes.find(n=>n.nodeId==='layer'+i);if(!n)throw Error();n.portBindings.push({portId:'mask',tensorId:TensorId.parse('CausalMask')});root.graph.edges.push({edgeId:'mask-'+i,tensorId:TensorId.parse('CausalMask'),from:{kind:'node',nodeId:NodeId.parse('causal-mask'),portId:'CausalMask'},to:{kind:'node',nodeId:n.nodeId,portId:'mask'}});}}
  root.output('Z3','y');for(const n of root.graph.nodes)n.phases=['prefill'];
  const model=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:prefix+':model',revision:1,name:'KDA/MLA prefill '+profile+' '+effective,parameters:params(effective),sources,tags:['research','kda','prefill'],extensions:{kdaPrefill:{version:'kda-prefill-research.1',profile,route:effective,chunkSize:64,scope:'Initialized C=0 prefill attention/norm/residual fragments; no FFN or full model.'}},definition:{kind:'model',family:'kimi-linear-prefill-fragment',variant:profile+'-'+effective,graph:root.graph,assumptions:lock.authoredAssumptions,workloadBindings:[['B','batchSize'],['C','pastTokensPerRequest'],['Q','queryTokensPerRequest']].map(([parameterKey,name])=>({phase:'prefill',parameterKey:parameterKey??'',value:symbol(name??'')}))}});
  const hardware=AssetDocument.parse({...base.assetSnapshots.find(a=>a.definition.kind==='hardware'),assetId:'builtin:hardware:kda-prefill-research',name:'Artificial KDA prefill 256-KiB arithmetic device',sources:[{kind:'note',text:lock.authoredAssumptions.at(-1)??''}],definition:{kind:'hardware',hardware:{capacityBytes:262144,computeCapabilities:[{computeClass:matrix,kind:'peak',operationsPerSecond:2000},{computeClass:vector,kind:'peak',operationsPerSecond:1000}],memoryCapabilities:[{key:'hbm',kind:'peak',bytesPerSecond:100}],communicationDefaults:[]}}});
  const scenario=Scenario.parse({scenarioId:prefix+':scenario',name:profile+' prefill '+effective,model:ref(model),bindings:[],workload:{kind:'prefill',batchSize:1,pastTokensPerRequest:0,queryTokensPerRequest:effective==='chunk'?65:8},deviceTopology:{devices:[{deviceId:'gpu0',hardware:ref(hardware)}],groups:[{groupId:'main',members:['gpu0']}]},parallelPlan:{assignments:[],communications:[],assumptions:lock.authoredAssumptions},executionPlan:{kind:'serial'},quantizationOverrides:[],numericOverrides:[],fusionGroups:[]});
  const pool=[model,...modules.values(),hardware,...eq.assets],wanted=new Set<string>([model.assetId,hardware.assetId]),todo=[model];while(todo.length){const a=todo.pop();if(!a)throw Error();for(const r of collectRefs(a))if(!wanted.has(r.assetId)){const child=pool.find(a=>a.assetId===r.assetId&&a.revision===r.revision);if(!child)throw Error('Missing authored dependency '+r.assetId);wanted.add(child.assetId);todo.push(child);}}
  return ProjectDocument.parse({documentType:'project',schemaVersion:1,projectId:prefix+':project',projectRevision:1,name:scenario.name,scenarios:[scenario],assetSnapshots:pool.filter(a=>wanted.has(a.assetId)),measurements:[],viewState:{nodes:[]}});
}
