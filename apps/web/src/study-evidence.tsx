import { useState,type ReactNode } from 'react';

export function StudyEvidenceDetails({summary,render,className}:{summary:string;render:()=>ReactNode;className?:string}){
  const [open,setOpen]=useState(false);
  return <details className={className} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>{summary}</summary>
    {open&&render()}
  </details>;
}

export function StudyEvidencePager({label,page,size,total,onChange}:{label:string;page:number;size:number;total:number;onChange:(page:number)=>void}){
  if(total<=size)return null;
  return <nav className="asset-actions" aria-label={label+'分页'}>
    <button type="button" disabled={page===0} onClick={()=>onChange(page-1)}>上一页{label}</button>
    <span aria-live="polite">{label} {page*size+1}–{Math.min((page+1)*size,total)} / {total}</span>
    <button type="button" disabled={(page+1)*size>=total} onClick={()=>onChange(page+1)}>下一页{label}</button>
  </nav>;
}
