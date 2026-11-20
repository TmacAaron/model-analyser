import { useState } from 'react';
import type { AssetDocument,AssetIndexEntry } from '@model-analyser/contracts';
import type { CanvasEditControls,CanvasEditIntent } from './canvas-edit-worker.js';
import { GraphEditor } from './graph-editor.js';
import type { GraphAsset } from './graph-editing.js';
import { useCanvasEdit } from './use-canvas-edit.js';

export function CanvasStructureEditor({source,initialNodeId,assets,catalog,active,onApply}:{
  source:GraphAsset;initialNodeId:string;assets:AssetDocument[];catalog:AssetIndexEntry[];active:boolean;
  onApply:(intent:CanvasEditIntent,controls:CanvasEditControls)=>Promise<void>;
}){
  const [draft,setDraft]=useState<GraphAsset>();
  const [editorVersion,setEditorVersion]=useState(0);
  const edit=useCanvasEdit(onApply,active);

  return <section className="canvas-structure-editor" aria-label="画布结构编辑">
    <h3>{source.name}</h3>
    <p className="scope-note">应用后，引用此定义的实例和同模型的各个配置会一起更新。保存前会检查所有受影响的配置。</p>
    <div className="asset-actions">
      <button disabled={!draft||edit.busy} onClick={()=>{if(draft)void edit.submit({kind:'definition',asset:source,candidate:draft});}}>应用结构修改</button>
      <button disabled={!draft||edit.busy} onClick={()=>{setDraft(undefined);setEditorVersion(n=>n+1);edit.clear();}}>撤销未应用的修改</button>
    </div>
    {edit.phase==='preparing'&&<p role="status">正在校验结构与配置。<button onClick={edit.cancel}>取消结构准备</button></p>}
    {edit.phase==='publishing'&&<p role="status">正在保存已校验的定义。</p>}
    {edit.error&&<p className="error" role="alert">{edit.error} <button onClick={edit.retry}>重试结构保存</button></p>}
    <fieldset className="graph-editor-fieldset" disabled={edit.busy}>
      <GraphEditor key={editorVersion} asset={draft??source} catalog={catalog} canvas={{snapshots:assets,initialNodeId}} onChange={next=>{
        if(edit.isRunning())return;
        setDraft(next);
        edit.clear();
      }}/>
    </fieldset>
  </section>;
}
