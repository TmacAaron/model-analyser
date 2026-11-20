import {randomUUID} from 'node:crypto';
import {c01Project} from './model-fixtures.js';
import {PROJECT_TEXT_BYTES} from '../packages/contracts/src/project-limits.js';
/** Independent native JSON/UTF8 ledger, including the writer's final newline. */
export function projectAtFileBoundary(bytes=PROJECT_TEXT_BYTES){
 const project=c01Project();project.projectId=randomUUID();project.projectRevision=1;
 const snapshot=project.assetSnapshots[0];if(!snapshot)throw Error('Missing fixture snapshot');snapshot.description='';
 const overhead=Buffer.byteLength(JSON.stringify(project,null,2)+'\n'),fragment='中😀\\\n',unit=Buffer.byteLength(JSON.stringify(fragment))-2,remaining=bytes-overhead;
 if(remaining<0)throw Error('Boundary smaller than fixture');snapshot.description=fragment.repeat(Math.floor(remaining/unit))+'x'.repeat(remaining%unit);
 if(Buffer.byteLength(JSON.stringify(project,null,2)+'\n')!==bytes)throw Error('Native byte ledger mismatch');return project;
}
