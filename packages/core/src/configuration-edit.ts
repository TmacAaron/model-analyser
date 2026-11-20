import { type ProjectDocument } from '@model-analyser/contracts';
import { prepareConfigurationEdit } from '../../contracts/src/configuration-edit.js';
import { validateProject } from '../../contracts/src/validation.js';
import { analyzeScenario } from './analyze.js';

/** Validate the complete candidate before replacing any effective configuration. */
export async function applyConfigurationEdit(project:ProjectDocument,scenarioId:string):Promise<ProjectDocument>{
  const next=prepareConfigurationEdit(project,scenarioId),scenario=next.scenarios.find(s=>s.scenarioId===scenarioId);if(!scenario)throw Error('当前配置不存在');const issues=validateProject(next).filter(d=>d.severity==='error');if(issues.length)throw Error(issues.map(d=>d.message).join('；'));
  const proof=await analyzeScenario(scenario,next.assetSnapshots);if(proof.status!=='available')throw Error(proof.diagnostics.map(d=>d.message).join('；'));return next;
}
