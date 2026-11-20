import { useEffect,useRef,useState } from 'react';
import type { CanvasEditControls,CanvasEditIntent } from './canvas-edit-worker.js';

export function useCanvasEdit(onApply:(intent:CanvasEditIntent,controls:CanvasEditControls)=>Promise<void>,active=true){
  const [error,setError]=useState('');
  const [phase,setPhase]=useState<'idle'|'preparing'|'publishing'>('idle');
  const running=useRef<AbortController|null>(null);
  const lastIntent=useRef<CanvasEditIntent|null>(null);

  useEffect(()=>()=>{
    running.current?.abort();
    running.current=null;
  },[]);
  useEffect(()=>{if(!active)running.current?.abort();},[active]);

  async function submit(intent:CanvasEditIntent){
    const controller=new AbortController();
    running.current?.abort();
    running.current=controller;
    lastIntent.current=intent;
    setPhase('preparing');
    setError('');
    try{
      await onApply(intent,{signal:controller.signal,onPublishing:()=>{
        if(running.current===controller)setPhase('publishing');
      }});
      if(running.current===controller)lastIntent.current=null;
    }catch(e){
      if(running.current===controller)setError(e instanceof Error?e.message:String(e));
    }finally{
      if(running.current===controller){
        running.current=null;
        setPhase('idle');
      }
    }
  }

  return {phase,error,busy:phase!=='idle',submit,
    cancel:()=>running.current?.abort(),
    retry:()=>{if(lastIntent.current)void submit(lastIntent.current);},
    clear:()=>{lastIntent.current=null;setError('');},
    isRunning:()=>running.current!==null,
  };
}
