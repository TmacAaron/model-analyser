import { useMemo } from 'react';
import type { CapacitySearchPoint } from '@model-analyser/contracts';
import { useDisplayUnits } from './display-units.js';

const palette={fits:'#397954',exceeds:'#bd704f',unknown:'#778391'};
const deviceLimitColor='#b27450';

function capacityGeometry(points:readonly CapacitySearchPoint[]){
  const first=points[0]?.value??0;
  const last=points.at(-1)?.value??first;
  const x=(value:number)=>55+(value-first)/Math.max(1,last-first)*475;
  let max=1,pairs=0;
  for(const point of points){
    if(point.status!=='available')continue;
    pairs+=point.memory.length;
    for(const memory of point.memory){
      max=Math.max(max,memory.capacityBytes,memory.peakBytes.status==='available'?memory.peakBytes.quantity.value:0);
    }
  }
  const y=(value:number)=>195-value/max*155;
  const radius=points.length>200?1.5:3;
  return {first,last,max,x,y,radius,dense:pairs>256};
}

function buildCapacityPaths(points:readonly CapacitySearchPoint[],geometry:ReturnType<typeof capacityGeometry>){
  const {x,y,radius}=geometry;
  const limits:string[]=[],peaks={fits:[] as string[],exceeds:[] as string[],unknown:[] as string[]};
  for(const point of points){
    if(point.status!=='available')continue;
    const cx=x(point.value);
    for(const memory of point.memory){
      limits.push(`M${cx-2} ${y(memory.capacityBytes)}h4`);
      if(memory.peakBytes.status!=='available')continue;
      const cy=y(memory.peakBytes.quantity.value),diameter=2*radius;
      peaks[point.fit].push(`M${cx-radius} ${cy}a${radius} ${radius} 0 1 0 ${diameter} 0a${radius} ${radius} 0 1 0 ${-diameter} 0Z`);
    }
  }
  return {limits:limits.join(''),fits:peaks.fits.join(''),exceeds:peaks.exceeds.join(''),unknown:peaks.unknown.join('')};
}

export function CapacityChart({points}:{points:readonly CapacitySearchPoint[]}){
  const display=useDisplayUnits();
  const geometry=useMemo(()=>capacityGeometry(points),[points]);
  const paths=useMemo(()=>geometry.dense?buildCapacityPaths(points,geometry):undefined,[geometry,points]);
  const {first,last,max,x,y,radius}=geometry;
  return <svg role="img" aria-label="容量搜索显存曲线" width="600" height="235" viewBox="0 0 600 235">
    <path d="M55 25 V195 H540" fill="none" stroke="#a3b7a9"/>
    <text x="55" y="16" fontSize="10" fill="#718a79">峰值 · 上限 {display.bytes(max)} · 每个已计算整数点</text>
    <text x="55" y="215" fontSize="10" fill="#718a79">{first}</text>
    <text x="530" y="215" fontSize="10" fill="#718a79">{last}</text>
    {paths?<g data-dense-capacity="" aria-hidden="true">
      <path d={paths.limits} fill="none" stroke={deviceLimitColor}/>
      <path d={paths.fits} fill={palette.fits}/>
      <path d={paths.exceeds} fill={palette.exceeds}/>
      <path d={paths.unknown} fill={palette.unknown}/>
    </g>:points.map(point=>point.status==='available'&&point.memory.map((memory,index)=>{
      const peak=memory.peakBytes.status==='available'?memory.peakBytes.quantity.value:undefined;
      const cx=x(point.value),lineY=y(memory.capacityBytes);
      return <g key={point.value+':'+memory.deviceId}>
        <title>{point.value} · {memory.deviceId} · {peak===undefined?'未知峰值':display.bytes(peak)} / {display.bytes(memory.capacityBytes)}</title>
        <line x1={cx-2} x2={cx+2} y1={lineY} y2={lineY} stroke={deviceLimitColor}/>
        {peak!==undefined&&<circle cx={cx} cy={y(peak)} r={radius} fill={palette[point.fit]} data-device={index}/>}
      </g>;
    }))}
    <text x="100" y="232" fontSize="10" fill="#718a79">绿色可容纳 · 橙色超容量 · 灰色待定 · 短线为设备容量</text>
  </svg>;
}
