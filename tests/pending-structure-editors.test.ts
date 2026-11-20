import { it,expect,vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectDocument } from '@model-analyser/contracts';
import { readFileSync } from 'node:fs';
import { DisplayUnitsProvider } from '../apps/web/src/display-units.js';
import { MemoryPeakEditor } from '../apps/web/src/memory-peak-view.js';
import { AscendQuantizationEditor } from '../apps/web/src/ascend-quantization-view.js';

const { expand }=vi.hoisted(()=>({expand:vi.fn()}));
vi.mock('@model-analyser/core',async original=>({...await original<typeof import('@model-analyser/core')>(),instantiateModel:expand}));
const project=()=>ProjectDocument.parse(JSON.parse(readFileSync('examples/contracts/project.json','utf8')));
it('keeps graph-dependent editors available without synchronously expanding when their canvas result is not ready',()=>{
  expand.mockReset().mockImplementation(()=>{throw Error('Unexpected synchronous expansion while canvas result is pending');});const p=project(),scenario=p.scenarios[0]!,memoryProps={scenario,assets:p.assetSnapshots,onChange:()=>{},resolved:undefined,resolveIfMissing:false},quantizationProps={project:p,scenario,onProject:()=>{},resolved:undefined,resolveIfMissing:false};
  const memory=renderToStaticMarkup(createElement(DisplayUnitsProvider,null,createElement(MemoryPeakEditor,memoryProps))),quantization=renderToStaticMarkup(createElement(DisplayUnitsProvider,null,createElement(AscendQuantizationEditor,quantizationProps)));expect(memory).toContain('模型结构就绪后可选择模块范围');expect(memory).toContain('模块私有峰值 byte');expect(quantization).toContain('模型结构就绪后可查看精确存储目标');expect(quantization).toContain('Ascend量化描述导入');expect(expand).not.toHaveBeenCalled();
});
it('compatibility callers expose pending controls and retain forms without synchronously instantiating during render',()=>{
 expand.mockReset().mockImplementation(()=>{throw Error('Unexpected synchronous compatibility expansion');});const p=project(),scenario=p.scenarios[0]!;
 const memory=renderToStaticMarkup(createElement(DisplayUnitsProvider,null,createElement(MemoryPeakEditor,{scenario,assets:p.assetSnapshots,onChange:()=>{}}))),quantization=renderToStaticMarkup(createElement(DisplayUnitsProvider,null,createElement(AscendQuantizationEditor,{project:p,scenario,onProject:()=>{}})));
 expect(memory).toContain('取消模块范围展开');expect(memory).toContain('模块私有峰值 byte');expect(quantization).toContain('取消量化目标展开');expect(quantization).toContain('导入Ascend描述JSON');expect(expand).not.toHaveBeenCalled();
});
