import { request } from './api';
import type { OpportunityView, OpportunityTopic, OpportunityDetail, OpportunityIdea, OpportunityPreference } from './opportunity-types';
import type { RecurringTask } from './recurring-types';
import type { ParaProject } from '../server/para-types';
const write=<T>(path:string,body:unknown,method='POST')=>request<T>('/opportunities'+path,{method,body:JSON.stringify(body)});
export const opportunities={
 view:(topicId:string,tab:string,offset=0)=>request<OpportunityView>(`/opportunities?tab=${tab}&offset=${offset}${topicId?'&topicId='+encodeURIComponent(topicId):''}`),
 create:(body:unknown)=>write<{topic:OpportunityTopic}>('/topics',body),
 update:(id:string,body:unknown)=>write<{topic:OpportunityTopic}>('/topics/'+id,body,'PATCH'),
 lifecycle:(t:OpportunityTopic,action:string)=>write<{ok:true}>('/topics/'+t.id+'/lifecycle',{revision:t.revision,action}),
 task:(topicId:string,taskId?:string)=>write<{task:RecurringTask}>('/topics/'+topicId+'/task',{taskId}),
 discover:(topicId:string,key:string)=>write<{conversationId:string;projectId:string}>('/topics/'+topicId+'/discover',{requestKey:key}),
 detail:(id:string)=>request<OpportunityDetail>('/opportunities/ideas/'+id),
 feedback:(id:string,body:unknown)=>write<{idea:OpportunityIdea}>('/ideas/'+id+'/feedback',body),
 preference:(tid:string,body:unknown)=>write<{preferences:OpportunityPreference[]}>('/topics/'+tid+'/preferences',body),
 research:(id:string,key:string)=>write<{conversationId:string;projectId:string}>('/ideas/'+id+'/research',{requestKey:key}),
 project:(id:string,boardId:string,key:string)=>write<{project:ParaProject}>('/ideas/'+id+'/project',{boardId,requestKey:key}),
};
