const MiB=1024*1024;
export const PROJECT_TEXT_BYTES=32*MiB;
// Historical object drafts can occupy64MiB; recovery retains their formatted text.
export const RECOVERY_EDITOR_BYTES=64*MiB;
export const PROJECT_METADATA_BYTES=128*MiB;
export const RECOVERY_ENVELOPE_BYTES=256*MiB;
// Reserve32MiB for a captured formal baseline when a draft is exported.
export const PROJECT_DRAFT_BYTES=224*MiB;
export const LEGACY_PROJECT_DRAFT_BYTES=64*MiB;
// Large recovery files use the raw UTF-8 route, avoiding a second JSON text encoding.
export const PROJECT_IMPORT_REQUEST_BYTES=RECOVERY_ENVELOPE_BYTES;
export const PROJECT_DRAFT_REQUEST_BYTES=RECOVERY_ENVELOPE_BYTES;
export const PROJECT_JSON_DEPTH=512;
export function utf8Bytes(text:string){let bytes=0;for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c<128)bytes++;else if(c<2048)bytes+=2;else if(c>=0xd800&&c<=0xdbff&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff){bytes+=4;i++;}else bytes+=3;}return bytes;}
