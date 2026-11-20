import {useDeferredValue,useMemo,useState} from 'react';

type TargetOption={id:string;label:string};
type Props={label:string;searchLabel:string;value:string;targets:readonly TargetOption[];
  unavailableLabel:string;disabled?:boolean;disableCurrent?:boolean;onChange:(value:string)=>void};
const optionLimit=100;

export function AnalysisTargetPicker({label,searchLabel,value,targets,unavailableLabel,disabled,disableCurrent,onChange}:Props){
  const [query,setQuery]=useState(''),search=useDeferredValue(query.trim().toLowerCase());
  const {current,options,shown,count}=useMemo(()=>{
    const matches=targets.length>optionLimit&&search?
      targets.filter(target=>(target.id+' '+target.label).toLowerCase().includes(search)):targets;
    const visible=matches.slice(0,optionLimit),current=targets.find(target=>target.id===value);
    const options=current&&!visible.includes(current)?[current,...visible]:visible;
    return {current,options,shown:visible.length,count:matches.length};
  },[targets,search,value]);

  return <>
    {targets.length>optionLimit&&<label>{searchLabel}<input aria-label={searchLabel} type="search" value={query} disabled={disabled} onChange={e=>setQuery(e.target.value)}/>
      <small role="status">{count===0?'没有匹配的范围':`显示 ${shown} / ${count} 个匹配范围`}</small></label>}
    <label>{label}<select aria-label={label} value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}>
      {!current&&<option value={value}>当前选择不可用 · {unavailableLabel}</option>}
      {options.map(option=><option key={option.id} value={option.id} disabled={disableCurrent&&option.id===value}>{option.label}</option>)}
    </select></label>
  </>;
}
