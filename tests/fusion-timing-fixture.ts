import {AssetDocument,NodeId} from '@model-analyser/contracts';
import {makeDeclarationFusionProject} from '../scripts/declaration-source-project.js';
import {c01Project} from './model-fixtures.js';

/** Root B=2, actual preset scope A has B=3, and C follows the selected Decode call. */
export function scopedFusionTimingProject(){
 const project=makeDeclarationFusionProject(c01Project()),scenario=project.scenarios[0]!,group=scenario.fusionGroups[0]!;
 const model=project.assetSnapshots.find(asset=>asset.assetId===scenario.model.assetId);
 const module=project.assetSnapshots.find(asset=>asset.assetId===group.origin?.asset.assetId);
 if(model?.definition.kind!=='model'||module?.definition.kind!=='module'||scenario.workload.kind!=='decode')throw Error('Missing scoped fusion fixture');
 const call=model.definition.graph.nodes.find(node=>node.nodeId===group.origin?.scopeNodeId);
 const preset=module.fusionPresets?.find(item=>item.presetId===group.origin?.presetId);
 if(call?.body.kind!=='module'||!preset)throw Error('Missing actual fusion preset');
 const contextParameter={key:'C',name:'Actual context',type:'integer' as const,unit:'count' as const,default:{kind:'integer' as const,value:1}};
 model.parameters.push(contextParameter);
 module.parameters.push(contextParameter);
 model.definition.workloadBindings=[{parameterKey:'C',phase:'decode',value:{kind:'symbol',name:'contextTokensPerRequest'}}];
 call.body.bindings.push({parameterKey:'C',value:{kind:'symbol',name:'C'}});
 scenario.workload={...scenario.workload,contextTokensPerRequest:2,queryTokensPerRequest:1,steps:3};
 scenario.numericOverrides.push({target:{kind:'node',nodeId:NodeId.parse('A')},field:'parameter',parameterKey:'B',value:{value:3,unit:'count'}});
 const rate=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'test:fusion:scoped-timing',revision:1,name:'Scoped fusion time',parameters:[],tags:[],sources:[],
  definition:{kind:'formula',formula:{inputs:{b:{unit:'count',integerRequired:true},c:{unit:'count',integerRequired:true}},
   expression:'b * c * 0.001',output:{unit:'second',integerRequired:false,nonNegative:true},description:'Authored test formula using a scoped parameter and actual context'}}});
 project.assetSnapshots.push(rate);
 group.timeStrategy={kind:'override',description:'Explicit total time in the actual preset scope',timing:{kind:'custom_formula',description:'B times C milliseconds',
  seconds:{kind:'formula',call:{formula:{assetId:rate.assetId,revision:1,kind:'formula'},bindings:{b:{kind:'symbol',name:'B'},c:{kind:'symbol',name:'C'}}}}}};
 preset.group.timeStrategy=structuredClone(group.timeStrategy);
 return project;
}
