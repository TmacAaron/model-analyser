import {replayExactLeafSource} from '@model-analyser/core';
import type {LeafSourceReply,LeafSourceTask} from './leaf-source-task.js';
import {leafSourceProofVersion} from './leaf-source-task.js';
self.onmessage=async(event:MessageEvent<LeafSourceTask>)=>{const task=event.data;try{if(task.phase!=='exact_leaf_source'||typeof task.taskId!=='string'||!task.taskId)throw Error('无效的精确来源任务');self.postMessage({taskId:task.taskId,phase:task.phase,status:'available',report:await replayExactLeafSource({...task.request,proofVersion:leafSourceProofVersion(task.request)})} satisfies LeafSourceReply);}catch(e){self.postMessage({taskId:task.taskId,phase:'exact_leaf_source',status:'error',message:e instanceof Error?e.message:'精确来源复核失败'} satisfies LeafSourceReply);}};
