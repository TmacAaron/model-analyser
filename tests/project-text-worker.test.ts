import {it,expect,vi,afterEach} from 'vitest';
import {stringify} from 'yaml';
import {c01Project} from './model-fixtures.js';
import {evaluateProjectTextTask,ProjectTextReply,type ProjectTextTask} from '../apps/web/src/project-text-worker.js';
import {runProjectTextTask} from '../apps/web/src/project-text-task.js';
afterEach(()=>vi.unstubAllGlobals());
it('allows unfinished display names in a strict preview but rejects them for formal submission',()=>{
 const project=c01Project();project.name='';const text=JSON.stringify(project),preview=evaluateProjectTextTask({taskId:'p',kind:'preview',format:'json',text}).reply,validation=evaluateProjectTextTask({taskId:'v',kind:'validate',format:'json',text}).reply;
 expect(preview.kind).toBe('preview');if(preview.kind!=='preview')throw Error();expect(preview.project?.name).toBe('');expect(preview.header).toEqual({isProjectV1:true,projectId:project.projectId});expect(preview.issues).toEqual([]);expect(validation.kind).toBe('validated');if(validation.kind!=='validated')throw Error();expect(validation.issue).toContain('name');
});
it('keeps valid identity hints for malformed project shapes, rejects unknown/version fields and returns bounded issues without a partial project',()=>{
 const p=c01Project();for(const value of [{...p,extra:true},{...p,schemaVersion:2},{...p,scenarios:null}]){const reply=evaluateProjectTextTask({taskId:'x',kind:'preview',text:JSON.stringify(value),format:'json'}).reply;expect(reply.kind).toBe('preview');if(reply.kind!=='preview')throw Error();expect(reply.project).toBeUndefined();expect(reply.issues.length).toBeGreaterThan(0);expect(reply.issues.length).toBeLessThanOrEqual(6);expect(reply.header.projectId).toBe(p.projectId);}
});
it('parses BOM/CRLF YAML and rewrites its identity with comments; malformed and cyclic YAML never become preview projects',()=>{
 const p=c01Project(),text='\uFEFF# keep identity note\r\n'+stringify(p).replaceAll('\n','\r\n'),preview=evaluateProjectTextTask({taskId:'p',kind:'preview',format:'yaml',text}).reply;expect(preview.kind).toBe('preview');if(preview.kind!=='preview')throw Error();expect(preview.project).toEqual(p);const rewritten=evaluateProjectTextTask({taskId:'i',kind:'identity',format:'yaml',text,projectId:'new-identity'}).reply;expect(rewritten.kind).toBe('identity');if(rewritten.kind!=='identity')throw Error();expect(rewritten.text).toContain('# keep identity note');const result=evaluateProjectTextTask({taskId:'r',kind:'preview',format:'yaml',text:rewritten.text}).reply;if(result.kind!=='preview')throw Error();expect(result.project?.projectId).toBe('new-identity');for(const broken of ['a: [','a: 1\na: 2','a: &a [*a]']){const reply=evaluateProjectTextTask({taskId:'b',kind:'preview',format:'yaml',text:broken}).reply;expect(reply.kind).toBe('preview');if(reply.kind!=='preview')throw Error();expect(reply.project).toBeUndefined();expect(reply.issues.length).toBeGreaterThan(0);}
});
class WorkerStub{
 static instances:WorkerStub[]=[];onmessage:((event:MessageEvent<unknown>)=>void)|null=null;onerror:(()=>void)|null=null;terminated=false;task:unknown;
 constructor(){WorkerStub.instances.push(this);}postMessage(task:unknown){this.task=task;}terminate(){this.terminated=true;}reply(data:unknown){this.onmessage?.({data} as MessageEvent<unknown>);}
}
it.each(['foreign-task','wrong-phase','wrong-project','bad-shape'])('rejects %s worker replies and terminates the task',async mode=>{
 WorkerStub.instances=[];vi.stubGlobal('Worker',WorkerStub);const task:ProjectTextTask={taskId:'current',kind:'preview',text:'{}',format:'json'},pending=runProjectTextTask(task,new AbortController().signal),worker=WorkerStub.instances[0];if(!worker)throw Error();const project=c01Project(),reply=mode==='wrong-phase'?{kind:'validated'}:{kind:'preview',header:{isProjectV1:true,projectId:mode==='wrong-project'?'other':project.projectId},project:mode==='bad-shape'?{}:project,issues:[]};worker.reply({taskId:mode==='foreign-task'?'old':'current',reply});await expect(pending).rejects.toThrow();expect(worker.terminated).toBe(true);
});
it('aborts and terminates the worker, ignores its late reply and never creates a worker for a pre-aborted request',async()=>{
 WorkerStub.instances=[];vi.stubGlobal('Worker',WorkerStub);const task:ProjectTextTask={taskId:'current',kind:'validate',text:'{}',format:'json'},controller=new AbortController(),pending=runProjectTextTask(task,controller.signal),worker=WorkerStub.instances[0];if(!worker)throw Error();controller.abort();await expect(pending).rejects.toThrow('取消');expect(worker.terminated).toBe(true);worker.reply({taskId:'current',reply:{kind:'validated'}});await expect(runProjectTextTask(task,AbortSignal.abort())).rejects.toThrow('取消');expect(WorkerStub.instances).toHaveLength(1);
});
it('the reply boundary rejects invalid envelopes while complete preview validation stays in the worker',()=>{expect(ProjectTextReply.safeParse({taskId:'x',reply:{kind:'preview',project:{},header:{isProjectV1:true},issues:[]}}).success).toBe(false);});
