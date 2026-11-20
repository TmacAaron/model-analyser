import { AssetDocument,StateId,StorageId,NodeId,type GraphTemplate,type CostDefinition,type AssetDocument as Asset } from '@model-analyser/contracts';
import { Equations,GraphAuthor,fp32,int64,vector,symbol } from './model-authoring.js';
import { deepseekConfigProfile } from './config-profiles.js';
import type { DeepSeekV3Profile } from './deepseek-v3-profile.js';
export const DEEPSEEK_COMMIT='604d5664dddd88a0433dbae533b7fe9472482de0';
export const selection:CostDefinition['compute'][number]['computeClass']={arithmetic:'integer',inputDtypes:[{category:'int',bits:32,format:'int32'}],multiplyDtype:{category:'int',bits:32,format:'int32'},accumulateDtype:{category:'int',bits:32,format:'int32'},resource:'custom',resourceKey:'topk-comparison'};
const baseSources:Asset['sources']=[{kind:'url',url:'https://huggingface.co/deepseek-ai/DeepSeek-V2-Lite/resolve/'+DEEPSEEK_COMMIT+'/config.json',checkedOn:'2026-11-14'},{kind:'url',url:'https://huggingface.co/deepseek-ai/DeepSeek-V2-Lite/resolve/'+DEEPSEEK_COMMIT+'/modeling_deepseek.py',checkedOn:'2026-11-14'},{kind:'note',text:'Offline SHA256 snapshots: references/models/source-lock.json. BF16 residency includes all 64 routed experts and two shared experts in 26 MoE layers, first layer dense; untied embedding/head. Top-6 work per token; weight-read upper-bound assumes min(64,B*Q*6) distinct experts, one read per touched expert matrix, not measured routing. Greedy selection uses an explicit K-pass E-comparison proxy on a separate custom resource, not floating-point MFU. FP32 vector router and softmax; no renormalization of selected probabilities (config norm_topk_prob=false, scale=1). Dense materialized attention with useful causal pairs. Norm/softmax/SiLU vector counts are approximations; declared logical buffer reads/writes assume HBM factor=1. No inference, measured kernel claim, routing imbalance/expert parallel/network, sorting implementation, YaRN table/trig creation or allocator/runtime overhead.'}];
type Param=Asset['parameters'][number];
const integer=(key:string,value:number,min=1):Param=>({key,name:key,type:'integer',unit:'count',min,default:{kind:'integer',value}});
export function makeDeepSeekAssets(variant:'expanded'|'absorbed'='expanded',v3?:DeepSeekV3Profile,packExpertRoutes=false):Asset[]{
  const compressed=variant==='absorbed';
  if(v3&&!compressed)throw Error('V3/R1 uses the authored absorbed MLA reference');
  if(packExpertRoutes&&!v3)throw Error('Owner-local routed slots are authored for V3/R1');
  const family=v3?'deepseek-v3':'deepseek-v2';
  const sources:Asset['sources']=v3?.sources??[...baseSources,{kind:'note',text:compressed?'Experimental mathematical absorbed MLA: cache normalized latent R plus one shared rotary key DR, absorb K-up weight into query, accumulate latent values then apply V-up weight. Same parameter residency as reference; reordered BF16 operations are not bitwise equivalent. This is an explicit analytical execution assumption and is NOT the pinned HF implementation.':'Pinned HF reference execution: KV-B projection expands K/V before cache.update; stores NH*(DN+DR+DV) values/token/layer. Do not substitute the compressed MLA cache formula for this execution.'}];
  const dims=v3?.dimensions??{H:2048,NH:16,DN:128,DR:64,DV:128,R:512,I:10944,J:1408,E:64,K:6,S:2,V:102400,M:163840};
  const parameters=[integer('B',1),integer('Q',1),integer('C',0,0),...Object.entries(dims).map(([key,value])=>integer(key,value))];
  const eq=new Equations('builtin:formula:'+family,parameters,v3?sources:baseSources);
  const T='if(C + Q <= M, C + Q, 1 / 0)',KT=v3?'if(min(E / GN == floor(E / GN), E / GN >= 2, TG <= GN, K <= TG * E / GN), K, 1 / 0)':'if(K <= E, K, 1 / 0)';
  const hidden:[string,'batch'|'token'|'hidden',string][]=[['b','batch','B'],['q','token','Q'],['h','hidden','H']];
  const wrap=(id:string,name:string,definition:Asset['definition'],params=parameters)=>AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:id,revision:packExpertRoutes?2:1,name,description:v3?'Absorbed MLA with BF16 analytical residency and published V3-family routing.':compressed?'Experimental absorbed MLA mathematical reference; not HF execution.':'Published HF expanded-cache MLA analytical reference.',parameters:params,tags:[family,'moe','mla','bf16','analytical-reference',variant],sources,definition});
  // Shared formula IDs/revisions must have identical content across both models.
  const makeLayer=(moe:boolean)=>{
    const g=new GraphAuthor(eq),act=(id:string)=>g.tensor(id,hidden),weight=(id:string,n:string,k='H')=>g.tensor(id,[['out','custom',n],['in','hidden',k]],{category:'weight'}),norm=(id:string,n='H')=>g.tensor(id,[['h','hidden',n]],{category:'weight'}),head=(id:string,n:string)=>g.tensor(id,[['b','batch','B'],['q','token','Q'],['head','head','NH'],['d','hidden',n]]),latent=(id:string,n:string)=>g.tensor(id,[['b','batch','B'],['q','token','Q'],['d','hidden',n]]);
    act('x');g.input('x');norm('input-norm-weight');act('normed');g.node('input-norm','Input RMSNorm',['x','input-norm-weight'],['normed'],{useful:'5 * B * Q * H',computeClass:vector});
    if(v3){
      weight('q-a-weight','QR');latent('q-latent-raw','QR');
      g.node('q-a-proj','Q low-rank down projection',['normed','q-a-weight'],['q-latent-raw'],{useful:'2 * B * Q * H * QR'});
      norm('q-a-norm-weight','QR');latent('q-latent','QR');
      g.node('q-a-norm','Q latent RMSNorm',['q-latent-raw','q-a-norm-weight'],['q-latent'],{useful:'5 * B * Q * QR',computeClass:vector});
    }
    weight('q-weight','NH * (DN + DR)',v3?'QR':'H');head('q-raw','if(DR / 2 == floor(DR / 2), DN + DR, 1 / 0)');
    g.node('q-proj',v3?'Q low-rank up projection':'Direct Q projection (q_lora_rank=null)',[v3?'q-latent':'normed','q-weight'],['q-raw'],{useful:v3?'2 * B * Q * QR * NH * (DN + DR)':'2 * B * Q * H * NH * (DN + DR)'});
    weight('kv-a-weight','R + DR');latent('latent-raw','R');latent('k-rope-raw','DR');g.node('kv-a','Compressed KV-A and shared rotary key projection',['normed','kv-a-weight'],['latent-raw','k-rope-raw'],{useful:'2 * B * Q * H * (R + DR)'});
    norm('kv-a-norm-weight','R');latent('latent-new','R');g.node('kv-a-norm','Latent RMSNorm',['latent-raw','kv-a-norm-weight'],['latent-new'],{useful:'5 * B * Q * R',computeClass:vector});
    head('q-nope','DN');head('q-rope','DR');latent('k-rope-new','DR');g.node('rope','Split Q and apply YaRN rotary values',['q-raw','k-rope-raw'],['q-nope','q-rope','k-rope-new'],{useful:'3 * B * Q * (NH + 1) * DR',computeClass:vector});
    const scoreShape:[string,'batch'|'head'|'token',string][]=[['b','batch','B'],['head','head','NH'],['q','token','Q'],['s','token',T]];let cacheIds:string[];
    if(compressed){
      weight('kv-b-k-weight','NH * DN','R');weight('kv-b-v-weight','NH * DV','R');head('q-absorbed','R');g.node('q-absorb','Absorb key-up matrix into per-head query',['q-nope','kv-b-k-weight'],['q-absorbed'],{useful:'2 * B * Q * NH * DN * R'});
      g.tensor('cache-latent',[['b','batch','B'],['s','token',T],['r','hidden','R']],{category:'state'});g.tensor('cache-rope',[['b','batch','B'],['s','token',T],['d','hidden','DR']],{category:'state'});cacheIds=['cache-latent','cache-rope'];
      g.node('cache-update','Append normalized latent and one shared rotary key',['latent-new','k-rope-new'],cacheIds,undefined,{accessBytes:{'cache-latent':'2 * B * Q * R','cache-rope':'2 * B * Q * DR'}});
      g.tensor('scores',scoreShape);g.node('qk','Latent + rotary score contractions',['q-absorbed','q-rope',...cacheIds],['scores'],{useful:'2 * B * NH * (C * Q + Q * (Q + 1) / 2) * (R + DR)',executed:'2 * B * NH * Q * (C + Q) * (R + DR)'});
    }else{
      weight('kv-b-weight','NH * (DN + DV)','R');head('k-nope-new','DN');head('v-new','DV');g.node('kv-b','KV-B expansion before reference cache update',['latent-new','kv-b-weight'],['k-nope-new','v-new'],{useful:'2 * B * Q * R * NH * (DN + DV)'});
      g.tensor('cache-k',[['b','batch','B'],['s','token',T],['head','head','NH'],['d','hidden','DN + DR']],{category:'state'});g.tensor('cache-v',[['b','batch','B'],['s','token',T],['head','head','NH'],['d','hidden','DV']],{category:'state'});cacheIds=['cache-k','cache-v'];
      g.node('cache-update','Append expanded K/V including rotary replication',['k-nope-new','k-rope-new','v-new'],cacheIds,undefined,{accessBytes:{'cache-k':'2 * B * Q * NH * (DN + DR)','cache-v':'2 * B * Q * NH * DV'}});
      g.tensor('scores',scoreShape);g.node('qk','Expanded MLA QKᵀ reference',['q-nope','q-rope','cache-k'],['scores'],{useful:'2 * B * NH * (C * Q + Q * (Q + 1) / 2) * (DN + DR)',executed:'2 * B * NH * Q * (C + Q) * (DN + DR)'});
    }
    g.tensor('probabilities',scoreShape);g.tensor('softmax-scratch',scoreShape,{dtype:fp32,category:'workspace'});g.node('softmax','Causal softmax with FP32 workspace',['scores'],['probabilities'],{useful:'5 * B * NH * (C * Q + Q * (Q + 1) / 2)',executed:'5 * B * NH * Q * (C + Q)',computeClass:vector},{temporaries:['softmax-scratch']});
    if(compressed){head('latent-attended','R');g.node('av','Accumulate weighted normalized latents',['probabilities','cache-latent'],['latent-attended'],{useful:'2 * B * NH * (C * Q + Q * (Q + 1) / 2) * R',executed:'2 * B * NH * Q * (C + Q) * R'});head('attended','DV');g.node('v-up','Apply per-head value-up matrix after latent accumulation',['latent-attended','kv-b-v-weight'],['attended'],{useful:'2 * B * Q * NH * R * DV'});}else {head('attended','DV');g.node('av','Expanded attention-weighted values',['probabilities','cache-v'],['attended'],{useful:'2 * B * NH * (C * Q + Q * (Q + 1) / 2) * DV',executed:'2 * B * NH * Q * (C + Q) * DV'});}
    weight('o-weight','H','NH * DV');act('attention-output');g.node('o-proj','Attention output projection',['attended','o-weight'],['attention-output'],{useful:'2 * B * Q * NH * DV * H'});act('residual-attention');g.node('attention-residual','Attention residual',['x','attention-output'],['residual-attention'],{useful:'B * Q * H',computeClass:vector});norm('post-norm-weight');act('post-norm');g.node('post-norm','Post-attention RMSNorm',['residual-attention','post-norm-weight'],['post-norm'],{useful:'5 * B * Q * H',computeClass:vector});
    if(moe){
      weight('router-weight','E');
      const expertShape:[string,'batch'|'token'|'expert',string][]=[['b','batch','B'],['q','token','Q'],['expert','expert','E']];
      const selectedShape:[string,'batch'|'token'|'expert',string][]=[['b','batch','B'],['q','token','Q'],['selected','expert',KT]];
      g.tensor('router-logits',expertShape,{dtype:fp32});
      g.node('router',v3?'FP32 sigmoid router projection':'FP32 softmax router projection',['post-norm','router-weight'],['router-logits'],{useful:'2 * B * Q * H * E',computeClass:vector});
      g.tensor('router-scores',expertShape,{dtype:fp32});
      g.tensor('topk-indices',selectedShape,{dtype:int64});g.tensor('topk-weights',selectedShape,{dtype:fp32});
      if(v3){
        g.node('router-sigmoid','Sigmoid expert affinities',['router-logits'],['router-scores'],{useful:'4 * B * Q * E',computeClass:vector});
        g.tensor('router-correction',[['expert','expert','E']],{dtype:fp32,category:'weight'});
        g.tensor('router-choice',expertShape,{dtype:fp32});
        g.node('router-bias','Correction bias for expert selection',['router-scores','router-correction'],['router-choice'],{useful:'B * Q * E',computeClass:vector});
        g.tensor('group-top2',[['b','batch','B'],['q','token','Q'],['group','custom','GN'],['selected','expert','2']],{dtype:fp32});
        g.node('group-top2','Top two corrected affinities in each group',['router-choice'],['group-top2'],{useful:'2 * B * Q * E',computeClass:selection});
        g.tensor('group-scores',[['b','batch','B'],['q','token','Q'],['group','custom','GN']],{dtype:fp32});
        g.node('group-scores','Sum the two scores in each expert group',['group-top2'],['group-scores'],{useful:'B * Q * GN',computeClass:vector});
        g.tensor('selected-groups',[['b','batch','B'],['q','token','Q'],['group','custom','TG']],{dtype:int64});
        g.node('group-select','Select highest scoring expert groups',['group-scores'],['selected-groups'],{useful:'B * Q * GN * TG',computeClass:selection});
        g.node('topk','Mask by selected group and choose routed experts',['router-choice','selected-groups'],['topk-indices'],{useful:'B * Q * E * K',computeClass:selection});
        g.node('route-weights','Normalize and scale original sigmoid affinities',['router-scores','topk-indices'],['topk-weights'],{useful:'if(K > 1, 3 * B * Q * K, B * Q)',computeClass:vector});
      }else{
        g.node('router-softmax','Router probabilities (no top-k renormalization)',['router-logits'],['router-scores'],{useful:'5 * B * Q * E',computeClass:vector});
        g.node('topk','Explicit K-pass comparison proxy for greedy TopK',['router-scores'],['topk-indices','topk-weights'],{useful:'B * Q * E * K',computeClass:selection});
      }
      g.tensor('expert-input',[['b','batch','B'],['q','token','Q'],['selected','expert',KT],['h','hidden','H']]);
      if(packExpertRoutes){
        g.tensor('expert-route-ids',selectedShape,{dtype:int64});
        g.tensor('expert-route-weights',selectedShape,{dtype:fp32});
      }
      g.node('dispatch',packExpertRoutes?'Pack tokens and normalized weights by striped expert owner':'Logical token dispatch (sorting implementation excluded)',
        ['post-norm','topk-indices',...(packExpertRoutes?['topk-weights']:[])],['expert-input',...(packExpertRoutes?['expert-route-ids','expert-route-weights']:[])],
        undefined,{accessBytes:{'post-norm':'2 * B * Q * K * H'}});
      const ownerIds=packExpertRoutes?['expert-route-ids']:[],expertAxis=packExpertRoutes?'owner-expert':'expert';
      for(const id of ['expert-gate-weight','expert-up-weight'])g.tensor(id,[[expertAxis,'expert','E'],['out','hidden','J'],['in','hidden','H']],{category:'weight'});g.tensor('expert-gate-up',[['b','batch','B'],['q','token','Q'],['selected','expert',KT],['j','hidden','2 * J']]);g.node('expert-gate-up','TopK routed expert gate/up',['expert-input',...ownerIds,'expert-gate-weight','expert-up-weight'],['expert-gate-up'],{useful:'4 * B * Q * K * H * J'},{accessBytes:{'expert-gate-weight':'2 * min(E, B * Q * K) * H * J','expert-up-weight':'2 * min(E, B * Q * K) * H * J'}});
      g.tensor('expert-activated',[['b','batch','B'],['q','token','Q'],['selected','expert',KT],['j','hidden','J']]);g.node('expert-silu','Routed expert SiLU×up',['expert-gate-up'],['expert-activated'],{useful:'6 * B * Q * K * J',computeClass:vector});g.tensor('expert-down-weight',[[expertAxis,'expert','E'],['out','hidden','H'],['in','hidden','J']],{category:'weight'});g.tensor('expert-output',[['b','batch','B'],['q','token','Q'],['selected','expert',KT],['h','hidden','H']]);g.node('expert-down','TopK routed expert down',['expert-activated',...ownerIds,'expert-down-weight'],['expert-output'],{useful:'2 * B * Q * K * H * J'},{accessBytes:{'expert-down-weight':'2 * min(E, B * Q * K) * H * J'}});
      act('routed-output');g.node('combine','Weight and combine TopK routed outputs',['expert-output',packExpertRoutes?'expert-route-weights':'topk-weights'],['routed-output'],{useful:'2 * B * Q * K * H',computeClass:vector});weight('shared-gate-weight','S * J');weight('shared-up-weight','S * J');g.tensor('shared-gate-up',[['b','batch','B'],['q','token','Q'],['j','hidden','2 * S * J']]);g.node('shared-gate-up','Always-active shared expert gate/up',['post-norm','shared-gate-weight','shared-up-weight'],['shared-gate-up'],{useful:'4 * B * Q * H * S * J'});g.tensor('shared-activated',[['b','batch','B'],['q','token','Q'],['j','hidden','S * J']]);g.node('shared-silu','Shared SiLU×up',['shared-gate-up'],['shared-activated'],{useful:'6 * B * Q * S * J',computeClass:vector});weight('shared-down-weight','H','S * J');act('shared-output');g.node('shared-down','Shared expert down',['shared-activated','shared-down-weight'],['shared-output'],{useful:'2 * B * Q * H * S * J'});act('ffn-output');g.node('shared-add','Add shared and routed experts',['routed-output','shared-output'],['ffn-output'],{useful:'B * Q * H',computeClass:vector});
    }else{
      weight('gate-weight','I');weight('up-weight','I');g.tensor('gate-up',[['b','batch','B'],['q','token','Q'],['i','hidden','2 * I']]);g.node('gate-up-proj','First dense layer gate/up',['post-norm','gate-weight','up-weight'],['gate-up'],{useful:'4 * B * Q * H * I'});g.tensor('activated',[['b','batch','B'],['q','token','Q'],['i','hidden','I']]);g.node('silu','Dense SiLU×up',['gate-up'],['activated'],{useful:'6 * B * Q * I',computeClass:vector});weight('down-weight','H','I');act('ffn-output');g.node('down-proj','First dense layer down',['activated','down-weight'],['ffn-output'],{useful:'2 * B * Q * H * I'});
    }
    act('y');g.node('mlp-residual','FFN residual',['residual-attention','ffn-output'],['y'],{useful:'B * Q * H',computeClass:vector});g.output('y');
    g.graph.states.push({stateId:StateId.parse('kv'),name:compressed?'Compressed latent + shared rotary key':'HF expanded K/V cache',stateKind:compressed?'latent':'kv',allocationBasis:'step_end',storageIds:cacheIds.map(id=>StorageId.parse(id)),creator:{kind:'initialized'},readers:cacheIds.flatMap(id=>(compressed&&id==='cache-latent'?['qk','av']:!compressed&&id==='cache-v'?['av']:['qk']).map(nodeId=>({kind:'node' as const,nodeId:NodeId.parse(nodeId),portId:id}))),writers:cacheIds.map(portId=>({kind:'node' as const,nodeId:NodeId.parse('cache-update'),portId})),updatePolicy:{kind:'append'}});
    return wrap('builtin:module:'+family+'-'+variant+'-'+(moe?'moe':'dense'),(v3?'DeepSeek-V3 / R1':'DeepSeek-V2-Lite')+' '+variant+' '+(moe?'MoE':'dense')+' decoder',{kind:'module',graph:g.graph});
  };
  const dense=makeLayer(false),moe=makeLayer(true),root=new GraphAuthor(eq);
  const rootParams=[...parameters,integer('Lmoe',v3?.moe??26),...(v3?[integer('Ldense',v3.dense)]:[])];
  const repeat=(key:string):GraphTemplate['nodes'][number]['repeat']=>({axis:'layer',count:symbol(key),wiring:'chain',carry:[{inputPortId:'x',outputPortId:'y'}]});
  root.tensor('tokens',[['b','batch','B'],['q','token','Q']],{dtype:int64});root.input('tokens');
  root.tensor('embedding',[['v','vocab','V'],['h','hidden','H']],{category:'weight'});root.tensor('hidden',hidden);
  root.node('embedding','Token embedding lookup (untied head)',['tokens','embedding'],['hidden'],undefined,{accessBytes:{embedding:'2 * B * Q * H'}});
  root.tensor('dense-output',hidden);
  root.module('dense',v3?'Dense decoder':'First dense decoder layer',dense,'hidden','dense-output',parameters,v3?repeat('Ldense'):undefined);
  root.tensor('moe-output',hidden);
  root.module('moe',v3?'MoE decoder':'26 routed/shared expert decoder layers',moe,'dense-output','moe-output',parameters,repeat('Lmoe'));
  root.tensor('final-norm-weight',[['h','hidden','H']],{category:'weight'});root.tensor('normalized',hidden);
  root.node('final-norm','Final RMSNorm',['moe-output','final-norm-weight'],['normalized'],{useful:'5 * B * Q * H',computeClass:vector});
  root.tensor('lm-head-weight',[['v','vocab','V'],['h','hidden','H']],{category:'weight'});
  root.tensor('logits-bf16',[['b','batch','B'],['q','token','Q'],['v','vocab','V']]);
  root.node('lm-head','Untied full-position LM head',['normalized','lm-head-weight'],['logits-bf16'],{useful:'2 * B * Q * H * V'});
  root.tensor('logits',[['b','batch','B'],['q','token','Q'],['v','vocab','V']],{dtype:fp32});
  root.node('logits-cast','Reference FP32 logits output (conversion throughput excluded)',['logits-bf16'],['logits']);root.output('logits');
  const modelId='builtin:model:deepseek-'+(v3?.release??('v2-lite-'+variant));
  const name=v3?v3.name+' · MLA / MoE':'DeepSeek-V2-Lite · '+(compressed?'absorbed MLA theoretical variant':'HF expanded-cache MLA reference');
  const model=wrap(modelId,name,{kind:'model',family,variant:v3?v3.release+'-absorbed-mla':'lite-'+variant,graph:root.graph,assumptions:sources.flatMap(s=>s.kind==='note'?[s.text]:[]),workloadBindings:(['prefill','decode'] as const).flatMap(phase=>[['B','batchSize'],['Q','queryTokensPerRequest'],['C',phase==='decode'?'contextTokensPerRequest':'pastTokensPerRequest']].map(([parameterKey,name])=>({phase,parameterKey:parameterKey!,value:symbol(name!)})))},rootParams);
  return [v3?model:{...model,revision:2,configMapping:deepseekConfigProfile},dense,moe,...eq.assets];
}
