import type {CanvasEdge,CanvasGraph,CanvasNode} from './canvas-graph.js';
import type {CanvasViewport} from './canvas-viewport.js';

export type CanvasPoint={x:number;y:number};
export type CanvasPositions=Readonly<Record<string,CanvasPoint>>;
export type CanvasSize={width:number;height:number};
export type CanvasRect={left:number;top:number;right:number;bottom:number};

export const nodeWidth=210;
export const nodeHeight=96;
export const largeCanvas=(graph:CanvasGraph)=>graph.nodes.length>500||graph.edges.length>1200;

type Anchor={edge:CanvasEdge;sourceOffset:number;targetOffset:number;rail:number};
export type CanvasRoute={edge:CanvasEdge;sx:number;sy:number;tx:number;ty:number;rail?:number;bounds:CanvasRect};
export type PlacedNode={node:CanvasNode;point:CanvasPoint};

function routeEdge(anchor:Anchor,a:CanvasPoint,b:CanvasPoint):CanvasRoute{
  const sx=a.x+anchor.sourceOffset,sy=a.y+nodeHeight,tx=b.x+anchor.targetOffset,ty=b.y;
  const skip=b.y-a.y>200,rail=skip?anchor.rail:undefined;
  const bounds={
    left:Math.min(sx,tx,rail??sx)-8,
    top:Math.min(sy,ty-(skip?22:30))-8,
    right:Math.max(sx,tx,rail??sx)+130,
    bottom:Math.max(sy+(skip?20:30),ty)+8,
  };
  return {edge:anchor.edge,sx,sy,tx,ty,...(rail===undefined?{}:{rail}),bounds};
}

export function canvasRoutePath(route:CanvasRoute){
  const {sx,sy,tx,ty,rail}=route;
  return rail===undefined?
    `M${sx},${sy} C${sx},${sy+30} ${tx},${ty-30} ${tx},${ty}`:
    `M${sx},${sy} V${sy+20} H${rail} V${ty-22} H${tx} V${ty}`;
}

export function createCanvasScene(graph:CanvasGraph,positions:CanvasPositions){
  const nodes:PlacedNode[]=[];
  let left=Infinity;
  for(const node of graph.nodes){
    const point=positions[node.id];
    if(point){nodes.push({node,point});left=Math.min(left,point.x);}
  }
  const incoming=new Map<string,number>(),outgoing=new Map<string,number>();
  for(const {from,to} of graph.edges){
    incoming.set(to,(incoming.get(to)??0)+1);
    outgoing.set(from,(outgoing.get(from)??0)+1);
  }
  const nextIn=new Map<string,number>(),nextOut=new Map<string,number>();
  const routes=graph.edges.flatMap((edge,index)=>{
    const {from,to}=edge,a=positions[from],b=positions[to];
    const sourceIndex=(nextOut.get(from)??0)+1,targetIndex=(nextIn.get(to)??0)+1;
    nextOut.set(from,sourceIndex);
    nextIn.set(to,targetIndex);
    if(!a||!b)return [];
    const anchor={edge,sourceOffset:30+150*sourceIndex/(outgoing.get(from)!+1),targetOffset:30+150*targetIndex/(incoming.get(to)!+1),rail:left-40-(index%7)*20};
    return [{anchor,route:routeEdge(anchor,a,b)}];
  });
  return {nodes,routes,positions};
}

export const canvasRect=(a:CanvasPoint,b:CanvasPoint):CanvasRect=>({
  left:Math.min(a.x,b.x),top:Math.min(a.y,b.y),right:Math.max(a.x,b.x),bottom:Math.max(a.y,b.y),
});

export function canvasVisibleRect(view:CanvasViewport,size:CanvasSize):CanvasRect{
  const margin=64;
  return {
    left:(-view.x-margin)/view.zoom,top:(-view.y-margin)/view.zoom,
    right:(size.width-view.x+margin)/view.zoom,bottom:(size.height-view.y+margin)/view.zoom,
  };
}

export function nodeIntersectsCanvasRect(point:CanvasPoint,rect:CanvasRect){
  return point.x<rect.right&&point.x+nodeWidth>rect.left&&point.y<rect.bottom&&point.y+nodeHeight>rect.top;
}

export function nodesInCanvasRect(scene:ReturnType<typeof createCanvasScene>,rect:CanvasRect|undefined,moving?:ReadonlyMap<string,CanvasPoint>,focusedId?:string){
  const visible:PlacedNode[]=[];
  for(const item of scene.nodes){
    const point=moving?.get(item.node.id)??item.point;
    if(rect&&item.node.id!==focusedId&&!nodeIntersectsCanvasRect(point,rect))continue;
    visible.push(point===item.point?item:{node:item.node,point});
  }
  return visible;
}

export function routesInCanvasRect(scene:ReturnType<typeof createCanvasScene>,rect:CanvasRect|undefined,moving?:ReadonlyMap<string,CanvasPoint>){
  const visible:CanvasRoute[]=[];
  for(const row of scene.routes){
    const {from,to}=row.anchor.edge;
    const movedFrom=moving?.get(from),movedTo=moving?.get(to);
    const route=movedFrom||movedTo?
      routeEdge(row.anchor,movedFrom??scene.positions[from]!,movedTo??scene.positions[to]!):row.route;
    const bounds=route.bounds;
    if(!rect||bounds.left<=rect.right&&bounds.right>=rect.left&&bounds.top<=rect.bottom&&bounds.bottom>=rect.top)visible.push(route);
  }
  return visible;
}

export function canvasNodeAt(nodes:PlacedNode[],point:CanvasPoint,exclude?:string){
  for(let i=nodes.length-1;i>=0;i--){
    const {node,point:origin}=nodes[i]!;
    if(node.id!==exclude&&point.x>=origin.x&&point.x<=origin.x+nodeWidth&&point.y>=origin.y&&point.y<=origin.y+nodeHeight)return node;
  }
}
