import {useEffect,useLayoutEffect,useMemo,useRef,useState,type PointerEvent as ReactPointerEvent,type ReactNode} from 'react';
import type {CanvasGraph,CanvasNode} from './canvas-graph.js';
import {CanvasNodeNavigator} from './canvas-node-navigator.js';
import {CanvasOverview} from './canvas-overview.js';
import {canvasNodeAt,canvasRect,canvasRoutePath,canvasVisibleRect,createCanvasScene,largeCanvas,nodeHeight,nodeWidth,nodesInCanvasRect,routesInCanvasRect,type CanvasPoint,type CanvasPositions,type CanvasSize} from './canvas-scene.js';
import {fitCanvasViewport,canvasZoomLabel,type CanvasViewport} from './canvas-viewport.js';

type Drag=
  |{kind:'pan';start:CanvasPoint;view:CanvasViewport}
  |{kind:'box';start:CanvasPoint;end:CanvasPoint}
  |{kind:'nodes';start:CanvasPoint;positions:CanvasPositions;ids:string[];updates?:Map<string,CanvasPoint>;node:CanvasNode}
  |{kind:'connect';from:string;end:CanvasPoint};

export function ModelCanvas({graph,defaultPositions,layout,scopeKey,selected,onSelect,onOpen,onMove,onConnect,tooltip}:{
  graph:CanvasGraph;defaultPositions:CanvasPositions;layout:CanvasPositions;scopeKey:string;selected:string[];
  onSelect:(ids:string[])=>void;onOpen:(node:CanvasNode)=>void;
  onMove:(positions:Record<string,CanvasPoint>)=>void;onConnect:(from:string,to:string)=>void;tooltip:(node:CanvasNode)=>ReactNode;
}){
  const svg=useRef<SVGSVGElement>(null),host=useRef<HTMLDivElement>(null),tools=useRef<HTMLDivElement>(null),drag=useRef<Drag|null>(null),space=useRef(false);
  const positions=useMemo(()=>({...defaultPositions,...layout}),[defaultPositions,layout]);
  const scene=useMemo(()=>createCanvasScene(graph,positions),[graph,positions]);
  const allPoints=useMemo(()=>scene.nodes.map(item=>item.point),[scene]);
  const railBounds=useMemo(()=>scene.routes.reduce<{left:number;right:number}|undefined>((bounds,{route:{rail}})=>{
    if(rail===undefined)return bounds;
    return bounds?{left:Math.min(rail,bounds.left),right:Math.max(rail,bounds.right)}:{left:rail,right:rail};
  },undefined),[scene]);
  const selection=useMemo(()=>new Set(selected),[selected]);
  const [size,setSize]=useState<CanvasSize>({width:800,height:600});
  const [moving,setMoving]=useState<ReadonlyMap<string,CanvasPoint>>(),[focused,setFocused]=useState<string>();
  const pendingFocus=useRef<string>(undefined);
  const [mode,setMode]=useState<'pan'|'box'>('pan'),[box,setBox]=useState<{start:CanvasPoint;end:CanvasPoint}>();
  const [connection,setConnection]=useState<{from:string;end:CanvasPoint}>();
  const [hover,setHover]=useState<{node:CanvasNode;point:CanvasPoint}>();
  const [view,setView]=useState<CanvasViewport>(()=>{
    try{
      const saved=JSON.parse(localStorage.getItem('canvas-view-v2:'+scopeKey)??'null') as CanvasViewport|null;
      if(saved&&Number.isFinite(saved.x)&&Number.isFinite(saved.y)&&Number.isFinite(saved.zoom)&&saved.zoom>0&&saved.zoom<=3)return saved;
    }catch{/* An unavailable browser cache does not prevent editing. */}
    return {x:30,y:30,zoom:0.8};
  });
  const current=useRef(view);
  current.current=view;
  const large=largeCanvas(graph);
  const visibleRect=useMemo(()=>large?canvasVisibleRect(view,size):undefined,[large,view,size]);
  const visibleNodes=useMemo(()=>nodesInCanvasRect(scene,visibleRect,moving,focused),[scene,visibleRect,moving,focused]);
  const visibleRoutes=useMemo(()=>routesInCanvasRect(scene,visibleRect,moving),[scene,visibleRect,moving]);
  const readable=view.zoom>=.18;
  const compact=large&&(!readable||visibleNodes.length>500||visibleRoutes.length>1200);
  const cardNodes=useMemo(()=>{
    if(!compact)return visibleNodes;
    return readable&&selected.length===1?visibleNodes.filter(item=>item.node.id===selected[0]):[];
  },[compact,readable,selected,visibleNodes]);
  const fitAll=useMemo(()=>fitCanvasViewport(allPoints,size.width,size.height,railBounds),[allPoints,railBounds,size]);

  function local(client:CanvasPoint):CanvasPoint{
    const rect=svg.current?.getBoundingClientRect();
    return {x:client.x-(rect?.left??0),y:client.y-(rect?.top??0)};
  }
  function world(p:CanvasPoint):CanvasPoint{
    const v=current.current;
    return {x:(p.x-v.x)/v.zoom,y:(p.y-v.y)/v.zoom};
  }
  function zoom(factor:number,anchor:CanvasPoint={x:size.width/2,y:size.height/2}){
    const w=world(anchor);
    const minimum=Math.max(Number.MIN_VALUE,Math.min(.05,(fitAll?.zoom??.1)/2));
    const z=Math.max(minimum,Math.min(3,current.current.zoom*factor));
    setView({x:anchor.x-w.x*z,y:anchor.y-w.y*z,zoom:z});
    setHover(undefined);
  }
  function fit(ids?:string[]){
    const scope=ids?new Set(ids):undefined;
    const points=scope?scene.nodes.filter(item=>scope.has(item.node.id)).map(item=>item.point):allPoints;
    const width=host.current?.clientWidth??size.width,height=host.current?.clientHeight??size.height;
    const toolbar=tools.current;
    const inset=large&&!scope&&toolbar?Math.max(0,Math.min(height-101,toolbar.offsetTop+toolbar.offsetHeight-40)):0;
    const fitted=fitCanvasViewport(points,width,height-inset,scope?undefined:railBounds);
    if(fitted)setView({...fitted,y:fitted.y+inset});
    setHover(undefined);
  }
  useLayoutEffect(()=>{
    const id=pendingFocus.current;
    if(id===undefined)return;
    pendingFocus.current=undefined;
    const target=svg.current?.querySelector<SVGGElement>('[data-node-id="'+CSS.escape(id)+'"]')??svg.current;
    target?.focus();
  },[view,compact]);
  useLayoutEffect(()=>{
    const element=host.current;
    if(!element)return;
    function measure(){
      if(!element)return;
      const {clientWidth:width,clientHeight:height}=element;
      setSize(old=>old.width===width&&old.height===height?old:{width,height});
    }
    const observer=new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return ()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    try{localStorage.setItem('canvas-view-v2:'+scopeKey,JSON.stringify(view));}
    catch{/* Layout remains in the portable model workspace. */}
  },[view,scopeKey]);
  useEffect(()=>{
    const element=svg.current;
    if(!element)return;
    const wheel=(e:WheelEvent)=>{e.preventDefault();zoom(Math.exp(-e.deltaY*0.0015),local({x:e.clientX,y:e.clientY}));};
    element.addEventListener('wheel',wheel,{passive:false});
    return ()=>element.removeEventListener('wheel',wheel);
  },[fitAll,size]);
  useEffect(()=>{
    let stored=false;
    try{stored=localStorage.getItem('canvas-fitted-v2:'+scopeKey)==='yes';}
    catch{/* Fit normally when browser storage is unavailable. */}
    if(stored)return;
    if(graph.nodes.length>8){
      const first=positions[graph.nodes[0]?.id??''];
      if(first)setView({x:(host.current?.clientWidth??size.width)/2-(first.x+105)*.85,y:100-first.y*.85,zoom:.85});
    }else fit();
    try{localStorage.setItem('canvas-fitted-v2:'+scopeKey,'yes');}
    catch{/* No cache is required. */}
  },[scopeKey]);

  function start(e:ReactPointerEvent,node?:CanvasNode,port=false){
    if(e.button!==0&&e.button!==1)return;
    e.preventDefault();
    svg.current?.focus();
    svg.current?.setPointerCapture(e.pointerId);
    setHover(undefined);
    const p=local({x:e.clientX,y:e.clientY});
    if(port&&node){
      const end=world(p);
      drag.current={kind:'connect',from:node.id,end};
      setConnection({from:node.id,end});
      return;
    }
    if(node&&!space.current&&e.button!==1){
      const ids=e.shiftKey?(selection.has(node.id)?selected.filter(id=>id!==node.id):[...selected,node.id]):selection.has(node.id)?selected:[node.id];
      onSelect(ids);
      drag.current={kind:'nodes',start:p,positions,ids,node};
    }else if(mode==='box'&&!space.current&&e.button!==1||e.shiftKey){
      const point=world(p);
      drag.current={kind:'box',start:point,end:point};
      setBox({start:point,end:point});
    }else drag.current={kind:'pan',start:p,view:current.current};
  }
  function move(e:ReactPointerEvent){
    const d=drag.current;
    if(!d){
      if(compact&&readable&&!(e.target instanceof Element&&e.target.closest('.canvas-node'))){
        const node=canvasNodeAt(visibleNodes,world(local({x:e.clientX,y:e.clientY})));
        if(node&&node.id!==hover?.node.id)showHover(node,e);
        else if(!node&&hover)setHover(undefined);
      }
      return;
    }
    const p=local({x:e.clientX,y:e.clientY});
    if(d.kind==='pan')setView({...d.view,x:d.view.x+p.x-d.start.x,y:d.view.y+p.y-d.start.y});
    else if(d.kind==='box'){
      d.end=world(p);
      setBox({start:d.start,end:d.end});
    }else if(d.kind==='connect'){
      d.end=world(p);
      setConnection({from:d.from,end:d.end});
    }else{
      const dx=(p.x-d.start.x)/current.current.zoom,dy=(p.y-d.start.y)/current.current.zoom;
      if(!d.updates&&Math.hypot(p.x-d.start.x,p.y-d.start.y)<=3)return;
      const updates=new Map<string,CanvasPoint>();
      for(const id of d.ids){
        const origin=d.positions[id];
        if(origin)updates.set(id,{x:origin.x+dx,y:origin.y+dy});
      }
      d.updates=updates;
      setMoving(updates);
    }
  }
  function end(){
    const d=drag.current;
    drag.current=null;
    if(!d)return;
    if(d.kind==='nodes'){
      if(d.updates)onMove(Object.fromEntries(d.updates));
      else if(d.node.kind==='module')onOpen(d.node);
      setMoving(undefined);
    }else if(d.kind==='box'){
      onSelect(nodesInCanvasRect(scene,canvasRect(d.start,d.end)).map(item=>item.node.id));
      setBox(undefined);
    }else if(d.kind==='connect'){
      const target=canvasNodeAt(scene.nodes,d.end,d.from);
      if(target&&!target.viewGroup)onConnect(d.from,target.id);
      setConnection(undefined);
    }
  }
  function showHover(node:CanvasNode,e:ReactPointerEvent){
    if(drag.current)return;
    const p=local({x:e.clientX,y:e.clientY});
    setHover({node,point:{x:Math.max(8,Math.min(p.x+16,size.width-300)),y:Math.max(60,Math.min(p.y+18,size.height-235))}});
  }

  const hoveredId=hover?.node.id;
  const edgeElements=useMemo(()=>compact?null:visibleRoutes.map(route=>{
    const {edge,sx,sy,tx,ty,rail}=route;
    const active=selection.has(edge.from)||selection.has(edge.to)||hoveredId===edge.from||hoveredId===edge.to;
    return <g key={edge.id} role="img" opacity={(selection.size||hoveredId)&&!active ? .36 : 1}
      aria-label={edge.kind+' · '+edge.tensorIds.join(', ')+' · '+edge.from+' → '+edge.to}>
      <path className="canvas-edge" d={canvasRoutePath(route)} fill="none" stroke={edge.kind==='data'?'#6894cf':'#b29978'} strokeWidth="1.6" strokeDasharray={edge.kind==='data'?undefined:'5 5'} markerEnd="url(#canvas-arrow)">
        <title>{edge.kind} · {edge.tensorIds.join(', ')||edge.from+' → '+edge.to}</title>
      </path>
      {edge.kind==='data'&&(active||visibleRoutes.length<=14)&&<text className="canvas-edge-label" x={(rail??(sx+tx)/2)+5} y={(sy+ty)/2-(rail===undefined?4:0)}>{edge.tensorIds.map(id=>id.split('::').at(-1)).join(' · ').slice(0,24)}</text>}
    </g>;
  }),[compact,visibleRoutes,selection,hoveredId]);
  const nodeElements=useMemo(()=>cardNodes.map(({node:n,point:p})=><g key={n.id} data-node-id={n.id} role="button"
    aria-label={(n.kind==='module'?'展开模块 ':'选择算子 ')+n.name+' '+n.id} aria-pressed={selection.has(n.id)} tabIndex={0}
    className={'canvas-node '+n.kind+(n.viewGroup?' operation-group '+n.viewGroup.kind:'')+(selection.has(n.id)?' selected':'')} transform={`translate(${p.x},${p.y})`}
    onFocus={()=>setFocused(n.id)} onBlur={()=>setFocused(undefined)}
    onPointerDown={e=>{e.stopPropagation();start(e,n);}}
    onKeyDown={e=>{
      e.stopPropagation();
      if(e.key==='Enter'){onSelect([n.id]);if(n.kind==='module')onOpen(n);}
      if(e.key===' '){e.preventDefault();onSelect(e.shiftKey?[...new Set([...selected,n.id])]:[n.id]);}
    }}
    onPointerEnter={e=>showHover(n,e)} onPointerLeave={()=>setHover(undefined)}>
    <rect width={nodeWidth} height={nodeHeight} rx="16"/>
    {n.repeatCount&&<g className="canvas-repeat"><rect x="155" y="-13" width="62" height="28" rx="14"/><text x="186" y="6" textAnchor="middle">{n.repeatCount} ×</text></g>}
    <text className="canvas-node-kind" x="16" y="22">{n.boundary==='input'?'INPUT':n.boundary==='output'?'OUTPUT':n.viewGroup?.kind==='fusion'?'FUSED':n.viewGroup?'OPERATOR':n.kind==='module'?'MODULE':n.kind==='communication'?'COLLECTIVE':'OPERATOR'}</text>
    <text className="canvas-node-name" x="16" y="46">{n.name.length>23?n.name.slice(0,22)+'…':n.name}</text>
    <text className="canvas-node-detail" x="16" y="69">{n.viewGroup?n.leafIds.length+' 个计算步骤':n.kind==='module'?n.id.split('/').at(-1)+' · '+n.leafIds.length+' 个算子':n.id.split('/').at(-1)?.slice(0,27)}</text>
    {n.badges?.length?<text className="canvas-node-badge" x="16" y="87">{n.badges.join(' · ')}</text>:null}
    <circle cx="105" cy="0" r="5" className="canvas-port input"/>
    {n.kind!=='boundary'&&!n.viewGroup&&<circle cx="105" cy={nodeHeight} r="7" className="canvas-port output" role="button"
      aria-label={'从 '+n.id+' 拖出连线'} onPointerDown={e=>{e.stopPropagation();start(e,n,true);}}/>}
  </g>),[cardNodes,selection,selected,mode,onSelect,onOpen,positions,size]);

  const source=connection?moving?.get(connection.from)??positions[connection.from]:undefined;
  return <div className="model-canvas" ref={host}>
    <div className="canvas-tools" ref={tools} role="toolbar" aria-label="画布工具">
      <button aria-pressed={mode==='pan'} onClick={()=>setMode('pan')}>移动画布</button>
      <button aria-pressed={mode==='box'} onClick={()=>setMode('box')}>框选算子</button>
      <span className="tool-divider"/>
      <button aria-label="放大画布" onClick={()=>zoom(1.2)}>＋</button>
      <span aria-label="画布缩放">{canvasZoomLabel(view.zoom)}</span>
      <button aria-label="缩小画布" onClick={()=>zoom(1/1.2)}>−</button>
      <button onClick={()=>fit()}>适配全图</button>
      <button disabled={!selected.length} onClick={()=>fit(selected)}>定位选中节点</button>
      {large&&<CanvasNodeNavigator nodes={graph.nodes} onLocate={node=>{pendingFocus.current=node.id;onSelect([node.id]);fit([node.id]);}}/>}
      <button onClick={()=>{onMove(defaultPositions);setMoving(undefined);}}>自动布局</button>
    </div>
    <svg ref={svg} className={'canvas-surface mode-'+mode} role="application" aria-label="模型结构画布" tabIndex={0}
      data-render-mode={compact?'overview':'detail'} data-node-count={graph.nodes.length} data-edge-count={graph.edges.length}
      onPointerDown={e=>{
        const node=compact&&mode==='pan'&&e.button===0?canvasNodeAt(visibleNodes,world(local({x:e.clientX,y:e.clientY}))):undefined;
        start(e,node);
      }}
      onPointerMove={move} onPointerUp={end} onPointerLeave={()=>setHover(undefined)}
      onPointerCancel={()=>{drag.current=null;setMoving(undefined);setBox(undefined);setConnection(undefined);}}
      onKeyDown={e=>{if(e.code==='Space'){e.preventDefault();space.current=true;}if(e.key==='Escape'){onSelect([]);setHover(undefined);}}}
      onKeyUp={e=>{if(e.code==='Space')space.current=false;}} onBlur={()=>{space.current=false;}}>
      <defs>
        <pattern id="canvas-grid" x={view.x%24} y={view.y%24} width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#d8ddd9"/></pattern>
        <marker id="canvas-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M1,1 L7,4 L1,7" fill="none" stroke="#6894cf"/></marker>
      </defs>
      <rect width="100%" height="100%" fill="url(#canvas-grid)"/>
      {compact&&<CanvasOverview nodes={visibleNodes} routes={visibleRoutes} view={view} size={size} selected={selection}/>}
      <g transform={`translate(${view.x},${view.y}) scale(${view.zoom})`}>
        {edgeElements}
        {connection&&source&&<path d={`M${source.x+105},${source.y+nodeHeight} C${source.x+105},${source.y+130} ${connection.end.x},${connection.end.y-34} ${connection.end.x},${connection.end.y}`} fill="none" stroke="#407c67" strokeWidth="2" strokeDasharray="5 4"/>}
        {nodeElements}
        {box&&<rect x={Math.min(box.start.x,box.end.x)} y={Math.min(box.start.y,box.end.y)} width={Math.abs(box.start.x-box.end.x)} height={Math.abs(box.start.y-box.end.y)} fill="#6caa8f22" stroke="#407c67" strokeWidth={1/view.zoom} pointerEvents="none"/>}
      </g>
    </svg>
    {hover&&(!compact||readable)&&<div role="tooltip" className="canvas-tooltip" style={{left:hover.point.x,top:hover.point.y}}><strong>{hover.node.name}</strong>{tooltip(hover.node)}</div>}
    <div className="canvas-hint">{selected.length?'已选 '+selected.length+' 个节点 · Shift 点击多选':compact?'全图总览 · 放大或查找节点以查看详情':'拖动节点编辑布局 · 点击模块下钻'}<span>滚轮缩放 · 空格／中键拖动画布 · Shift 拖动框选</span></div>
    {!graph.nodes.length&&<div className="canvas-empty">当前阶段没有可显示的节点。请查看结构诊断或切换阶段。</div>}
  </div>;
}
