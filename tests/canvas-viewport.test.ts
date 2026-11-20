import { it,expect } from 'vitest';
import { fitCanvasViewport,canvasZoomLabel } from '../apps/web/src/canvas-viewport.js';

it('fits a long or wide maximum graph completely and keeps its sub-percent zoom readable',()=>{
  for(const points of [[{x:60,y:70},{x:60,y:70+9998*150}],[{x:-400,y:-200},{x:9998*260,y:-200}]]){const fit=fitCanvasViewport(points,1070,820);expect(fit).toBeDefined();if(!fit)throw Error();expect(fit.zoom).toBeLessThan(.05);for(const p of points){expect(p.x*fit.zoom+fit.x).toBeGreaterThanOrEqual(44);expect((p.x+210)*fit.zoom+fit.x).toBeLessThanOrEqual(1026);expect(p.y*fit.zoom+fit.y).toBeGreaterThanOrEqual(49);expect((p.y+96)*fit.zoom+fit.y).toBeLessThanOrEqual(771);}expect(canvasZoomLabel(fit.zoom)).not.toBe('0%');}
});
it('retains ordinary fits and rejects empty or numerically invalid geometry',()=>{
  expect(fitCanvasViewport([{x:60,y:70}],800,600)?.zoom).toBe(1);expect(canvasZoomLabel(.8)).toBe('80%');for(const points of [[],[{x:Infinity,y:0}],[{x:-Number.MAX_VALUE,y:0},{x:Number.MAX_VALUE,y:0}]])expect(fitCanvasViewport(points,800,600)).toBeUndefined();expect(fitCanvasViewport([{x:1,y:1}],0,10)).toBeUndefined();
});
