import {useLayoutEffect,useRef} from 'react';
import {nodeHeight,nodeWidth,type CanvasRoute,type CanvasSize,type PlacedNode} from './canvas-scene.js';
import type {CanvasViewport} from './canvas-viewport.js';

function drawEdges(ctx:CanvasRenderingContext2D,routes:CanvasRoute[],zoom:number,data:boolean){
  ctx.strokeStyle=data?'#6894cf':'#b29978';
  ctx.lineWidth=Math.max(.5,1.6*zoom);
  ctx.setLineDash(!data&&zoom>=.12?[5*zoom,5*zoom]:[]);
  ctx.beginPath();
  for(const {edge,sx,sy,tx,ty,rail} of routes){
    if((edge.kind==='data')!==data)continue;
    ctx.moveTo(sx*zoom,sy*zoom);
    if(rail===undefined)ctx.bezierCurveTo(sx*zoom,(sy+30)*zoom,tx*zoom,(ty-30)*zoom,tx*zoom,ty*zoom);
    else{
      ctx.lineTo(sx*zoom,(sy+20)*zoom);
      ctx.lineTo(rail*zoom,(sy+20)*zoom);
      ctx.lineTo(rail*zoom,(ty-22)*zoom);
      ctx.lineTo(tx*zoom,(ty-22)*zoom);
      ctx.lineTo(tx*zoom,ty*zoom);
    }
    if(zoom>=.12){
      ctx.moveTo((tx-4)*zoom,(ty-6)*zoom);
      ctx.lineTo(tx*zoom,ty*zoom);
      ctx.lineTo((tx+4)*zoom,(ty-6)*zoom);
    }
  }
  ctx.stroke();
}

export function CanvasOverview({nodes,routes,view,size,selected}:{
  nodes:PlacedNode[];routes:CanvasRoute[];view:CanvasViewport;size:CanvasSize;selected:ReadonlySet<string>;
}){
  const canvas=useRef<HTMLCanvasElement>(null);
  useLayoutEffect(()=>{
    const element=canvas.current,ctx=element?.getContext('2d');
    if(!element||!ctx)return;
    const scale=window.devicePixelRatio||1;
    const width=Math.round(size.width*scale),height=Math.round(size.height*scale);
    if(element.width!==width)element.width=width;
    if(element.height!==height)element.height=height;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,width,height);
    ctx.setTransform(scale,0,0,scale,view.x*scale,view.y*scale);
    drawEdges(ctx,routes,view.zoom,true);
    drawEdges(ctx,routes,view.zoom,false);
    for(const {node,point} of nodes){
      const x=point.x*view.zoom,y=point.y*view.zoom;
      const w=Math.max(1,nodeWidth*view.zoom),h=Math.max(.6,nodeHeight*view.zoom);
      ctx.fillStyle=selected.has(node.id)?'#1967d2':node.kind==='boundary'?'#b7c8dd':node.kind==='communication'?'#cbb58e':'#7d9abb';
      ctx.fillRect(x,y,w,h);
    }
  },[nodes,routes,selected,size,view]);
  return <foreignObject width={size.width} height={size.height} pointerEvents="none" aria-hidden="true">
    <canvas ref={canvas} className="canvas-overview" data-painted-nodes={nodes.length} data-painted-edges={routes.length}/>
  </foreignObject>;
}
