type Point={x:number;y:number};
export type CanvasViewport=Point&{zoom:number};
/** Fit actual world extents; a large graph may need less than five percent. */
export function fitCanvasViewport(points:Point[],width:number,height:number,rails?:{left:number;right:number}):CanvasViewport|undefined{
  if(!points.length||!Number.isFinite(width)||!Number.isFinite(height)||width<=90||height<=100)return;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const point of points){if(!Number.isFinite(point.x)||!Number.isFinite(point.y))return;minX=Math.min(minX,point.x);minY=Math.min(minY,point.y);maxX=Math.max(maxX,point.x);maxY=Math.max(maxY,point.y);}
  const left=Math.min(minX,rails?.left??minX),right=Math.max(maxX+210,rails?.right??maxX+210);
  const w=right-left,h=maxY+96-minY,zoom=Math.min(1,(width-90)/w,(height-100)/h),x=(width-w*zoom)/2-left*zoom,y=(height-h*zoom)/2-minY*zoom;
  if(zoom>0&&[zoom,x,y].every(Number.isFinite))return {x,y,zoom};
}
export function canvasZoomLabel(zoom:number){return (zoom>=.01?Math.round(zoom*100):new Intl.NumberFormat('en-US',{maximumSignificantDigits:3}).format(zoom*100))+'%';}
