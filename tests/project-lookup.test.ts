import {it,expect,vi,afterEach} from 'vitest';
import {lookupProject,ApiFailure} from '../apps/web/src/api.js';
import {c01Project} from './model-fixtures.js';
afterEach(()=>vi.unstubAllGlobals());
it('reads one project by a JSON identity body and forwards cancellation without scanning the workspace',async()=>{
 const project=c01Project();project.projectId='long-identity-'+('中文/../?'.repeat(2048));const requests:{url:unknown;init:RequestInit|undefined}[]=[],controller=new AbortController();
 vi.stubGlobal('fetch',async(url:unknown,init?:RequestInit)=>{requests.push({url,init});return new Response(JSON.stringify({ok:true,data:project}));});expect(await lookupProject(project.projectId,{signal:controller.signal})).toEqual(project);expect(requests).toHaveLength(1);const request=requests[0];if(!request)throw Error();expect(request.url).toBe('/api/v1/project');expect(request.init?.method).toBe('POST');expect(request.init?.signal).toBe(controller.signal);expect(JSON.parse(String(request.init?.body))).toEqual({projectId:project.projectId});
});
it('treats only explicit not_found as an absent project and preserves malformed-file/version/read failures',async()=>{
 let code='not_found';vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({ok:false,error:{code,message:'source retained',fieldIssues:[]}})));expect(await lookupProject('missing')).toBeNull();for(const next of ['validation','unsupported_version','io']){code=next;await expect(lookupProject('existing-but-unreadable')).rejects.toBeInstanceOf(ApiFailure);}
});
