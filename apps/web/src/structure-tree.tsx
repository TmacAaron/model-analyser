import { useState } from 'react';
import { type ResolvedGraph } from '@model-analyser/contracts';

type Container=ResolvedGraph['containers'][number];
type Leaf=ResolvedGraph['graph']['nodes'][number];
export function structureTree(resolved:ResolvedGraph){
  const containers=new Map<string,Container>(resolved.containers.map(c=>[c.nodeId,c])),children=new Map<string,Container[]>(),leaves=new Map<string,Leaf[]>();
  function parent(id:string){let prefix=id;while(prefix.length){const cut=Math.max(prefix.lastIndexOf('/'),prefix.lastIndexOf('['));if(cut<0)break;prefix=prefix.slice(0,cut);if(containers.has(prefix))return prefix;}return '$model';}
  for(const c of containers.values())if(c.nodeId!=='$model'){const id=parent(c.nodeId);children.set(id,[...(children.get(id)??[]),c]);}
  for(const leaf of resolved.graph.nodes){const id=parent(leaf.nodeId);leaves.set(id,[...(leaves.get(id)??[]),leaf]);}
  return {root:containers.get('$model'),children,leaves};
}
function Branch({container,tree,onSelect,root=false}:{container:Container;tree:ReturnType<typeof structureTree>;onSelect:(id:string)=>void;root?:boolean}){
    const [open,setOpen]=useState(root),[limit,setLimit]=useState(30),nested=tree.children.get(container.nodeId)??[],leaves=tree.leaves.get(container.nodeId)??[];
    return <details className="structure-tree-branch" open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary>{container.name} <code>{container.nodeId}</code><small>{container.leafNodeIds.length} 个叶节点 · r{container.asset.revision}</small></summary>{open&&<div>{nested.map(c=><Branch key={c.nodeId} container={c} tree={tree} onSelect={onSelect}/>)}{leaves.slice(0,limit).map(n=><button key={n.nodeId} onClick={()=>onSelect(n.nodeId)}>{n.name}<code>{n.nodeId}</code></button>)}{leaves.length>limit&&<button onClick={()=>setLimit(limit+30)}>再显示 30 个直属节点</button>}</div>}</details>;
}
export function StructureTree({resolved,onSelect}:{resolved:ResolvedGraph;onSelect:(id:string)=>void}){
  const tree=structureTree(resolved);
  return <div className="structure-tree" aria-label="模型包含层级树"><p className="scope-note">树表示结构包含关系；数据、控制/同步依赖在上方图中显示。重复实例可单独展开，选择叶节点查看公式与来源。</p>{tree.root?<Branch container={tree.root} tree={tree} onSelect={onSelect} root/>:<p>当前结构没有模型容器。</p>}</div>;
}
