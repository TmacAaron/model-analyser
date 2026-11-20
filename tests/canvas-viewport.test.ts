import { it,expect } from 'vitest';
import { fitCanvasViewport,canvasZoomLabel } from '../apps/web/src/canvas-viewport.js';
import type {CanvasGraph} from '../apps/web/src/canvas-graph.js';
import {canvasNodeAt,canvasRect,canvasRoutePath,createCanvasScene,nodesInCanvasRect,routesInCanvasRect} from '../apps/web/src/canvas-scene.js';

it('fits a long or wide maximum graph completely and keeps its sub-percent zoom readable',()=>{
  for(const points of [[{x:60,y:70},{x:60,y:70+9998*150}],[{x:-400,y:-200},{x:9998*260,y:-200}]]){const fit=fitCanvasViewport(points,1070,820);expect(fit).toBeDefined();if(!fit)throw Error();expect(fit.zoom).toBeLessThan(.05);for(const p of points){expect(p.x*fit.zoom+fit.x).toBeGreaterThanOrEqual(44);expect((p.x+210)*fit.zoom+fit.x).toBeLessThanOrEqual(1026);expect(p.y*fit.zoom+fit.y).toBeGreaterThanOrEqual(49);expect((p.y+96)*fit.zoom+fit.y).toBeLessThanOrEqual(771);}expect(canvasZoomLabel(fit.zoom)).not.toBe('0%');}
});
it('retains ordinary fits and rejects empty or numerically invalid geometry',()=>{
  expect(fitCanvasViewport([{x:60,y:70}],800,600)?.zoom).toBe(1);expect(canvasZoomLabel(.8)).toBe('80%');for(const points of [[],[{x:Infinity,y:0}],[{x:-Number.MAX_VALUE,y:0},{x:Number.MAX_VALUE,y:0}]])expect(fitCanvasViewport(points,800,600)).toBeUndefined();expect(fitCanvasViewport([{x:1,y:1}],0,10)).toBeUndefined();
});

const graph:CanvasGraph={
  nodes:['skip-source','skip-target','regular-source','regular-target']
    .map(id=>({id,name:id,kind:'operator',leafIds:[id]})),
  edges:[
    {id:'residual',from:'skip-source',to:'skip-target',kind:'data',tensorIds:['residual']},
    {id:'regular',from:'regular-source',to:'regular-target',kind:'data',tensorIds:['local']},
  ],
};
const positions={'skip-source':{x:400,y:0},'skip-target':{x:400,y:600},'regular-source':{x:60,y:900},'regular-target':{x:60,y:1050}};

it('keeps a crossing residual route when both endpoints are outside the visible area',()=>{
  const scene=createCanvasScene(graph,positions);
  const crossing=canvasRect({x:642,y:230},{x:658,y:340});
  expect(nodesInCanvasRect(scene,crossing)).toEqual([]);
  const routes=routesInCanvasRect(scene,crossing);
  expect(routes.map(route=>route.edge.id)).toEqual(['residual']);
  expect(canvasRoutePath(routes[0]!)).toBe('M505,96 V116 H650 V578 H505 V600');
});

it('uses sparse drag updates for hit testing and reuses routes unrelated to the drag',()=>{
  const scene=createCanvasScene(graph,positions);
  const updates=new Map([['skip-target',{x:-50,y:300}]]);
  const area=canvasRect({x:-60,y:270},{x:200,y:410});
  const visible=nodesInCanvasRect(scene,area,updates);
  expect(visible.map(item=>item.node.id)).toEqual(['skip-target']);
  expect(canvasNodeAt(visible,{x:0,y:350})?.id).toBe('skip-target');
  const [changed,unchanged]=routesInCanvasRect(scene,undefined,updates);
  expect(canvasRoutePath(changed!)).toBe('M505,96 V116 H650 V278 H55 V300');
  expect(unchanged).toBe(scene.routes[1]?.route);
});

it('assigns different rails to overlapping residuals and orders branch ports by position',()=>{
  const nodes=['source','left','right','first-join','last-join']
    .map(id=>({id,name:id,kind:'operator' as const,leafIds:[id]}));
  const edge=(id:string,to:string)=>({id,from:'source',to,kind:'data' as const,tensorIds:[id]});
  const scene=createCanvasScene({nodes,edges:[
    edge('right-branch','right'),edge('left-branch','left'),edge('first-residual','first-join'),edge('last-residual','last-join'),
  ]},{source:{x:260,y:0},left:{x:0,y:150},right:{x:520,y:150},'first-join':{x:260,y:450},'last-join':{x:260,y:600}});
  const routes=new Map(scene.routes.map(item=>[item.route.edge.id,item.route]));
  expect(routes.get('left-branch')!.sx).toBeLessThan(routes.get('right-branch')!.sx);
  expect(routes.get('first-residual')?.rail).toBeDefined();
  expect(routes.get('last-residual')?.rail).toBeDefined();
  expect(routes.get('first-residual')?.rail).not.toBe(routes.get('last-residual')?.rail);
});
