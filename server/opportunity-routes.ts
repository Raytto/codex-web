import type { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { AppDatabase, SessionRow, JobRow, StoredAgentSelection } from './db.js';
import { OpportunityStore, OpportunityError } from './opportunity-store.js';
const err=(res:Response,e:unknown)=>res.status(e instanceof OpportunityError?e.status:400).json({error:e instanceof z.ZodError?e.issues.map(i=>i.path.join('.')+'：'+i.message).join('；'):e instanceof Error?e.message:'机会操作失败'});
export function mountOpportunityAutomation(api:Router,db:AppDatabase,authenticate:(req:Request)=>JobRow|null) {
  const store=new OpportunityStore(db);
  api.post('/automation/jobs/:jobId/opportunities',(req,res)=>{
    const job=authenticate(req);if(!job)return res.status(401).json({error:'任务凭据无效或任务已结束。'});
    const c=db.getConversation(job.conversation_id);if(!c?.project_id||c.deleted_at)return res.status(403).json({error:'当前会话不可用。'});
    try {
      store.serverProject(c.user_id,c.project_id);
      const action=String(req.body?.action??''),topicId=String(req.body?.topicId??''),data=req.body?.data??{},user=c.user_id;
      if(action==='topics')return res.json({topics:store.topics(user)});
      store.assertJob(user,topicId,c.id,job.id);
      const batchId=String(data.batchId??'');
      if(batchId&&store.batch(user,batchId).topic_id!==topicId)throw new OpportunityError(403,'批次不属于当前主题。');
      if(data.ideaId&&store.idea(user,String(data.ideaId)).topic_id!==topicId)throw new OpportunityError(403,'卡片不属于当前主题。');
      res.setHeader('Cache-Control','private, no-store');
      switch(action){
        case 'context': {
          const c=store.context(user,topicId);
          return res.json({instructions:c.instructions,topic:c.topic,feedbackRevision:c.feedbackRevision,preferences:c.preferences,feedback:c.feedback.slice(0,30),feedbackLearning:c.feedbackLearning,knowledge:c.knowledge,inventory:c.inventory.slice(0,25).map(i=>({id:i.id,state:i.state,score:i.score,title:i.content.title,summary:i.content.summary,mechanism:i.content.mechanism,quality:i.quality,first_created_at:i.first_created_at})),inventoryTotal:c.inventory.length,nextInventoryOffset:c.inventory.length>25?25:null,history:store.history(user,0,25),batches:c.batches.slice(0,5)});
        }
        case 'inventory': {const c=store.context(user,topicId),offset=z.number().int().nonnegative().parse(data.offset??0),limit=z.number().int().min(1).max(25).parse(data.limit??10);return res.json({items:c.inventory.slice(offset,offset+limit),total:c.inventory.length,nextOffset:offset+limit<c.inventory.length?offset+limit:null});}
        case 'history':return res.json(store.history(user,Number(data.offset)||0,Number(data.limit)||100));
        case 'detail':return res.json(store.detail(user,String(data.ideaId)));
        case 'evidence':return res.json(store.correctEvidence(user,String(data.ideaId),c.id,job.id,data));
        case 'begin':return res.json(store.begin(user,topicId,c.id,job.id));
        case 'ingest':return res.json({candidates:store.ingest(user,batchId,c.id,data.candidates).map(r=>({idea:{id:r.idea.id,state:r.idea.state,title:r.idea.content.title},outcome:r.outcome,neighbors:r.neighbors}))});
        case 'review': {const r=store.review(user,batchId,c.id,data.reviews);return res.json({reviewed:r.reviewed,inventoryCount:r.inventory.length,inventory:r.inventory.slice(0,50).map(i=>({id:i.id,title:i.content.title,state:i.state,score:i.score}))});}
        case 'publish':{const r=store.publish(user,batchId,c.id,data);return res.json({...r,ideas:r.ideas.map(i=>({id:i.id,title:i.content.title,first_recommended_at:i.first_recommended_at}))});}
        case 'fail':return res.json(store.failBatch(user,batchId,c.id,String(data.reason??'')));
        case 'recent':return res.json(store.recent(user,topicId,data.after===undefined?undefined:z.number().int().nonnegative().parse(data.after)));
        case 'feedback_inbox':return res.json(store.feedbackInbox(user,topicId));
        case 'learn_feedback':return res.json(store.learnFeedback(user,topicId,c.id,data));
        case 'preferences':return res.json({preferences:store.setPreference(user,topicId,data,true),feedbackRevision:store.feedbackRevision(user,topicId)});
        case 'feedback':return res.json({idea:store.feedback(user,String(data.ideaId),data,'user-via-agent')});
        case 'research_result':return res.json(store.researchResult(user,String(data.ideaId),c.id,data));
        default:throw new OpportunityError(400,'未知机会操作；先用 context 读取使用说明。');
      }
    }catch(e){return err(res,e);}
  });
}
export function mountOpportunityRoutes(api:Router,db:AppDatabase,options:{selection:(u:string,e:string)=>StoredAgentSelection;changed:(cid:string)=>void}) {
  const store=new OpportunityStore(db),owner=(res:Response)=>(res.locals.session as SessionRow).user_id;
  const handle=(fn:(req:Request,res:Response)=>unknown)=>(req:Request,res:Response)=>{try{res.setHeader('Cache-Control','private, no-store');return fn(req,res);}catch(e){return err(res,e);}};
  api.get('/opportunities/topics',handle((_req,res)=>res.json({topics:store.topics(owner(res))})));
  api.get('/opportunities',handle((req,res)=>res.json(store.view(owner(res),typeof req.query.topicId==='string'?req.query.topicId:undefined,String(req.query.tab??'screen'),Number(req.query.offset)||0))));
  api.post('/opportunities/topics',handle((req,res)=>res.status(201).json({topic:store.createTopic(owner(res),req.body,String(req.body?.requestKey))})));
  api.post('/opportunities/topics/reorder',handle((req,res)=>res.json({topics:store.reorderTopics(owner(res),req.body)})));
  api.patch('/opportunities/topics/:id/name',handle((req,res)=>res.json({topic:store.renameTopic(owner(res),String(req.params.id),req.body)})));
  api.get('/opportunities/topics/:id',handle((req,res)=>res.json(store.context(owner(res),String(req.params.id)))));
  api.patch('/opportunities/topics/:id',handle((req,res)=>res.json({topic:store.updateTopic(owner(res),String(req.params.id),req.body)})));
  api.post('/opportunities/topics/:id/lifecycle',handle((req,res)=>res.json(store.lifecycle(owner(res),String(req.params.id),z.number().int().positive().parse(req.body?.revision),z.enum(['archive','restore','delete']).parse(req.body?.action)))));
  api.post('/opportunities/topics/:id/task',handle((req,res)=>{const user=owner(res),t=store.topic(user,String(req.params.id)),p=store.serverProject(user,t.project_id);return res.json({task:store.configureTask(user,t.id,options.selection(user,p.executor_id),req.body?.taskId)});}));
  api.post('/opportunities/topics/:id/discover',handle((req,res)=>{const user=owner(res),t=store.topic(user,String(req.params.id)),p=store.serverProject(user,t.project_id);store.reconcile(user,t.id);const result=store.start(user,t.id,options.selection(user,p.executor_id),String(req.body?.requestKey));options.changed(result.conversationId);return res.status(201).json(result);}));
  api.post('/opportunities/topics/:id/preferences',handle((req,res)=>res.json({preferences:store.setPreference(owner(res),String(req.params.id),req.body)})));
  api.get('/opportunities/ideas/:id',handle((req,res)=>res.json(store.detail(owner(res),String(req.params.id)))));
  api.post('/opportunities/ideas/:id/feedback',handle((req,res)=>res.json({idea:store.feedback(owner(res),String(req.params.id),req.body)})));
  api.post('/opportunities/ideas/:id/research',handle((req,res)=>{const user=owner(res),idea=store.idea(user,String(req.params.id)),p=store.serverProject(user,idea.project_id),result=store.start(user,idea.topic_id,options.selection(user,p.executor_id),String(req.body?.requestKey),idea.id);options.changed(result.conversationId);return res.status(201).json(result);}));
  api.post('/opportunities/ideas/:id/project',handle((req,res)=>res.json({project:store.toProject(owner(res),String(req.params.id),String(req.body?.boardId),String(req.body?.requestKey))})));
}
