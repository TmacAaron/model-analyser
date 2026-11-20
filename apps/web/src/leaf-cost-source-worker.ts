import {replayAggregateCostSource,replayExactLeafSource} from '@model-analyser/core';
import type {LeafSourceReply,LeafSourceTask} from './leaf-source-task.js';
import {leafSourceProofVersion} from './leaf-source-task.js';
import type {AggregateSourceReply,AggregateSourceTask} from './aggregate-source-task.js';

self.onmessage=async(event:MessageEvent<LeafSourceTask|AggregateSourceTask>)=>{
 const task=event.data;
 try{
  if(typeof task.taskId!=='string'||!task.taskId)throw Error('无效的来源任务');
  if(task.phase==='aggregate_cost_source'){
   self.postMessage({taskId:task.taskId,phase:task.phase,status:'available',report:await replayAggregateCostSource(task.request)} satisfies AggregateSourceReply);
   return;
  }
  if(task.phase!=='exact_leaf_source')throw Error('无效的精确来源任务');
  self.postMessage({taskId:task.taskId,phase:task.phase,status:'available',report:await replayExactLeafSource({...task.request,proofVersion:leafSourceProofVersion(task.request)})} satisfies LeafSourceReply);
 }catch(error){
  self.postMessage({taskId:task.taskId,phase:task.phase,status:'error',message:error instanceof Error?error.message:'来源复核失败'} satisfies LeafSourceReply|AggregateSourceReply);
 }
};
