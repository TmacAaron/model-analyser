import {AssetDocument,ProjectDocument} from '@model-analyser/contracts';
import {runtimeScaleProject} from '../scripts/runtime-scale-project.js';
/** 9,999 actual leaves with two direct template endpoints; no huge DOM is needed to edit them. */
export function largeCanvasEditProject(count=9999):ProjectDocument{
 const p=runtimeScaleProject('inline',count-1),s=p.scenarios[0];if(!s)throw Error('Missing fixture scenario');
 const model=p.assetSnapshots.find(a=>a.assetId===s.model.assetId);if(model?.definition.kind!=='model')throw Error('Missing fixture model');const repeated=model.definition.graph.nodes[0];if(!repeated)throw Error('Missing repeated node');
 const {repeat:_repeat,...tail}=repeated,edited=AssetDocument.parse({...model,definition:{...model.definition,graph:{...model.definition.graph,nodes:[repeated,{...tail,nodeId:'tail',name:'Final synthetic leaf'}]}}});
 return ProjectDocument.parse({...p,assetSnapshots:p.assetSnapshots.map(a=>a===model?edited:a),scenarios:[s,{...structuredClone(s),scenarioId:s.scenarioId+':second',name:'Second configuration'}]});
}
