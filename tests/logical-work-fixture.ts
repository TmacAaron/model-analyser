import {AssetDocument,type CostDefinition,type ValueExpr} from '@model-analyser/contracts';
import {scopedFusionTimingProject} from './fusion-timing-fixture.js';
import {c01Project} from './model-fixtures.js';

export function scopedLogicalFusionProject(){
 const project=scopedFusionTimingProject(),group=project.scenarios[0]?.fusionGroups[0];
 const module=project.assetSnapshots.find(asset=>asset.assetId===group?.origin?.asset.assetId);
 const preset=module?.fusionPresets?.find(item=>item.presetId===group?.origin?.presetId);
 const operator=c01Project().assetSnapshots.find(asset=>asset.definition.kind==='operator');
 const computeClass=operator?.definition.kind==='operator'?operator.definition.operator.cost.compute[0]?.computeClass:undefined;
 if(!group||!preset||!computeClass)throw Error('Missing logical fusion fixture');
 const work=AssetDocument.parse({documentType:'asset',schemaVersion:1,assetId:'test:logical:fusion-scoped',revision:1,name:'Scoped fusion work',parameters:[],tags:[],sources:[],
  definition:{kind:'formula',formula:{inputs:{b:{unit:'count',integerRequired:true},c:{unit:'count',integerRequired:true}},expression:'b * c',
   output:{unit:'operation',integerRequired:true,nonNegative:true},description:'Extra work in the actual fusion preset scope'}}});
 const expression:ValueExpr={kind:'formula',call:{formula:{assetId:work.assetId,revision:1,kind:'formula'},bindings:{b:{kind:'symbol',name:'B'},c:{kind:'symbol',name:'C'}}}};
 const compute:CostDefinition['compute']=[{segmentId:'scoped-extra',computeClass,usefulOperations:expression,executedOperations:expression}];
 project.assetSnapshots.push(work);
 group.extraCost.compute=compute;
 preset.group.extraCost.compute=structuredClone(compute);
 return project;
}
