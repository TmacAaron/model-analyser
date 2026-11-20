import { AssetDocument,ProjectDocument,Scenario,NodeId,TensorId,StorageId,StateId,type Shape,type GraphTemplate } from '@model-analyser/contracts';
import { GraphAuthor,Equations,bf16,fp32,matrix,vector,literal,symbol,ref } from './model-authoring.js';
import lock from '../references/parallel/csa2-source-lock.json' with {type:'json'};
export type CsaProfile='independent'|'kv-only'|'csa2';
export type CsaStorage='packed'|'bf16';
export type CsaPolicy='serial'|'ideal'|'shared_bandwidth';
type Axis=[string,Shape[number]['semantic'],string];
type StateSpec=GraphTemplate['states'][number];
type QuantizedStorageSpec=NonNullable<Extract<GraphTemplate['storages'][number]['allocation'],{kind:'tensor'}>['quantization']>;
const int32={category:'int' as const,bits:32,format:'int32'},u8={category:'uint' as const,bits:8,format:'uint8'},scale=(format:string)=>({category:'float' as const,bits:8,format});

/** Source-locked mechanism fragment expressed only as ordinary portable graph assets. */
export function makeCsa2Project(profile:CsaProfile='csa2',policy:CsaPolicy='serial',storage:CsaStorage='packed'):ProjectDocument{
  const prefix='builtin:csa2:'+profile+':'+storage,parameters:AssetDocument['parameters']=[
    ...[['B',1,1,512],['C',5,0,4096],['H',4,1,128]].map(([key,value,min,max])=>({key:String(key),name:String(key),type:'integer' as const,unit:'count' as const,min:Number(min),max:Number(max),default:{kind:'integer' as const,value:Number(value)}})),
    ...Object.entries({Q:1,D:16,J:8,R:2,O:2,W:2,K:2,BS:2}).map(([key,value])=>({key,name:key,type:'integer' as const,unit:'count' as const,min:value,max:value,default:{kind:'integer' as const,value}}))
  ],sources:AssetDocument['sources']=[{kind:'url',url:lock.url,checkedOn:lock.checkedOn},{kind:'note',text:lock.authoredAssumptions.join(' ')}],eq=new Equations(prefix+':formula',parameters,sources),assets:AssetDocument[]=[],root=new GraphAuthor(eq),L='C + Q',slots='min(K, C + Q)',recent='min(K, C + Q - floor((C + Q - 1) / BS) * BS)',window='min(W, C + Q)';
  const h:Axis[]=[['b','batch','B'],['h','hidden','H']],d:Axis[]=[['b','batch','B'],['d','hidden','D']],j:Axis[]=[['b','batch','B'],['j','hidden','J']],rank:Axis[]=[['b','batch','B'],['r','hidden','R']],outRank:Axis[]=[['b','batch','B'],['o','hidden','O']],mainShape:Axis[]=[['b','batch','B'],['t','token',L],['d','hidden','D']],indexShape:Axis[]=[['b','batch','B'],['t','token',L],['j','hidden','J']],winShape:Axis[]=[['b','batch','B'],['t','token',window],['d','hidden','D']],idxShape:Axis[]=[['b','batch','B'],['k','custom',slots]],scoreShape:Axis[]=[['b','batch','B'],['t','token',L]];
  const mainRow=storage==='packed'?'D / 2 + ceil(D / 16)':'2 * D',indexRow=storage==='packed'?'J / 2 + ceil(J / 32)':'2 * J',windowRow=storage==='packed'?'D + ceil(D / 32)':'2 * D';
  function cache(g:GraphAuthor,id:string,shape:Axis[],kind:'main'|'index'|'window'){
    g.tensor(id,shape,{category:'state'});const spec=g.graph.storages.find(s=>s.storageId===id);
    if(storage==='packed'&&spec?.allocation.kind==='tensor'){
      const q:QuantizedStorageSpec={payloadBits:kind==='window'?8:4,packingUnitElements:kind==='window'?1:2,alignmentBytes:1,auxiliaries:[{name:'row-scales',dtype:scale(kind==='main'?'e4m3':'e8m0'),count:{kind:'block',axes:[{axisId:kind==='index'?'j':'d',blockSize:kind==='main'?16:32}]}}]};spec.allocation.quantization=q;
    }
  }
  const endpoint=(nodeId:string,portId:string)=>({kind:'node' as const,nodeId:NodeId.parse(nodeId),portId});
  function state(g:GraphAuthor,id:string,kind:StateSpec['stateKind'],tensor:string,readers:[string,string][],writers:[string,string][]){g.graph.states.push({stateId:StateId.parse(id),name:id,stateKind:kind,allocationBasis:'step_end',storageIds:[StorageId.parse(tensor)],creator:{kind:'initialized'},readers:readers.map(([n,p])=>endpoint(n,p)),writers:writers.map(([n,p])=>endpoint(n,p)),updatePolicy:kind==='window'?{kind:'windowed',window:symbol('W')}:{kind:'append'}});}
  const globalGroups=profile==='independent'?4:1;
  for(let group=0;group<globalGroups;group++){cache(root,'Main'+group,mainShape,'main');cache(root,'Index'+group,indexShape,'index');state(root,'main'+group,'latent','Main'+group,[],[]);state(root,'index'+group,'indexer','Index'+group,[],[]);}
  root.tensor('X',h);root.input('X','x');root.tensor('Candidates',scoreShape,{dtype:u8});for(const i of [0,1,2,3]){root.tensor('Z'+i,h);if(profile!=='csa2'||i===0||i===2)root.tensor('TopK'+i,idxShape,{dtype:int32});}
  const producer=new Map<string,{nodeId:string;portId:string}>(),streamAssignments:{nodeId:NodeId;groupId:string;streamId:string}[]=[];
  for(let layer=0;layer<4;layer++){
    const full=profile==='independent'||layer===0,indexer=full||profile==='kv-only'||layer===2,group=profile==='independent'?layer:0,reused=layer===1?0:2,valid=layer===0||!indexer&&reused===0?slots:recent,p='('+window+' + '+valid+')',g=new GraphAuthor(eq),id='layer'+layer;
    g.tensor('X',h);g.input('X','x');cache(g,'Main',mainShape,'main');if(!full)g.input('Main','main');if(indexer){cache(g,'Index',indexShape,'index');if(!full)g.input('Index','index');}
    cache(g,'Window',winShape,'window');g.tensor('TopK',idxShape,{dtype:int32});if(!indexer)g.input('TopK','indices');if(layer>0&&indexer){g.tensor('Candidates',scoreShape,{dtype:u8});g.input('Candidates','candidates');}
    function weight(w:string,shape:Axis[]){g.tensor(w,shape,{category:'weight'});}
    function node(n:string,name:string,ins:string[],outs:string[],ops?:string,vectorWork=false,accessBytes?:Record<string,string>,stream='attention'){
      g.node(n,name,ins,outs,ops?{useful:ops,computeClass:vectorWork?vector:matrix}:undefined,{...(accessBytes?{accessBytes}:{})});streamAssignments.push({nodeId:NodeId.parse(id+'/'+n),groupId:'main',streamId:stream});
    }
    const dep=(from:string,to:string)=>g.graph.dependencies.push({edgeId:from+'-before-'+to,fromNodeId:NodeId.parse(from),toNodeId:NodeId.parse(to),kind:'control'});
    weight('WQA',[['h','hidden','H'],['r','hidden','R']]);weight('WQB',[['r','hidden','R'],['d','hidden','D']]);weight('WW',[['h','hidden','H'],['d','hidden','D']]);weight('WOA',[['d','hidden','D'],['o','hidden','O']]);weight('WOB',[['o','hidden','O'],['h','hidden','H']]);
    weight('WQN',[['r','hidden','R']]);weight('WWN',[['d','hidden','D']]);g.tensor('Sink',[['c','custom','1']],{category:'weight',dtype:fp32});
    g.tensor('QR0',rank);g.tensor('QR',rank);g.tensor('Q0',d);g.tensor('Q',d);g.tensor('RawWindow',d);
    node('q-a','Query low-rank projection',['X','WQA'],['QR0'],'2 * B * H * R');node('q-norm','Query RMSNorm proxy',['QR0','WQN'],['QR'],'5 * B * R',true);node('q-b','Query head projection',['QR','WQB'],['Q0'],'2 * B * R * D');node('q-rope','Query rotary proxy',['Q0'],['Q'],'6 * B * D / 4',true);
    node('window-project','Layer-local window projection',['X','WW'],['RawWindow'],'2 * B * H * D',false,undefined,'window');node('window-pack','Window norm/rotary/fake-quant proxy and ring write',['RawWindow','WWN'],['Window'],'8 * B * D',true,{Window:'B * ('+windowRow+')'},'window');
    if(full){
      weight('WM',[['h','hidden','H'],['d','hidden','D']]);weight('WIK',[['d','hidden','D'],['j','hidden','J']]);weight('WMN',[['d','hidden','D']]);weight('WIKN',[['j','hidden','J']]);g.tensor('RawMain',d);g.tensor('Latent',d);g.tensor('IndexRaw',j);
      node('main-project','Ratio-one global KV projection',['X','WM'],['RawMain'],'2 * B * H * D',false,undefined,'index');node('main-norm','Normalize the shared pre-rotary latent',['RawMain','WMN'],['Latent'],'5 * B * D',true,undefined,'index');node('index-key','Shared indexer key projection before rotary',['Latent','WIK'],['IndexRaw'],'2 * B * D * J',false,undefined,'index');node('index-pack','Index key norm/rotary/fake-quant proxy and append',['IndexRaw','WIKN'],['Index'],'8 * B * J',true,{Index:'B * ('+indexRow+')'},'index');
    }
    if(indexer){
      weight('WIQ',[['r','hidden','R'],['j','hidden','J']]);weight('WIW',[['h','hidden','H'],['c','custom','1']]);g.tensor('IQ0',j);g.tensor('IQ',j);g.tensor('IW',[['b','batch','B'],['c','custom','1']]);g.tensor('IndexScores',scoreShape,{dtype:fp32});g.tensor('IndexActivated',scoreShape,{dtype:fp32});
      node('index-query','Indexer query projection',['QR','WIQ'],['IQ0'],'2 * B * R * J',false,undefined,'index');if(full)dep('index-pack','index-query');node('index-query-pack','Indexer query rotary/fake-quant proxy',['IQ0'],['IQ'],'8 * B * J',true,undefined,'index');
      node('index-weight','Indexer head weight projection',['X','WIW'],['IW'],'2 * B * H',false,undefined,'index');dep('index-query-pack','index-weight');
      node('index-scores','Materialized full index scores',['IQ','Index'],['IndexScores'],'2 * B * (C + Q) * J',false,{Index:'B * (C + Q) * ('+indexRow+')'},'index');dep('index-weight','index-scores');
      if(storage==='packed'){
        const score=g.graph.nodes.find(n=>n.nodeId==='index-scores');if(score?.body.kind!=='opaque')throw Error('Missing index score leaf');
        score.name='Materialized full index scores with explicit register key unpack';const unpack=eq.value('2 * B * (C + Q) * J','operation');score.body.cost.compute.push({segmentId:'index-key-register-unpack',computeClass:vector,usefulOperations:literal(0,'operation'),executedOperations:unpack});
      }
      node('index-activate','Rectification and scalar weighting proxy',['IndexScores','IW'],['IndexActivated'],'2 * B * (C + Q)',true,undefined,'index');
      let selected='IndexActivated';
      if(layer===0){g.tensor('Candidates',scoreShape,{dtype:u8});node('candidates','Latest block candidate mask; max/select/materialization proxy',['IndexActivated'],['Candidates'],'2 * B * (C + Q) + 2 * B * ceil((C + Q) / BS)',true,undefined,'index');}
      else {g.tensor('MaskedScores',scoreShape,{dtype:fp32});node('candidate-mask','Mask full scores with the first source candidate pool',['IndexActivated','Candidates'],['MaskedScores'],'B * (C + Q)',true,undefined,'index');selected='MaskedScores';}
      node('topk','Top-K selection/sort/unreachable-mask proxy',[''+selected],['TopK'],'3 * B * (C + Q)',true,undefined,'index');if(layer===0)dep('candidates','topk');
    }
    if(full){node('main-pack','Main KV rotary/fake-quant proxy and append',['Latent'],['Main'],'3 * B * D',true,{Main:'B * ('+mainRow+')'},'index');dep('topk','main-pack');}
    g.tensor('Gathered',[['b','batch','B'],['p','token',p],['d','hidden','D']]);g.tensor('Scores',[['b','batch','B'],['p','token',p]],{dtype:fp32});g.tensor('Probabilities',[['b','batch','B'],['p','token',p]],{dtype:fp32});g.tensor('Attended',d);g.tensor('Rotated',d);g.tensor('O',outRank);g.tensor('Y',h);g.tensor('Z',h);
    node('gather','Gather selected main/window rows into distinct BF16 staging',['Main','Window','TopK'],['Gathered'],storage==='packed'?'2 * B * D * '+p:undefined,true,{Main:'B * '+valid+' * ('+mainRow+')',Window:'B * '+window+' * ('+windowRow+')'});
    if(storage==='packed'){const gather=g.graph.nodes.find(n=>n.nodeId==='gather');if(gather?.body.kind!=='opaque')throw Error('Missing gather leaf');for(const segment of gather.body.cost.compute)segment.usefulOperations=literal(0,'operation');}
    dep('q-rope','gather');
    node('qk','Sparse latent QK',['Q','Gathered'],['Scores'],'2 * B * D * '+p);node('softmax','Materialized sink-softmax proxy',['Scores','Sink'],['Probabilities'],'5 * B * ('+p+' + 1)',true);node('av','Sparse latent AV',['Probabilities','Gathered'],['Attended'],'2 * B * D * '+p);node('out-rope','Inverse rotary proxy',['Attended'],['Rotated'],'6 * B * D / 4',true);node('out-a','Output low-rank projection',['Rotated','WOA'],['O'],'2 * B * D * O');node('out-b','Output hidden projection',['O','WOB'],['Y'],'2 * B * O * H');node('residual','Attention residual',['X','Y'],['Z'],'B * H',true);
    state(g,'main','latent','Main',[['gather','Main']],full?[['main-pack','Main']]:[]);if(indexer)state(g,'index','indexer','Index',[['index-scores','Index']],full?[['index-pack','Index']]:[]);state(g,'window','window','Window',[['gather','Window']],[['window-pack','Window']]);
    g.output('Z','y');if(full){g.output('Main','main-out');g.output('Index','index-out');}if(indexer)g.output('TopK','indices-out');if(layer===0)g.output('Candidates','candidates-out');for(const n of g.graph.nodes)n.phases=['decode'];
    const mode=full?'Full':indexer?'Reindex':'Reuse',module=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:prefix+':module:'+id,revision:1,name:'CSA2 '+mode+' · source layer '+[20,21,24,25][layer]+' · '+profile+' '+storage,parameters,sources,tags:['research','csa2',mode.toLowerCase()],extensions:{csa2:{mode,sourceLayer:[20,21,24,25][layer],profile,storage,globalGroup:group,indicesSource:indexer?layer:reused}},definition:{kind:'module',graph:g.graph}});assets.push(module);
    const bindings:Record<string,string>={x:layer===0?'X':'Z'+(layer-1),y:'Z'+layer,...(full?{'main-out':'Main'+group,'index-out':'Index'+group}:{main:'Main'+group}),...(indexer&&!full?{index:'Index'+group}:{}),...(indexer?{'indices-out':'TopK'+layer}:{indices:'TopK'+reused}),...(layer===0?{'candidates-out':'Candidates'}:indexer?{candidates:'Candidates'}:{})};
    root.graph.nodes.push({nodeId:NodeId.parse(id),name:module.name,phases:['decode'],stateBindings:[{localStateId:StateId.parse('main'),parentStateId:StateId.parse('main'+group)},...(indexer?[{localStateId:StateId.parse('index'),parentStateId:StateId.parse('index'+group)}]:[])],portBindings:Object.entries(bindings).map(([portId,tensorId])=>({portId,tensorId:TensorId.parse(tensorId)})),body:{kind:'module',asset:ref(module),bindings:parameters.map(p=>({parameterKey:p.key,value:symbol(p.key)}))}});
    for(const input of g.graph.inputs){const tensor=bindings[input.portId];if(!tensor)throw Error('Unbound input');const prior=producer.get(tensor);root.graph.edges.push({edgeId:id+'-'+input.portId,from:prior?endpoint(prior.nodeId,prior.portId):{kind:'graph_input',portId:'x'},to:endpoint(id,input.portId),tensorId:TensorId.parse(tensor)});}
    for(const output of g.graph.outputs){const tensor=bindings[output.portId];if(!tensor)throw Error('Unbound output');producer.set(tensor,{nodeId:id,portId:output.portId});}
  }
  root.graph.outputs=[{portId:'y',tensorId:TensorId.parse('Z3')}];root.graph.edges.push({edgeId:'model-output',from:endpoint('layer3','y'),to:{kind:'graph_output',portId:'y'},tensorId:TensorId.parse('Z3')});
  const model=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:prefix+':model',revision:1,name:'CSA2 decoder reuse fragment · '+profile+' '+storage,parameters,sources,tags:['research','csa2','attention-fragment'],extensions:{csa2:{sourceLayers:[20,21,24,25],profile,storage,globalGroups,indexerExecutions:profile==='csa2'?2:4,topkLifetime:'forward-local activation; no cross-call reuse'}},definition:{kind:'model',family:'deepseek-v41-fragment',variant:profile+'-'+storage,graph:root.graph,assumptions:lock.authoredAssumptions,workloadBindings:[['B','batchSize'],['C','contextTokensPerRequest'],['Q','queryTokensPerRequest']].map(([parameterKey,name])=>({phase:'decode',parameterKey:parameterKey??'',value:symbol(name??'')}))}});
  const hardware=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'builtin:hardware:csa2-research',revision:1,name:'Artificial CSA2 arithmetic device',parameters:[],sources:[{kind:'note',text:lock.authoredAssumptions.at(-1)??''}],tags:['synthetic'],definition:{kind:'hardware',hardware:{capacityBytes:4096,computeCapabilities:[matrix,vector].map(computeClass=>({computeClass,kind:'peak',operationsPerSecond:1000})),memoryCapabilities:[{key:'hbm',kind:'peak',bytesPerSecond:100}],communicationDefaults:[]}}});assets.push(model,hardware,...eq.assets);
  const s=Scenario.parse({scenarioId:prefix+':scenario:'+policy,name:profile+' '+storage+' '+policy,model:ref(model),bindings:[],workload:{kind:'decode',batchSize:1,contextTokensPerRequest:5,queryTokensPerRequest:1,steps:1},deviceTopology:{devices:[{deviceId:'gpu0',hardware:ref(hardware)}],groups:[{groupId:'main',members:['gpu0']}]},parallelPlan:{assignments:[],communications:[],assumptions:lock.authoredAssumptions},executionPlan:policy==='serial'?{kind:'serial'}:{kind:'streams',assignments:streamAssignments,extraDependencies:[],resourcePolicy:{kind:policy}},quantizationOverrides:[],numericOverrides:[],fusionGroups:[]});
  return ProjectDocument.parse({documentType:'project',schemaVersion:1,projectId:prefix+':project:'+policy,projectRevision:1,name:s.name,scenarios:[s],assetSnapshots:assets,measurements:[],viewState:{nodes:[]}});
}
