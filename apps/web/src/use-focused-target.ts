import { useState } from 'react';
import { focusIdentity,targetId,type AnalysisFocus } from './analysis-focus.js';
/** A manual choice survives ordinary renders; a new explicit canvas context immediately replaces it. */
export function useFocusedTarget(focus:AnalysisFocus|undefined){const identity=focusIdentity(focus),[choice,setChoice]=useState<{identity:string;id:string}>();return {id:choice?.identity===identity?choice.id:focus?.target?targetId(focus.target):focus?'unavailable':'model',setId:(id:string)=>setChoice({identity,id}),following:choice?.identity!==identity};}
