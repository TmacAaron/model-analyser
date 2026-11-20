import {useDeferredValue,useMemo,useState} from 'react';
import type {CanvasNode} from './canvas-graph.js';

export function CanvasNodeNavigator({nodes,onLocate}:{nodes:CanvasNode[];onLocate:(node:CanvasNode)=>void}){
  const [open,setOpen]=useState(false),[query,setQuery]=useState('');
  const search=useDeferredValue(query).trim().toLowerCase();
  const {matches,total}=useMemo(()=>{
    const matches:CanvasNode[]=[];
    let total=0;
    if(search)for(const node of nodes){
      const id=node.id.toLowerCase();
      if(!id.includes(search)&&!node.name.toLowerCase().includes(search))continue;
      total++;
      if(id===search)matches.unshift(node);
      else if(matches.length<20)matches.push(node);
    }
    return {matches:matches.slice(0,20),total};
  },[nodes,search]);
  return <div className="canvas-navigator" onKeyDown={event=>{
    if(event.key==='Escape'){event.stopPropagation();setOpen(false);event.currentTarget.querySelector('button')?.focus();}
  }}>
    <button aria-expanded={open} onClick={()=>setOpen(!open)}>查找节点</button>
    {open&&<section className="canvas-navigator-panel" aria-label="画布节点定位">
      <label>节点名称或 ID<input autoFocus aria-label="查找画布节点" value={query} onChange={event=>setQuery(event.target.value)}/></label>
      {search&&<p role="status">{total?('显示 '+matches.length+' / '+total+' 个节点'):'没有匹配节点'}</p>}
      {matches.map(node=><button key={node.id} aria-label={'定位 '+node.id} onClick={()=>{onLocate(node);setOpen(false);}}>
        <strong>{node.name}</strong><small>{node.id}</small>
      </button>)}
    </section>}
  </div>;
}
