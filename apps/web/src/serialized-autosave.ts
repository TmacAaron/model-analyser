import { z } from 'zod';
import { ApiFailure } from './api.js';
export type SaveState={generation:number;status:'dirty'|'saving_draft'|'draft_saved'|'validating'|'committing'|'committed'|'save_failed'|'conflict';message:string};
type DraftEnvelope={draftGeneration:number;candidate:unknown};
export type AutosaveTransport<T,D extends DraftEnvelope>={parseCandidate?:(text:string)=>unknown;createDraft:(candidate:unknown,revision:number|null,generation:number)=>D;writeDraft:(draft:D,requestId:string)=>Promise<void>;commitDraft:(draft:D,requestId:string)=>Promise<{document:T;revision:number;savedRevision?:number}>;validate:(candidate:unknown,signal:AbortSignal)=>string|undefined|Promise<string|undefined>};
type Attempt<D>={draft:D;draftRequestId:string;commitRequestId:string;draftWritten:boolean;commitStarted:boolean;completed:boolean};
export class SerializedAutosaver<T,D extends DraftEnvelope> {
  private queue:Promise<unknown>=Promise.resolve();
  private generation:number;
  private baseRevision:number|null;
  private pending:{text:string;generation:number}|undefined;
  private attempt:Attempt<D>|undefined;
  private validation:{attempt:Attempt<D>;controller:AbortController}|undefined;
  constructor(generation:number,revision:number|null,private transport:AutosaveTransport<T,D>,private notify:(state:SaveState)=>void,private committed:(document:T,draft:D)=>void){this.generation=generation;this.baseRevision=revision;}
  edit(text:string):number {const generation=++this.generation;if(this.validation&&!this.validation.attempt.commitStarted)this.validation.controller.abort();this.pending={text,generation};this.notify({generation,status:'dirty',message:'等待自动保存'});return generation;}
  flush():void {if(this.pending)void this.save(this.pending.text,this.pending.generation);}
  retry(text:string):void {void this.save(text,this.generation);}
  private state(attempt:Attempt<D>,status:SaveState['status'],message:string){if(attempt.draft.draftGeneration===this.generation)this.notify({generation:this.generation,status,message});}
  private async execute(attempt:Attempt<D>):Promise<boolean> {
    if(attempt.completed)return true;
    const draft=attempt.draft;
    try{
      if(!attempt.draftWritten){
        this.state(attempt,'saving_draft','正在写入草稿');
        await this.transport.writeDraft(draft,attempt.draftRequestId);attempt.draftWritten=true;
      }
      this.state(attempt,'draft_saved','草稿已写入');
      // A started commit must replay its exact prepared request even after a newer edit.
      if(!attempt.commitStarted){
        if(draft.draftGeneration!==this.generation){attempt.completed=true;return true;}
        this.state(attempt,'validating','正在校验定义');const validation={attempt,controller:new AbortController()};this.validation=validation;
        let invalid:string|undefined;try{invalid=await this.transport.validate(draft.candidate,validation.controller.signal);}catch(e){if(validation.controller.signal.aborted){attempt.completed=true;return true;}throw e;}finally{if(this.validation===validation)this.validation=undefined;}
        if(validation.controller.signal.aborted||draft.draftGeneration!==this.generation){attempt.completed=true;return true;}
        if(invalid){attempt.completed=true;this.state(attempt,'draft_saved','草稿已保存，待补全：'+invalid);return true;}
      }
      this.state(attempt,'committing','正在提交修订');attempt.commitStarted=true;
      const result=await this.transport.commitDraft(draft,attempt.commitRequestId);
      this.baseRevision=result.revision;attempt.completed=true;this.committed(result.document,draft);this.state(attempt,'committed',`已保存 · 修订 ${result.savedRevision??result.revision}`);return true;
    }catch(error){const message=error instanceof Error?error.message:'保存失败；编辑内容仍保留，可重试或导出';
      if(attempt.draftWritten&&error instanceof ApiFailure&&(error.code==='validation'||error.code==='reference')){
        attempt.completed=true;this.state(attempt,'draft_saved','草稿已保存，待修复：'+message);return true;
      }
      this.state(attempt,error instanceof ApiFailure&&error.code==='conflict'?'conflict':'save_failed',message);return false;
    }
  }
  save(text:string,generation:number):Promise<unknown> {
    const task=this.queue.then(async()=>{
      if(generation!==this.generation)return;
      if(this.pending?.generation===generation)this.pending=undefined;
      // Reconcile a possibly successful previous commit before using its base for newer edits.
      if(this.attempt&&!this.attempt.completed&&this.attempt.commitStarted&&this.attempt.draft.draftGeneration!==generation){
        if(!await this.execute(this.attempt)){this.notify({generation,status:'save_failed',message:'上一批保存结果待确认，请重试；当前编辑仍保留'});return;}
      }
      if(!this.attempt||this.attempt.draft.draftGeneration!==generation){
        let candidate:unknown;try{const parsed:unknown=this.transport.parseCandidate?this.transport.parseCandidate(text):JSON.parse(text);candidate=z.json().safeParse(parsed).success?parsed:text;}catch{candidate=text;}
        const draft=this.transport.createDraft(candidate,this.baseRevision,generation);
        this.attempt={draft,draftRequestId:crypto.randomUUID(),commitRequestId:crypto.randomUUID(),draftWritten:false,commitStarted:false,completed:false};
      }
      await this.execute(this.attempt);
    });
    this.queue=task.catch(()=>undefined);return task;
  }
}
