import { AssetDocument,ProjectDocument,Scenario,NodeId,StorageId,StateId,type GraphTemplate,type Shape,type CostDefinition } from '@model-analyser/contracts';
import { GraphAuthor,Equations,bf16,fp32,matrix,vector,int64,literal,symbol,ref } from './model-authoring.js';
import lock from '../references/parallel/dsa-source-lock.json' with {type:'json'};
export type DsaProfile='source-mask'|'sparse-gather'|'dense';
export type DsaPolicy='serial'|'ideal'|'shared_bandwidth';
export type DsaAllocation='dynamic'|'provisioned';
type Axis=[string,Shape[number]['semantic'],string];
type ComputeClass=CostDefinition['compute'][number]['computeClass'];
const fp8={category:'float' as const,bits:8,format:'e4m3'};
export const dsaFp8Matrix:ComputeClass={arithmetic:'float',inputDtypes:[fp8],multiplyDtype:fp8,accumulateDtype:fp32,resource:'matrix'};
export const dsaFp32Matrix:ComputeClass={arithmetic:'float',inputDtypes:[fp32],multiplyDtype:fp32,accumulateDtype:fp32,resource:'matrix'};

/** Fixed source roles; ordinary portable graph assets, no engine family dispatch. */
export function makeDsaProject(profile:DsaProfile='source-mask',policy:DsaPolicy='serial',allocation:DsaAllocation='dynamic'):ProjectDocument{
  const prefix='builtin:dsa:'+profile+':'+allocation,parameters:AssetDocument['parameters']=[
    ...[['B',1,1,512],['C',31,0,4096],['H',8,1,128],['A',2,1,8],['I',2,1,8],['K',4,1,512],['M',128,1,8192]].map(([key,value,min,max])=>({key:String(key),name:String(key),type:'integer' as const,unit:'count' as const,min:Number(min),max:Number(max),default:{kind:'integer' as const,value:Number(value)}})),
    ...Object.entries({Q:1,T:4,R:8,D:4,P:2,V:4,J:8,S:8}).map(([key,value])=>({key,name:key,type:'integer' as const,unit:'count' as const,min:value,max:value,default:{kind:'integer' as const,value}}))
  ],sources:AssetDocument['sources']=[{kind:'url',url:lock.url,checkedOn:lock.checkedOn},{kind:'note',text:lock.authoredAssumptions.join(' ')}],eq=new Equations('builtin:dsa:formula',parameters,sources),g=new GraphAuthor(eq),root=new GraphAuthor(eq),L='C + Q',K='min(K, C + Q)',F=profile==='sparse-gather'?K:L,rows=allocation==='dynamic'?L:'M';
  const axes=(...a:Axis[])=>a,b=(id:string,n:string):Axis[]=>axes(['b','batch','B'],[id,'hidden',n]),h=b('h','H'),t=b('t','T'),r=b('r','R'),p=b('p','P'),q=axes(['b','batch','B'],['a','head','A'],['d','hidden','D + P']),an=axes(['b','batch','B'],['a','head','A'],['d','hidden','D']),ap=axes(['b','batch','B'],['a','head','A'],['p','hidden','P']),ar=axes(['b','batch','B'],['a','head','A'],['r','hidden','R']);
  const scores=axes(['b','batch','B'],['a','head','A'],['l','token',F]),ij=axes(['b','batch','B'],['i','head','I'],['j','hidden','J']),is=axes(['b','batch','B'],['i','head','I'],['s','custom','ceil(J / S)']),head=b('i','I'),j=b('j','J');
  const assignments:{nodeId:NodeId;groupId:string;streamId:string}[]=[];
  function tensor(id:string,shape:Axis[],dtype=bf16,category:GraphTemplate['storages'][number]['category']='activation',storageId?:string){g.tensor(id,shape,{dtype,category,...(storageId?{storageId}:{})});}
  function weight(id:string,shape:Axis[],dtype=bf16){tensor(id,shape,dtype,'weight');}
  function node(id:string,name:string,ins:string[],outs:string[],work?:string,cls:ComputeClass=matrix,conversion=false,accessBytes?:Record<string,string>,stream='main'){
    g.node(id,name,ins,outs,work?{useful:conversion?'0':work,executed:work,computeClass:cls}:undefined,{...(accessBytes?{accessBytes}:{})});assignments.push({nodeId:NodeId.parse('mla/'+id),groupId:'main',streamId:stream});
  }
  function state(id:string,kind:GraphTemplate['states'][number]['stateKind'],storages:string[],readers:[string,string][],writers:[string,string][]){const endpoint=([nodeId,portId]:[string,string])=>({kind:'node' as const,nodeId:NodeId.parse(nodeId),portId});g.graph.states.push({stateId:StateId.parse(id),name:id,stateKind:kind,allocationBasis:'step_end',storageIds:storages.map(id=>StorageId.parse(id)),creator:{kind:'initialized'},readers:readers.map(endpoint),writers:writers.map(endpoint),updatePolicy:{kind:'append'}});}
  tensor('X',h);g.input('X','x');
  weight('WQA',axes(['h','hidden','H'],['t','hidden','T']));weight('WQN',axes(['t','hidden','T']),fp32);weight('WQB',axes(['t','hidden','T'],['a','head','A'],['d','hidden','D + P']));
  weight('WKVA',axes(['h','hidden','H'],['r','hidden','R + P']));weight('WKVN',axes(['r','hidden','R']),fp32);
  weight('WKVKey',axes(['a','head','A'],['d','hidden','D'],['r','hidden','R']));weight('WKVValue',axes(['a','head','A'],['v','hidden','V'],['r','hidden','R']));weight('WO',axes(['a','head','A'],['v','hidden','V'],['h','hidden','H']));
  for(const [id,shape] of [['QR0',t],['QR',t],['Query',q],['QNope',an],['QPE',ap],['KVRaw',b('r','R + P')],['KV',r],['KPE',p],['Absorbed',ar]] as const)tensor(id,shape);
  tensor('KVCache',axes(['b','batch','B'],['l','token',rows],['r','hidden','R']),bf16,'state');tensor('PECache',axes(['b','batch','B'],['l','token',rows],['p','hidden','P']),bf16,'state');
  node('q-a','Query low-rank projection',['X','WQA'],['QR0'],'2 * B * H * T');node('q-norm','FP32-weight RMSNorm proxy',['QR0','WQN'],['QR'],'5 * B * T',vector);
  node('q-b','Query head projection',['QR','WQB'],['Query'],'2 * B * T * A * (D + P)');node('q-rope','Split nonrotary query and rotate query PE',['Query'],['QNope','QPE'],'3 * B * A * P',vector);
  node('kv-a','Shared latent and rotary-key projection',['X','WKVA'],['KVRaw'],'2 * B * H * (R + P)');node('kv-norm-rope','Normalize latent and rotate separate key PE',['KVRaw','WKVN'],['KV','KPE'],'5 * B * R + 3 * B * P',vector);
  node('cache-write','Fake FP8 latent rounding back to BF16 and append',['KV','KPE'],['KVCache','PECache'],'2 * B * R',vector,true,{KVCache:'2 * B * R',PECache:'2 * B * P'});
  node('absorb','Absorb key slice into query',['QNope','WKVKey'],['Absorbed'],'2 * B * A * D * R');
  if(profile!=='dense'){
    weight('WIQ',axes(['t','hidden','T'],['i','head','I'],['j','hidden','J']));weight('WIK',axes(['h','hidden','H'],['j','hidden','J']));weight('WIKN',axes(['j','hidden','J']),fp32);weight('WIKBias',axes(['j','hidden','J']),fp32);weight('WIW',axes(['h','hidden','H'],['i','head','I']),fp32);
    tensor('IQ0',ij);tensor('IQ',ij);tensor('IQ8',ij,fp8);tensor('IQScale',is,fp32);tensor('IK0',j);tensor('IK',j);tensor('X32',h,fp32);tensor('IW0',head,fp32);tensor('IW',head,fp32);
    tensor('IndexCache',axes(['b','batch','B'],['l','token',rows],['j','hidden','J']),fp8,'state');tensor('IndexScale',axes(['b','batch','B'],['l','token',rows],['s','custom','ceil(J / S)']),fp32,'state');
    tensor('IndexScores',axes(['b','batch','B'],['l','token',L]),fp32);tensor('TopK',axes(['b','batch','B'],['k','custom',K]),int64);
    node('index-query','Indexer query from normalized query rank',['QR','WIQ'],['IQ0'],'2 * B * T * I * J',matrix,false,undefined,'index');node('index-query-rotate','Non-interleaved rotary and Hadamard proxy',['IQ0'],['IQ'],'3 * B * I * P + 4 * B * I * J',vector,false,undefined,'index');
    node('index-query-quant','FP8 query payload and FP32 scale',['IQ'],['IQ8','IQScale'],'2 * B * I * J',vector,true,undefined,'index');
    node('index-key','Independent index key projection',['X','WIK'],['IK0'],'2 * B * H * J',matrix,false,undefined,'index');node('index-key-norm-rotate','FP32 LayerNorm affine, rotary and Hadamard proxy',['IK0','WIKN','WIKBias'],['IK'],'7 * B * J + 3 * B * P + 4 * B * J',vector,false,undefined,'index');
    node('index-cache-write','FP8 key append with separately stored FP32 scale',['IK'],['IndexCache','IndexScale'],'2 * B * J',vector,true,{IndexCache:'B * J',IndexScale:'4 * B * ceil(J / S)'},'index');
    node('index-cast-input','Explicit BF16 input to FP32 weights_proj input',['X'],['X32'],'B * H',vector,true,undefined,'index');node('index-weights','FP32 index head-weight projection',['X32','WIW'],['IW0'],'2 * B * H * I',dsaFp32Matrix,false,undefined,'index');node('index-weight-scales','Apply head normalization, query scale and score scale',['IW0','IQScale'],['IW'],'3 * B * I',vector,false,undefined,'index');
    node('index-scan','Full-prefix FP8 score, rectification, weighted head reduction and key scales',['IQ8','IW','IndexCache','IndexScale'],['IndexScores'],'2 * B * (C + Q) * I * J',dsaFp8Matrix,false,{IndexCache:'B * (C + Q) * J',IndexScale:'4 * B * (C + Q) * ceil(J / S)'},'index');
    const scan=g.graph.nodes.find(n=>n.nodeId==='index-scan');if(scan?.body.kind!=='opaque')throw Error();scan.body.cost.compute.push({segmentId:'fp32-rectify-weight-reduce-scale',computeClass:vector,usefulOperations:eq.value('3 * B * (C + Q) * I','operation'),executedOperations:eq.value('3 * B * (C + Q) * I','operation')});
    node('topk','Forward-local int64 Top-K; bounded selection proxy',['IndexScores'],['TopK'],'B * (C + Q) * ('+K+' + 2)',vector,false,undefined,'index');
    state('index','indexer',['IndexCache','IndexScale'],[['index-scan','IndexCache'],['index-scan','IndexScale']],[['index-cache-write','IndexCache'],['index-cache-write','IndexScale']]);
  }
  let kv='KVCache',pe='PECache';
  if(profile==='sparse-gather'){
    kv='SelectedKV';pe='SelectedPE';tensor(kv,axes(['b','batch','B'],['k','token',K],['r','hidden','R']));tensor(pe,axes(['b','batch','B'],['k','token',K],['p','hidden','P']));
    node('gather','Explicit shared BF16 selected-KV and PE staging',['KVCache','PECache','TopK'],[kv,pe],undefined,matrix,false,{KVCache:'2 * B * ('+K+') * R',PECache:'2 * B * ('+K+') * P'});
  }
  tensor('ScoresKV',scores);tensor('ScoresPE',scores);tensor('Scores',scores);tensor('Probabilities',scores);tensor('Attended',ar);tensor('Values',axes(['b','batch','B'],['a','head','A'],['v','hidden','V']));tensor('Y',h);
  const kvRead='2 * B * ('+F+') * R',peRead='2 * B * ('+F+') * P';
  node('qk-latent','Latent QK over '+F+' positions',['Absorbed',kv],['ScoresKV'],'2 * B * A * ('+F+') * R',matrix,false,{[kv]:kvRead});node('qk-pe','Rotary QK over '+F+' positions',['QPE',pe],['ScoresPE'],'2 * B * A * ('+F+') * P',matrix,false,{[pe]:peRead});
  node('score-add-scale','Add latent/rotary score and apply scale',['ScoresKV','ScoresPE'],['Scores'],'2 * B * A * ('+F+')',vector);
  let softmaxInput='Scores';
  if(profile==='source-mask'){
    tensor('IndexMask',axes(['b','batch','B'],['l','token',L]),fp32);tensor('MaskedScores',scores,bf16,'activation','Scores');
    node('mask','Full-prefix FP32 mask fill/scatter proxy',['TopK'],['IndexMask'],'B * (C + Q) + B * ('+K+')',vector,false,undefined,'index');node('apply-mask','Apply dense selection mask in place',['Scores','IndexMask'],['MaskedScores'],'B * A * (C + Q)',vector);softmaxInput='MaskedScores';
  }
  node('softmax','BF16 probability softmax proxy',[''+softmaxInput],['Probabilities'],'5 * B * A * ('+F+')',vector);node('av','Latent AV over '+F+' positions',['Probabilities',kv],['Attended'],'2 * B * A * ('+F+') * R',matrix,false,{[kv]:kvRead});node('value-expand','Expand with disjoint value slice',['Attended','WKVValue'],['Values'],'2 * B * A * R * V');node('out','Attention output projection',['Values','WO'],['Y'],'2 * B * A * V * H');
  state('kv','latent',['KVCache'],profile==='sparse-gather'?[['gather','KVCache']]:[['qk-latent','KVCache'],['av','KVCache']],[['cache-write','KVCache']]);state('pe','custom',['PECache'],[[profile==='sparse-gather'?'gather':'qk-pe','PECache']],[['cache-write','PECache']]);
  g.output('Y','y');for(const n of g.graph.nodes)n.phases=['decode'];
  const module=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:prefix+':module',revision:1,name:'DSA MLA decode '+profile+' '+allocation,parameters,sources,tags:['research','dsa','decode'],definition:{kind:'module',graph:g.graph}});
  root.tensor('X',axes(['b','batch','B'],['h','hidden',allocation==='provisioned'?'if(C + Q <= M, H, 1 / 0)':'H']));root.input('X','x');root.tensor('Y',h);root.module('mla',module.name,module,'X','Y',parameters);root.output('Y','y');
  const model=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:prefix+':model',revision:1,name:module.name,parameters,sources,tags:['research','dsa','decode','attention-fragment'],extensions:{dsa:{version:'dsa-research.1',profile,allocation,indexerScans:'C+1',attentionPositions:F,selectionLifetime:'forward-local int64 activation',scope:'MLA decode attention only; no block norm/residual/FFN or full model.'}},definition:{kind:'model',family:'deepseek-v32-exp-dsa-fragment',variant:profile+'-'+allocation,graph:root.graph,assumptions:lock.authoredAssumptions,workloadBindings:[['B','batchSize'],['C','contextTokensPerRequest'],['Q','queryTokensPerRequest']].map(([parameterKey,name])=>({phase:'decode',parameterKey:parameterKey??'',value:symbol(name??'')}))}});
  const hardware=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'builtin:hardware:dsa-research',revision:1,name:'Artificial exact-precision DSA arithmetic device',parameters:[],sources:[{kind:'note',text:lock.authoredAssumptions.at(-1)??''}],tags:['synthetic'],definition:{kind:'hardware',hardware:{capacityBytes:4096,computeCapabilities:[[matrix,1000],[dsaFp8Matrix,2000],[dsaFp32Matrix,500],[vector,1000]].map(([computeClass,rate])=>({computeClass,kind:'peak',operationsPerSecond:rate})),memoryCapabilities:[{key:'hbm',kind:'peak',bytesPerSecond:100}],communicationDefaults:[]}}});
  const scenario=Scenario.parse({scenarioId:prefix+':scenario:'+policy,name:profile+' '+allocation+' '+policy,model:ref(model),bindings:[],workload:{kind:'decode',batchSize:1,contextTokensPerRequest:31,queryTokensPerRequest:1,steps:1},deviceTopology:{devices:[{deviceId:'gpu0',hardware:ref(hardware)}],groups:[{groupId:'main',members:['gpu0']}]},parallelPlan:{assignments:[],communications:[],assumptions:lock.authoredAssumptions},executionPlan:policy==='serial'?{kind:'serial'}:{kind:'streams',assignments,extraDependencies:[],resourcePolicy:{kind:policy}},quantizationOverrides:[],numericOverrides:[],fusionGroups:[]});
  return ProjectDocument.parse({documentType:'project',schemaVersion:1,projectId:prefix+':project:'+policy,projectRevision:1,name:scenario.name,scenarios:[scenario],assetSnapshots:[model,module,hardware,...eq.assets],measurements:[],viewState:{nodes:[]}});
}
