import { request } from './api';
import type { OpportunityView, OpportunityTopic, OpportunityTopicSummary, OpportunityDetail, OpportunityIdea, OpportunityPreference, OpportunityVoiceFeedback } from './opportunity-types';
import type { RecurringTask } from './recurring-types';
import type { ParaProject } from '../server/para-types';
const write=async<T>(path:string,body:unknown,method='POST')=>{
 const result=await request<T>('/opportunities'+path,{method,body:JSON.stringify(body)});
 window.dispatchEvent(new Event('opportunities-updated'));
 return result;
};
export const opportunities={
 topics:()=>request<{topics:OpportunityTopicSummary[]}>('/opportunities/topics'),
 view:(topicId:string,tab:string,offset=0)=>request<OpportunityView>(`/opportunities?tab=${tab}&offset=${offset}${topicId?'&topicId='+encodeURIComponent(topicId):''}`),
 reorder:(sourceId:string,targetId:string,placement:'before'|'after')=>write<{topics:OpportunityTopicSummary[]}>('/topics/reorder',{sourceId,targetId,placement}),
 rename:(t:OpportunityTopic,name:string)=>write<{topic:OpportunityTopic}>('/topics/'+t.id+'/name',{name,revision:t.revision},'PATCH'),
 create:(body:unknown)=>write<{topic:OpportunityTopic}>('/topics',body),
 update:(id:string,body:unknown)=>write<{topic:OpportunityTopic}>('/topics/'+id,body,'PATCH'),
 lifecycle:(t:OpportunityTopic,action:string)=>write<{ok:true}>('/topics/'+t.id+'/lifecycle',{revision:t.revision,action}),
 task:(topicId:string,taskId?:string)=>write<{task:RecurringTask}>('/topics/'+topicId+'/task',{taskId}),
 discover:(topicId:string,key:string)=>write<{conversationId:string;projectId:string}>('/topics/'+topicId+'/discover',{requestKey:key}),
 voiceFeedback:(id:string,audio:Blob,fileName:string,clientRecordingId:string,draftText:string,baseRevision?:number)=>{
  const body=new FormData();body.set('audio',audio,fileName);body.set('clientRecordingId',clientRecordingId);body.set('draftText',draftText);
  if(baseRevision!==undefined)body.set('baseRevision',String(baseRevision));
  return request<{accepted:true;submission:OpportunityVoiceFeedback}>('/opportunities/ideas/'+id+'/voice-feedback',{method:'POST',body},{timeoutMs:600_000});
 },
 retryVoice:(id:string,voiceId:string)=>write<{accepted:true}>('/ideas/'+id+'/voice-feedback/'+voiceId+'/retry',{}),
 detail:(id:string)=>request<OpportunityDetail>('/opportunities/ideas/'+id),
 returnToReserve:(id:string,body:unknown)=>write<{idea:OpportunityIdea}>('/ideas/'+id+'/return-to-reserve',body),
 feedback:(id:string,body:unknown)=>write<{idea:OpportunityIdea}>('/ideas/'+id+'/feedback',body),
 preference:(tid:string,body:unknown)=>write<{preferences:OpportunityPreference[]}>('/topics/'+tid+'/preferences',body),
 research:(id:string,key:string,draftFeedback?:{rating:number|null;note:string},projectId?:string)=>write<{conversationId:string;projectId:string}>('/ideas/'+id+'/research',{requestKey:key,draftFeedback,projectId}),
 project:(id:string,boardId:string,key:string)=>write<{project:ParaProject}>('/ideas/'+id+'/project',{boardId,requestKey:key}),
};
