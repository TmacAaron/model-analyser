import type { AssetDocument,Diagnostic,Scenario } from '@model-analyser/contracts';

export type StudyAttempt<Result extends object=object>={status:'available';result:Result}|{status:'unavailable';diagnostics:Diagnostic[]};
export type StudyStart<Request>={scenario:Scenario;assets:AssetDocument[];request:Request};
export type StudyRequest<Request>={kind:'start'}&StudyStart<Request>
  |{kind:'cancel'}
  |{kind:'export';jobId:number}
  |{kind:'cancel-export';jobId:number};
export type StudySerialization={blob:Blob}|{message:string};
export type StudyReply<Attempt>=
  |{kind:'progress';completed:number;total:number}
  |{kind:'result';attempt:Attempt}
  |{kind:'failed';message:string}
  |({kind:'exported';jobId:number}&StudySerialization);
