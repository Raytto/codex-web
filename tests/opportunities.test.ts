import sharp from 'sharp';
import { OpportunityImages } from '../server/opportunity-images.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppDatabase, LEGACY_USER_ID } from '../server/db.js';
import { OpportunityStore, contentInput } from '../server/opportunity-store.js';
import { opportunitySimilarity } from '../server/opportunity-similarity.js';
import { RecurringStore } from '../server/recurring-store.js';
import { ParaStore } from '../server/para-store.js';
import { createApp } from '../server/app.js';
import { createJobAutomationToken } from '../server/wake-automation.js';
const id=()=>crypto.randomUUID(),u=LEGACY_USER_ID,selection={model:'gpt-6-sol',reasoningEffort:'medium'},day=Date.parse('2026-10-14T01:00:00Z');
const content=(n:number)=>contentInput.parse({title:'候选 '+n,summary:'第 '+n+' 种独立实验',audience:'儿童',problem:'探索问题 '+n,mechanism:'具体互动机制 '+n,value:'独立学习价值 '+n,fit:'在主题投入限制内',facts:'来源说明',assumptions:'乐趣待孩子验证',doubt:'首次互动是否足够清晰',validation:'完成纸面和浏览器两分钟试验',difference:'问题与核心机制独立编号 '+n,category:'实验 '+n,keywords:['探索','实验'+n],sources:[{title:'Canvas API',url:'https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API',date:'2026-10-14',finding:'浏览器可以绘制交互图形'}]});
function fixture(t:test.TestContext){const root=fs.mkdtempSync(path.join(os.tmpdir(),'opportunity-')),db=new AppDatabase(root),s=new OpportunityStore(db),p=db.createProject(id(),u,'Server',root,'tenant-local'),c=db.createConversation(id(),'Discovery',selection,u,p.id),topic=s.createTopic(u,{name:'验收主题',project_id:p.id,goal:'探索不同创作游戏'},id());t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});return {root,db,s,p,c,topic};}
function reviewAll(s:OpportunityStore,topicId:string,bid:string,cid:string){const pool=s.context(u,topicId).inventory;return s.review(u,bid,cid,pool.map((v,i)=>({idea_id:v.id,verdict:'approve',score:90-i/100,quality:85,rationale:'证据、投入和独立可验证性通过；根据当前偏好重排',compared:s.neighbors(u,v.content,v.id).map(n=>({id:n.id,difference:'编号代表具体不同的试验问题与核心机制，仅共享受众'}))})));}
function learn(s:OpportunityStore,tid:string,cid:string){let page=s.feedbackInbox(u,tid);while(page.pending){s.learnFeedback(u,tid,cid,{requestKey:id(),after:page.watermark,through:page.through,feedbackRevision:page.feedbackRevision,summary:'测试逐页归纳：保留原始反馈，暂未推断通用偏好',principles:[]});page=s.feedbackInbox(u,tid);}}
// These inventory tests exercise ranking, not media validation; seed explicit metadata.
function seedImage(s:OpportunityStore,ideaId:string,cid:string){if(!s.images(u,ideaId).length)s.sql.prepare('INSERT INTO opportunity_images VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id(),ideaId,u,cid,'outputs/fixture.png','image/png',1,'fixture',1,1,'测试图','',0,new Date().toISOString());}
function publish(s:OpportunityStore,tid:string,bid:string,cid:string,ids:string[]){ids.forEach(i=>seedImage(s,i,cid));return s.publish(u,bid,cid,{ids,summary:'以适配与玩法组合多样性选取，其余合格项继续保留',feedbackRevision:s.feedbackRevision(u,tid)});}
test('multi-day inventory: 10 -> 3+7; new 10 -> 17 -> 3+14; zero new still selects stable old identities',t=>{const {s,c,topic}=fixture(t);const b1=s.begin(u,topic.id,c.id,null,day);const first=s.ingest(u,b1.id,c.id,Array.from({length:10},(_,i)=>({key:'d1-'+i,content:content(i)})));reviewAll(s,topic.id,b1.id,c.id);publish(s,topic.id,b1.id,c.id,first.slice(0,3).map(v=>v.idea.id));assert.equal(s.context(u,topic.id).inventory.length,7);assert.equal(s.history(u).total,10);
 const c2=s.db.createConversation(id(),'Next day',selection,u,c.project_id!),b2=s.begin(u,topic.id,c2.id,null,day+86400000);s.ingest(u,b2.id,c2.id,Array.from({length:10},(_,i)=>({key:'d2-'+i,content:content(i+10)})));assert.equal(s.context(u,topic.id).inventory.length,17);assert.throws(()=>publish(s,topic.id,b2.id,c2.id,[first[3].idea.id]),/尚未参与/);reviewAll(s,topic.id,b2.id,c2.id);publish(s,topic.id,b2.id,c2.id,first.slice(3,6).map(v=>v.idea.id));assert.equal(s.context(u,topic.id).inventory.length,14);assert.ok(s.idea(u,first[3].idea.id).first_recommended_at);assert.equal(s.idea(u,first[3].idea.id).source_batch_id,b1.id);assert.equal(s.idea(u,first[3].idea.id).recommended_batch_id,b2.id);
 assert.equal(s.begin(u,topic.id,c2.id,null,day+86400000).id,b2.id);const retried=publish(s,topic.id,b2.id,c2.id,first.slice(3,6).map(v=>v.idea.id));assert.equal(retried.idempotent,true);assert.equal(s.history(u).total,20);
 const b3=s.begin(u,topic.id,c2.id,null,day+172800000);reviewAll(s,topic.id,b3.id,c2.id);publish(s,topic.id,b3.id,c2.id,first.slice(6,9).map(v=>v.idea.id));assert.equal(s.context(u,topic.id).inventory.length,11);assert.equal(s.history(u).total,20);
 assert.deepEqual(s.db.sqlite.prepare('pragma foreign_key_check').all(),[]);
});
test('all raw candidates persist, same key is idempotent, exact/synonym content reuses identity across topic and rejected history',t=>{const {s,c,topic,p}=fixture(t),b=s.begin(u,topic.id,c.id,null,day),fish={...content(1),title:'画鱼',audience:'孩子',problem:'我的手绘作品',mechanism:'画出小鱼让它动起来并游动',value:'绘画参与'};const a=s.ingest(u,b.id,c.id,[{key:'fish',content:fish}])[0];const same=s.ingest(u,b.id,c.id,[{key:'fish',content:fish}])[0];assert.equal(a.idea.id,same.idea.id);assert.throws(()=>s.ingest(u,b.id,c.id,[{key:'fish',content:{...fish,title:'改标题'}}]),/内容不同/);
 const synonym={...fish,title:'自己的小鱼活过来',audience:'儿童',problem:'我的绘画作品',mechanism:'绘制鱼儿让它活动起来并游泳',value:'画画参与'};const dup=s.ingest(u,b.id,c.id,[{key:'synonym',content:synonym}])[0];assert.equal(dup.idea.id,a.idea.id);assert.equal(dup.outcome,'duplicate');
 s.review(u,b.id,c.id,[{idea_id:a.idea.id,verdict:'reject',score:20,quality:20,rationale:'测试不合格初筛',compared:[]}]);assert.equal(s.detail(u,a.idea.id).feedback.length,0);
 const topic2=s.createTopic(u,{name:'另一主题',project_id:p.id,goal:'相近方向'},id()),b2=s.begin(u,topic2.id,c.id,null,day);const cross=s.ingest(u,b2.id,c.id,[{key:'reworded',content:{...synonym,sources:[...synonym.sources,{title:'新证据',url:'https://example.org/new-evidence',date:'2026-10-14',finding:'新来源不会使旧卡重新推荐'}]}}])[0];assert.equal(cross.idea.id,a.idea.id);assert.equal(cross.idea.state,'internal_rejected');assert.equal(s.history(u).total,1);assert.equal(s.detail(u,a.idea.id).versions.length,2);assert.equal(s.idea(u,a.idea.id).content.sources.length,2);assert.equal(Number((s.sql.prepare('select count(*) n from opportunity_candidates').get() as {n:number}).n),3);
});
test('semantic recall catches Chinese paraphrases, requires material judgment and permits truly different mechanics',t=>{const {s,c,topic}=fixture(t),b=s.begin(u,topic.id,c.id,null,day);const a={...content(1),title:'线索足迹',problem:'小朋友发现线索',mechanism:'儿童点击现场脚印，观察痕迹推理并寻找角色',summary:'根据留下的线索找出是谁来过',keywords:['侦探','脚印','线索']};const bContent={...content(2),title:'谁来过这里',problem:'孩子搜寻踪迹',mechanism:'小朋友轻点现场的足印，观察线索断案并搜寻人物',summary:'根据留下的踪迹寻找来访者',keywords:['破案','足印','痕迹']};assert.ok(opportunitySimilarity(a,bContent)>=.35);
 const first=s.ingest(u,b.id,c.id,[{key:'a',content:a}])[0],second=s.ingest(u,b.id,c.id,[{key:'b',content:bContent}])[0];assert.ok(second.neighbors.some(n=>n.id===first.idea.id));assert.throws(()=>s.review(u,b.id,c.id,[{idea_id:second.idea.id,verdict:'approve',score:90,quality:80,rationale:'只改了标题',compared:[]}]),/逐一比较/);
 s.review(u,b.id,c.id,[{idea_id:second.idea.id,verdict:'duplicate',duplicate_of:first.idea.id,score:80,quality:80,rationale:'同样以足迹推理人物，未增加核心互动',compared:[{id:first.idea.id,difference:'没有实质差异'}]}]);assert.equal(s.idea(u,second.idea.id).duplicate_of,first.idea.id);
 const different={...a,title:'绘画节奏花园',problem:'探索音乐节拍',mechanism:'儿童绘画花朵，通过拖动改变节奏，按声音排列循环',summary:'画出的花朵产生乐声',keywords:['声音','节奏','绘画']};assert.ok(opportunitySimilarity(a,different)<.65);s.ingest(u,b.id,c.id,[{key:'different',content:different}]);reviewAll(s,topic.id,b.id,c.id);assert.equal(s.context(u,topic.id).inventory.length,2);
});
test('feedback is durable, distinguishes reasons, stale ranking cannot publish; manual handling excludes reserve and undo restores',t=>{const {s,c,topic}=fixture(t),b=s.begin(u,topic.id,c.id,null,day),ideas=s.ingest(u,b.id,c.id,[{key:'one',content:content(1)},{key:'two',content:content(2)}]);reviewAll(s,topic.id,b.id,c.id);const before=s.feedbackRevision(u,topic.id),i=s.idea(u,ideas[0].idea.id),f=s.feedback(u,i.id,{requestKey:id(),revision:i.revision,action:'later',reason:'no_time',rating:5,note:'暑假再做'});assert.equal(f.state,'later');assert.equal(s.context(u,topic.id).inventory.length,1);assert.throws(()=>s.publish(u,b.id,c.id,{ids:[],summary:'不足',feedbackRevision:before}),/反馈已更新/);assert.equal(s.context(u,topic.id).feedback[0].reason,'no_time');assert.throws(()=>publish(s,topic.id,b.id,c.id,[]),/未归纳/);learn(s,topic.id,c.id);reviewAll(s,topic.id,b.id,c.id);assert.throws(()=>publish(s,topic.id,b.id,c.id,[i.id]),/未经人工|从未正式/);
 const undone=s.feedback(u,i.id,{requestKey:id(),revision:f.revision,action:'undo'});assert.equal(undone.state,'reserve');assert.equal(undone.manual_processed,0);assert.equal(s.context(u,topic.id).inventory.length,2);
 learn(s,topic.id,c.id);s.review(u,b.id,c.id,[{idea_id:i.id,verdict:'expired',score:0,quality:0,rationale:'依赖服务关闭，已有来源不再适用',compared:[]}]);assert.equal(s.idea(u,i.id).state,'expired');assert.ok(s.idea(u,i.id).state_reason.includes('服务关闭'));assert.equal(s.history(u).total,2);
});
test('native task is sole execution authority: paused creation, edited prompt/model, correct project, archive/delete and remote guard',t=>{const {s,c,topic,p,db}=fixture(t);assert.equal(new RecurringStore(db).list(u).length,0);const task=s.configureTask(u,topic.id,selection);assert.equal(task.state,'paused');assert.equal(s.configureTask(u,topic.id,selection).id,task.id);assert.equal(new RecurringStore(db).list(u).length,1);const r=new RecurringStore(db),changed=r.update(u,task.id,task.revision,{...task,prompt:'CHANGED_NATIVE_PROMPT',model:'gpt-6-astra',reasoningEffort:'max',schedule:{...task.schedule,kind:'interval',intervalMinutes:1}},'active',day)!;const cid=r.fire(u,task.id,Date.parse(changed.nextRunAt!))!;assert.equal(db.getConversation(cid)?.project_id,p.id);assert.ok(db.listPendingPrompts(cid)[0].content.includes('CHANGED_NATIVE_PROMPT'));assert.ok(db.listPendingPrompts(cid)[0].content.includes(topic.id));assert.match(db.listPendingPrompts(cid)[0].content,/feedback_inbox/);assert.match(db.listPendingPrompts(cid)[0].content,/learn_feedback/);assert.equal(r.get(u,task.id)?.prompt,'CHANGED_NATIVE_PROMPT');assert.equal(db.getConversation(cid)?.agent_model,'gpt-6-astra');
 assert.equal(r.fire(u,task.id,Date.parse(changed.nextRunAt!)+60000),null);db.deletePendingPromptsForConversation(cid);
 s.lifecycle(u,topic.id,s.topic(u,topic.id).revision,'archive');assert.equal(r.get(u,task.id)?.state,'paused');s.lifecycle(u,topic.id,s.topic(u,topic.id).revision,'restore');assert.equal(r.get(u,task.id)?.state,'paused');
 const active=r.update(u,task.id,r.get(u,task.id)!.revision,task,'active',day)!;db.sqlite.prepare('UPDATE projects SET executor_id=? WHERE id=?').run('remote:bad',p.id);assert.equal(r.fire(u,task.id,Date.parse(active.nextRunAt!)),null);assert.equal(r.get(u,task.id)?.state,'paused');assert.throws(()=>s.begin(u,topic.id,c.id,null),/服务器项目/);db.sqlite.prepare("UPDATE projects SET executor_id='tenant-local' WHERE id=?").run(p.id);s.lifecycle(u,topic.id,s.topic(u,topic.id).revision,'delete');assert.equal(r.list(u).length,0);assert.ok(db.getConversation(cid));
});
test('failed jobs release batch, finite attempts, cross-account ownership and scoped preferences',t=>{const {s,c,topic,p,db}=fixture(t),j=db.createJob(id(),c.id,undefined,selection);db.sqlite.prepare("UPDATE jobs SET status='running' WHERE id=?").run(j.id);const b=s.begin(u,topic.id,c.id,j.id,day);db.sqlite.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(j.id);s.reconcile(u,topic.id);assert.equal(s.batch(u,b.id).status,'failed');const c2=db.createConversation(id(),'retry',selection,u,p.id);assert.equal(s.begin(u,topic.id,c2.id,null,day).attempts,2);s.failBatch(u,b.id,c2.id,'证据获取失败');assert.equal(s.begin(u,topic.id,c2.id,null,day).attempts,3);s.failBatch(u,b.id,c2.id,'仍然失败');assert.throws(()=>s.begin(u,topic.id,c2.id,null,day),/三次/);
 const other=id();assert.throws(()=>s.topic(other,topic.id),/不存在/);assert.throws(()=>s.batch(other,b.id),/不存在/);assert.throws(()=>s.serverProject(other,p.id),/不存在/);assert.throws(()=>s.setPreference(u,topic.id,{text:'全局推断',kind:'inferred',scope:'account',source:'topic-goal'},true),/当前主题/);const pref=s.setPreference(u,topic.id,{text:'偏好创作',kind:'explicit',source:'用户设置'})[0];s.setPreference(u,topic.id,{...pref,active:false});assert.equal(s.preferences(u,topic.id).length,0);assert.equal(s.preferences(u,topic.id,true).length,1);assert.throws(()=>s.recent(u,topic.id),/尚未授权/);
});
test('optional feature is independent, defaults false, and old clients cannot clear opted-in flag',t=>{const {db}=fixture(t);db.sqlite.prepare("INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,'feature_selection',?,'now')").run(u,JSON.stringify({paraBoard:true,revision:7}));assert.deepEqual(db.getFeatureSelection(u),{paraBoard:true,opportunityCards:false,revision:7});db.setFeatureSelection(u,{paraBoard:true,opportunityCards:true,revision:7});db.setFeatureSelection(u,{paraBoard:false,revision:8});assert.deepEqual(db.getFeatureSelection(u),{paraBoard:false,opportunityCards:true,revision:9});});
test('research and project promotion use normal conversations and stable links without automatic validation',t=>{const {s,c,topic,db}=fixture(t),b=s.begin(u,topic.id,c.id,null,day),idea=s.ingest(u,b.id,c.id,[{key:'research',content:content(1)}])[0].idea;const k=id(),started=s.start(u,topic.id,selection,k,idea.id);assert.equal(s.start(u,topic.id,selection,k,idea.id).conversationId,started.conversationId);assert.equal(db.listPendingPrompts(started.conversationId).length,0);assert.ok(db.getComposerDraft(started.conversationId)?.content.includes(idea.id));assert.equal(s.detail(u,idea.id).research[0].status,'interested');s.researchResult(u,idea.id,started.conversationId,{status:'inconclusive',result:'资料支持可实现，儿童体验还需实测'});assert.equal(s.detail(u,idea.id).research[0].status,'inconclusive');const para=new ParaStore(db),board=para.createBoard(u,'机会实验',null),promoted=s.toProject(u,idea.id,board.id,id());assert.equal(s.toProject(u,idea.id,board.id,id()).id,promoted.id);assert.equal(s.idea(u,idea.id).state,'project');assert.equal(promoted.stage,'idea');});
test('research drafts preserve feedback, unsaved ideas and edits without enqueueing work',t=>{
 const {s,c,topic,db,p}=fixture(t),b=s.begin(u,topic.id,c.id,null,day);
 const ideas=s.ingest(u,b.id,c.id,[{key:'draft',content:content(21)},{key:'unrelated',content:content(22)}]);
 const original=ideas[0].idea;
 const first=s.feedback(u,original.id,{requestKey:id(),revision:original.revision,action:'rate',rating:4,note:'先验证自由绘画\n再尝试角色试戴'});
 const second=s.feedback(u,original.id,{requestKey:id(),revision:first.revision,action:'rate',rating:2,note:'已撤销的方向'});
 const current=s.feedback(u,original.id,{requestKey:id(),revision:second.revision,action:'undo'});
 s.feedback(u,ideas[1].idea.id,{requestKey:id(),revision:ideas[1].idea.revision,action:'rate',note:'OTHER_CARD_PRIVATE_NOTE'});
 const key=id(),draftFeedback={rating:5,note:'本次补充：保留原始笔触\n先做最小原型'};
 const started=s.start(u,topic.id,selection,key,original.id,draftFeedback),cid=started.conversationId;
 const draft=db.getComposerDraft(cid)!;
 assert.equal(db.getConversation(cid)?.project_id,p.id);
 assert.match(draft.content,/评分：4 星/);assert.match(draft.content,/先验证自由绘画\n再尝试角色试戴/);
 assert.ok(draft.content.includes(draftFeedback.note));assert.match(draft.content,/尚未保存到卡片/);
 assert.match(draft.content,/撤销上次/);assert.match(draft.content,/不作为当前要求/);
 assert.ok(!draft.content.includes('OTHER_CARD_PRIVATE_NOTE'));
 assert.equal(s.idea(u,original.id).rating,current.rating);assert.equal(s.idea(u,original.id).note,current.note);
 assert.equal(s.detail(u,original.id).feedback.length,3);
 for(const table of ['pending_prompts','messages','jobs'])assert.equal(db.sqlite.prepare(`SELECT count(*) n FROM ${table} WHERE conversation_id=?`).get(cid)?.n,0);
 db.saveComposerDraft(cid,draft.content+'\n我手动补充的内容',null);
 assert.equal(s.start(u,topic.id,selection,key,original.id,draftFeedback).conversationId,cid);
 assert.ok(db.getComposerDraft(cid)?.content.endsWith('我手动补充的内容'));
 assert.equal(s.detail(u,original.id).research.length,1);
 const before=db.sqlite.prepare('SELECT count(*) n FROM conversations').get()?.n;
 assert.throws(()=>s.start(u,topic.id,selection,id(),original.id,{rating:6,note:'bad'}));
 assert.throws(()=>s.start(u,topic.id,selection,id(),original.id,{rating:null,note:'x'.repeat(6001)}));
 assert.equal(db.sqlite.prepare('SELECT count(*) n FROM conversations').get()?.n,before);
});

test('real routes enforce CSRF, ownership, server executor, live job credential and no feature-driven background creation',async t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'opportunity-api-')),password='fixture-password',secret='opportunity-test-secret-at-least-32-characters';const app=createApp({ basePath: "",projectRoot:process.cwd(),dataRoot:path.join(root,'data'),tenantRoot:path.join(root,'tenants'),queueAutoStart:false,username:'pp',passwordHash:bcrypt.hashSync(password,4),sessionSecret:secret,minimumFreeDiskBytes:0});t.after(()=>{app.beginShutdown();app.db.close();fs.rmSync(root,{recursive:true,force:true});});const a=request.agent(app.app),login=await a.post('/api/auth/login').send({username:'pp',password}).expect(200),csrf=login.body.csrfToken,p=app.db.createProject(id(),u,'API Server',root,'tenant-local');const body={requestKey:id(),name:'API topic',project_id:p.id,goal:'探索'};await a.post('/api/opportunities/topics').send(body).expect(403);const created=await a.post('/api/opportunities/topics').set('X-CSRF-Token',csrf).send(body).expect(201);const tid=created.body.topic.id;
 assert.equal(new RecurringStore(app.db).list(u).length,0);await a.put('/api/user-settings/features').set('X-CSRF-Token',csrf).send({paraBoard:false,opportunityCards:true,revision:0}).expect(200);assert.equal(new RecurringStore(app.db).list(u).length,0);
 const other=id(),now=new Date().toISOString();app.db.createUser({id:other,username:'other',display_name:'Other',password_hash:bcrypt.hashSync(password,4),role:'member',status:'active',created_at:now,updated_at:now});const friend=request.agent(app.app),fl=await friend.post('/api/auth/login').send({username:'other',password}).expect(200);await friend.get('/api/opportunities/topics/'+tid).expect(404);await friend.patch('/api/opportunities/topics/'+tid).set('X-CSRF-Token',fl.body.csrfToken).send({...body,revision:1}).expect(404);assert.equal((await friend.get('/api/opportunities')).body.topics.length,0);
 await request(app.app).get('/api/opportunities/topics').expect(401);
 const listing=await a.get('/api/opportunities/topics').expect(200);assert.deepEqual(listing.body.topics.map((v:{id:string})=>v.id),[tid]);assert.equal(listing.body.ideas,undefined);assert.match(listing.headers['cache-control'],/no-store/);
 assert.deepEqual((await friend.get('/api/opportunities/topics').expect(200)).body.topics,[]);
 const second=await a.post('/api/opportunities/topics').set('X-CSRF-Token',csrf).send({...body,name:'Second',requestKey:id()}).expect(201);
 const movement={sourceId:second.body.topic.id,targetId:tid,placement:'before'};
 await a.post('/api/opportunities/topics/reorder').send(movement).expect(403);
 await friend.post('/api/opportunities/topics/reorder').set('X-CSRF-Token',fl.body.csrfToken).send(movement).expect(404);
 await a.post('/api/opportunities/topics/reorder').set('X-CSRF-Token',csrf).send({...movement,placement:'invalid'}).expect(400);
 const reordered=await a.post('/api/opportunities/topics/reorder').set('X-CSRF-Token',csrf).send(movement).expect(200);
 assert.deepEqual(reordered.body.topics.map((v:{id:string})=>v.id),[second.body.topic.id,tid]);
 await a.patch('/api/opportunities/topics/'+tid+'/name').send({name:'New',revision:1}).expect(403);
 await friend.patch('/api/opportunities/topics/'+tid+'/name').set('X-CSRF-Token',fl.body.csrfToken).send({name:'New',revision:1}).expect(404);
 await a.patch('/api/opportunities/topics/'+tid+'/name').set('X-CSRF-Token',csrf).send({name:'New',revision:1}).expect(200);
 await a.patch('/api/opportunities/topics/'+tid+'/name').set('X-CSRF-Token',csrf).send({name:'Stale',revision:1}).expect(409);
 const c=app.db.createConversation(id(),'Agent',selection,u,p.id),j=app.db.createJob(id(),c.id,undefined,selection);app.db.sqlite.prepare("UPDATE jobs SET status='running' WHERE id=?").run(j.id);const token=createJobAutomationToken(secret,j.id,c.id,Date.now(),86400000,app.db.workflows.assertJob(j.id).epoch);await request(app.app).post(`/api/automation/jobs/${j.id}/opportunities`).set('Authorization','Bearer '+token).send({action:'context',topicId:tid}).expect(200);
 const store=new OpportunityStore(app.db),batch=store.begin(u,tid,c.id,j.id),idea=store.ingest(u,batch.id,c.id,[{key:'route',content:content(9)}])[0].idea;
 const corrected=await request(app.app).post(`/api/automation/jobs/${j.id}/opportunities`).set('Authorization','Bearer '+token).send({action:'evidence',topicId:tid,data:{ideaId:idea.id,requestKey:id(),revision:idea.revision,reason:'实际受控接口更正',patch:{facts:'有来源支持的更正事实'}}}).expect(200);assert.equal(corrected.body.idea.content.facts,'有来源支持的更正事实');
 const imageDir=path.join(root,'tenants',u,'conversations',c.id,'outputs');fs.mkdirSync(imageDir,{recursive:true});
 const imageBytes=await sharp({create:{width:32,height:24,channels:3,background:'#ffeedd'}}).png().toBuffer();fs.writeFileSync(path.join(imageDir,'concept.png'),imageBytes);
 const imageBody={action:'images',topicId:tid,data:{ideaId:idea.id,requestKey:id(),revision:corrected.body.idea.revision,images:[{path:'outputs/concept.png',alt:'概念图'}]}};
 const imageRoute=`/api/automation/jobs/${j.id}/opportunities`;
 await request(app.app).post(imageRoute).send(imageBody).expect(401);
 const attached=await request(app.app).post(imageRoute).set('Authorization','Bearer '+token).send(imageBody).expect(200);
 assert.equal(attached.body.idea.images.length,1);const mediaUrl=attached.body.idea.images[0].url;
 assert.deepEqual((await request(app.app).post(imageRoute).set('Authorization','Bearer '+token).send(imageBody).expect(200)).body,attached.body);
 await request(app.app).get(mediaUrl).expect(401);await friend.get(mediaUrl).expect(404);
 const imageResult=await a.get(mediaUrl).expect(200);assert.deepEqual(imageResult.body,imageBytes);assert.equal(imageResult.headers['content-type'],'image/png');
 await a.post(mediaUrl+'/activate').send({}).expect(403);await friend.post(mediaUrl+'/activate').set('X-CSRF-Token',fl.body.csrfToken).send({}).expect(404);
 await a.post(mediaUrl+'/activate').set('X-CSRF-Token',csrf).send({}).expect(200);
 app.db.sqlite.prepare("UPDATE conversation_storage SET state='cold' WHERE conversation_id=?").run(c.id);
 const activity=app.db.getConversation(c.id)!.last_active_at;
 assert.equal((await a.get(mediaUrl+'/status').expect(200)).body.state,'cold');await a.get(mediaUrl).expect(409);
 assert.equal(app.db.getConversation(c.id)!.last_active_at,activity);
 app.db.sqlite.prepare("UPDATE conversation_storage SET state='local' WHERE conversation_id=?").run(c.id);
 await a.get(mediaUrl).expect(200);
 reviewAll(store,tid,batch.id,c.id);publish(store,tid,batch.id,c.id,[idea.id]);
 const returnBody={topicId:tid,requestKey:id(),revision:store.idea(u,idea.id).revision,reason:'API queue management'};
 const returnUrl=`/api/opportunities/ideas/${idea.id}/return-to-reserve`;
 await a.post(returnUrl).send(returnBody).expect(403);
 await friend.post(returnUrl).set('X-CSRF-Token',fl.body.csrfToken).send(returnBody).expect(404);
 await a.post(returnUrl).set('X-CSRF-Token',csrf).send({...returnBody,topicId:second.body.topic.id}).expect(403);
 await request(app.app).post(imageRoute).set('Authorization','Bearer '+token).send({action:'return_to_reserve',topicId:second.body.topic.id,data:{...returnBody,ideaId:idea.id}}).expect(403);
 const returned=await a.post(returnUrl).set('X-CSRF-Token',csrf).send(returnBody).expect(200);assert.equal(returned.body.idea.state,'reserve');
 assert.deepEqual((await a.post(returnUrl).set('X-CSRF-Token',csrf).send(returnBody).expect(200)).body,returned.body);
 const capBody={requestKey:id(),revision:store.topic(u,tid).revision,pendingLimit:3};
 await a.post(`/api/opportunities/topics/${tid}/backlog-limit`).send(capBody).expect(403);
 await friend.post(`/api/opportunities/topics/${tid}/backlog-limit`).set('X-CSRF-Token',fl.body.csrfToken).send(capBody).expect(404);
 await request(app.app).post(imageRoute).set('Authorization','Bearer '+token).send({action:'backlog_limit',topicId:tid,data:capBody}).expect(200);
 const queueContext=await request(app.app).post(imageRoute).set('Authorization','Bearer '+token).send({action:'context',topicId:tid}).expect(200);
 assert.equal(queueContext.body.capacity.pendingLimit,3);assert.equal(queueContext.body.inventory[0].returned,true);assert.equal(queueContext.body.inventory[0].queueEvents[0].action,'return_to_reserve');
 const rated=store.idea(u,idea.id);store.feedback(u,idea.id,{requestKey:id(),revision:rated.revision,action:'rate',rating:5,note:'优先容易验证的方案'});
 const researchUrl=`/api/opportunities/ideas/${idea.id}/research`,researchBody={requestKey:id(),draftFeedback:{rating:4,note:'验证具体实现步骤'}};
 await a.post(researchUrl).send(researchBody).expect(403);
 await friend.post(researchUrl).set('X-CSRF-Token',fl.body.csrfToken).send(researchBody).expect(404);
 await a.post(researchUrl).set('X-CSRF-Token',csrf).send({...researchBody,draftFeedback:{rating:9,note:'invalid'}}).expect(400);
 const research=await a.post(researchUrl).set('X-CSRF-Token',csrf).send(researchBody).expect(201);
 const draftCid=research.body.conversationId;
 const detail=(await a.get(`/api/conversations/${draftCid}`).expect(200)).body;
 assert.match(detail.composerDraft.content,/优先容易验证的方案/);assert.match(detail.composerDraft.content,/验证具体实现步骤/);
 assert.equal(app.db.listPendingPrompts(draftCid).length,0);
 assert.equal(app.db.sqlite.prepare('SELECT count(*) n FROM jobs WHERE conversation_id=?').get(draftCid)?.n,0);
 await a.put(`/api/conversations/${draftCid}/draft`).set('X-CSRF-Token',csrf).send({content:'用户调整后的研究指令',quoteExcerpt:null}).expect(200);
 const retry=await a.post(researchUrl).set('X-CSRF-Token',csrf).send(researchBody).expect(201);
 assert.equal(retry.body.conversationId,draftCid);assert.equal(app.db.getComposerDraft(draftCid)?.content,'用户调整后的研究指令');
 const inbox=await request(app.app).post(`/api/automation/jobs/${j.id}/opportunities`).set('Authorization','Bearer '+token).send({action:'feedback_inbox',topicId:tid}).expect(200);assert.equal(inbox.body.pending,1);
 await request(app.app).post(`/api/automation/jobs/${j.id}/opportunities`).set('Authorization','Bearer '+token).send({action:'learn_feedback',topicId:tid,data:{requestKey:id(),after:inbox.body.watermark,through:inbox.body.through,feedbackRevision:inbox.body.feedbackRevision,summary:'明确反馈凝练验证原则',principles:[{text:'优先容易验证的方案',kind:'explicit',source:inbox.body.items[0].id}]}}).expect(200);assert.equal(store.feedbackLearning(u,tid).pending,0);assert.equal(store.preferences(u,tid)[0].text,'优先容易验证的方案');
 const otherTopic=store.createTopic(u,{name:'Other topic',project_id:p.id,goal:'different scope'},id());await request(app.app).post(`/api/automation/jobs/${j.id}/opportunities`).set('Authorization','Bearer '+token).send({action:'evidence',topicId:otherTopic.id,data:{ideaId:idea.id}}).expect(403);
 app.db.sqlite.prepare("UPDATE projects SET executor_id='remote:fixture' WHERE id=?").run(p.id);await request(app.app).post(`/api/automation/jobs/${j.id}/opportunities`).set('Authorization','Bearer '+token).send({action:'context',topicId:tid}).expect(403);app.db.sqlite.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(j.id);await request(app.app).post(`/api/automation/jobs/${j.id}/opportunities`).set('Authorization','Bearer '+token).send({action:'topics'}).expect(401);
});

test('normal conversation GC preserves minimal opportunity identity and removes stale executable links',t=>{const {s,c,topic,db}=fixture(t),b=s.begin(u,topic.id,c.id,null,day),idea=s.ingest(u,b.id,c.id,[{key:'gc',content:content(1)}])[0].idea;db.sqlite.prepare('DELETE FROM conversations WHERE id=?').run(c.id);const d=s.detail(u,idea.id);assert.equal(d.idea.id,idea.id);assert.equal(d.availableConversations.length,0);assert.equal(s.history(u).total,1);assert.deepEqual(db.sqlite.prepare('pragma foreign_key_check').all(),[]);});

test('native and manual starts reserve durable batches; a job that fails before its first tool is visible and bounded',t=>{const {s,c,topic,p,db}=fixture(t);const started=s.start(u,topic.id,selection,id());assert.equal(s.batches(u,topic.id).length,1);assert.equal(s.start(u,topic.id,selection,id()).conversationId,started.conversationId);db.deletePendingPromptsForConversation(started.conversationId);s.reconcile(u,topic.id);assert.equal(s.batches(u,topic.id)[0].status,'failed');const retried=s.start(u,topic.id,selection,id());assert.notEqual(retried.conversationId,started.conversationId);assert.equal(s.batches(u,topic.id)[0].attempts,2);db.deletePendingPromptsForConversation(retried.conversationId);s.reconcile(u,topic.id);const third=s.start(u,topic.id,selection,id());db.deletePendingPromptsForConversation(third.conversationId);s.reconcile(u,topic.id);assert.throws(()=>s.start(u,topic.id,selection,id()),/三次/);assert.equal(s.batches(u,topic.id)[0].status,'failed');});

test('native retry reconciles failed Jobs without any opportunity page or tool read',t=>{
 const {s,topic,db}=fixture(t),r=new RecurringStore(db),task=s.configureTask(u,topic.id,selection);
 const active=r.update(u,task.id,task.revision,{...task,schedule:{...task.schedule,kind:'interval',intervalMinutes:1}},'active',day)!;
 const first=r.fire(u,task.id,Date.parse(active.nextRunAt!))!;
 db.deletePendingPromptsForConversation(first);
 const job=db.createJob(id(),first,undefined,selection);db.sqlite.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(job.id);
 const second=r.fire(u,task.id,Date.parse(active.nextRunAt!)+60000)!;
 assert.ok(second);assert.notEqual(second,first);
 const batch=db.sqlite.prepare('SELECT attempts,status,conversation_id FROM opportunity_batches WHERE topic_id=?').get(topic.id);
 assert.equal(batch?.attempts,2);assert.equal(batch?.status,'generating');assert.equal(batch?.conversation_id,second);
});


test('evidence correction preserves a published identity, replaces wrong sources, versions old facts and is retry safe',t=>{
 const {s,c,topic,db,p}=fixture(t),b=s.begin(u,topic.id,c.id,null,day),i=s.ingest(u,b.id,c.id,[{key:'evidence',content:{...content(1),maturity:'原有成熟条件必须保留'}}])[0].idea;
 reviewAll(s,topic.id,b.id,c.id);publish(s,topic.id,b.id,c.id,[i.id]);
 const before=s.idea(u,i.id),editing=db.createConversation(id(),'Correct evidence',selection,u,p.id),j=db.createJob(id(),editing.id,undefined,selection);db.sqlite.prepare("UPDATE jobs SET status='running' WHERE id=?").run(j.id);
 const correction={requestKey:id(),revision:before.revision,reason:'移除不相关来源，并准确区分事实与假设',patch:{facts:'重新核实后的事实，不代表儿童试玩',sources:[{title:'New source',url:'https://example.org/evidence',date:'2026-10-14',finding:'这个来源直接支持已记录的事实'}]}};
 const result=s.correctEvidence(u,i.id,editing.id,j.id,correction).idea;
 for(const k of ['id','fingerprint','first_created_at','first_recommended_at','recommended_batch_id','state','rating','note','manual_processed','score','quality'] as const)assert.equal(result[k],before[k]);
 assert.equal(result.content.maturity,before.content.maturity);assert.equal(result.content.validation,before.content.validation);assert.equal(result.content.sources.length,1);assert.equal(result.content.sources[0].url,'https://example.org/evidence');assert.equal(s.history(u).total,1);assert.equal(s.batches(u,topic.id).length,1);
 const d=s.detail(u,i.id);assert.deepEqual(JSON.parse(d.versions[0].content_json),before.content);assert.equal(d.versions[0].conversation_id,editing.id);assert.equal(d.versions[0].project_id,p.id);assert.ok(d.availableConversations.includes(editing.id));assert.equal(d.feedback.length,0);
 assert.equal(s.correctEvidence(u,i.id,editing.id,j.id,correction).idea.revision,result.revision);assert.equal(s.detail(u,i.id).versions.length,1);
 assert.throws(()=>s.correctEvidence(u,i.id,editing.id,j.id,{...correction,reason:'same key changed'}),/请求内容已变化/);
 assert.throws(()=>s.correctEvidence(u,i.id,editing.id,j.id,{...correction,requestKey:id()}),/卡片已变化/);
 assert.throws(()=>s.correctEvidence(u,i.id,editing.id,j.id,{...correction,requestKey:id(),revision:result.revision,patch:{mechanism:'different idea'}}));
 assert.throws(()=>s.correctEvidence(u,i.id,editing.id,j.id,{...correction,requestKey:id(),revision:result.revision,patch:{}}));
 assert.throws(()=>s.correctEvidence(id(),i.id,editing.id,j.id,correction),/不存在/);
 const p2=db.createProject(id(),u,'Other server',path.join(p.root_path,'other'),'tenant-local'),c2=db.createConversation(id(),'Other project',selection,u,p2.id),j2=db.createJob(id(),c2.id,undefined,selection);db.sqlite.prepare("UPDATE jobs SET status='running' WHERE id=?").run(j2.id);assert.throws(()=>s.correctEvidence(u,i.id,c2.id,j2.id,correction),/关联的服务器项目/);
 db.sqlite.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(j.id);assert.throws(()=>s.correctEvidence(u,i.id,editing.id,j.id,correction),/任务已结束/);
 db.sqlite.prepare('DELETE FROM conversations WHERE id=?').run(editing.id);const gc=s.detail(u,i.id);assert.equal(gc.versions.length,1);assert.equal(gc.versions[0].project_id,null);assert.ok(!gc.availableConversations.includes(editing.id));assert.deepEqual(db.sqlite.prepare('pragma foreign_key_check').all(),[]);
});

test('corrected reserve evidence invalidates prior ranking without deleting review history or adding user feedback',t=>{
 const {s,c,topic,db}=fixture(t),b=s.begin(u,topic.id,c.id,null,day),i=s.ingest(u,b.id,c.id,[{key:'evidence',content:content(2)}])[0].idea;reviewAll(s,topic.id,b.id,c.id);
 const oldRevision=s.feedbackRevision(u,topic.id),j=db.createJob(id(),c.id,undefined,selection);db.sqlite.prepare("UPDATE jobs SET status='running' WHERE id=?").run(j.id);
 s.correctEvidence(u,i.id,c.id,j.id,{requestKey:id(),revision:s.idea(u,i.id).revision,reason:'资料给出的条件有限，需重审',patch:{assumptions:'仅说明技术可行，目标用户是否理解尚待验证'}});
 assert.notEqual(s.feedbackRevision(u,topic.id),oldRevision);assert.equal(s.sql.prepare('SELECT count(*) n FROM opportunity_reviews').get()?.n,1);assert.equal(s.detail(u,i.id).feedback.length,0);
 assert.throws(()=>publish(s,topic.id,b.id,c.id,[i.id]),/最新反馈/);reviewAll(s,topic.id,b.id,c.id);publish(s,topic.id,b.id,c.id,[i.id]);assert.equal(s.idea(u,i.id).state,'recommended');
});

test('topic relative ordering persists, appends new topics and isolates owners and archived entries', t => {
 const {s,db,p,topic}=fixture(t);
 const b=s.createTopic(u,{name:'B',project_id:p.id,goal:'B'},id()),c=s.createTopic(u,{name:'C',project_id:p.id,goal:'C'},id());
 const order=()=>s.topics(u).map(v=>v.id);
 assert.deepEqual(s.reorderTopics(u,{sourceId:c.id,targetId:topic.id,placement:'before'}).map(v=>v.id),[c.id,topic.id,b.id]);
 s.reorderTopics(u,{sourceId:c.id,targetId:b.id,placement:'after'});
 assert.deepEqual(order(),[topic.id,b.id,c.id]);
 assert.deepEqual(new OpportunityStore(db).topics(u).map(v=>v.id),order());
 const d=s.createTopic(u,{name:'D',project_id:p.id,goal:'D'},id());assert.equal(order().at(-1),d.id);
 s.lifecycle(u,b.id,b.revision,'archive');
 assert.throws(()=>s.reorderTopics(u,{sourceId:b.id,targetId:c.id,placement:'before'}),/恢复主题/);
 assert.throws(()=>s.reorderTopics(id(),{sourceId:c.id,targetId:topic.id,placement:'before'}),/不存在/);
 assert.throws(()=>s.reorderTopics(u,{sourceId:c.id,targetId:id(),placement:'before'}),/不存在/);
 assert.throws(()=>s.reorderTopics(u,{sourceId:c.id,targetId:topic.id,placement:'invalid'}));
 assert.deepEqual(order(),[topic.id,b.id,c.id,d.id]);
 const renamed=s.renameTopic(u,topic.id,{name:' New name ',revision:topic.revision});
 assert.equal(renamed.name,'New name');assert.equal(renamed.goal,topic.goal);assert.equal(renamed.revision,topic.revision+1);
 assert.throws(()=>s.renameTopic(u,topic.id,{name:'stale',revision:topic.revision}),/其他页面更新/);
 assert.throws(()=>s.renameTopic(id(),topic.id,{name:'foreign',revision:renamed.revision}),/不存在/);
 assert.throws(()=>s.renameTopic(u,topic.id,{name:' ',revision:renamed.revision}));
 assert.equal(s.topic(u,topic.id).name,'New name');
});

test('inbox, working, processed and dismissed views separate feedback and keep research links', t => {
 const {s,db,c,topic,p}=fixture(t);
 s.updateTopic(u,topic.id,{...topic,read_recent:false,limit_count:10,revision:topic.revision});
 const b=s.begin(u,topic.id,c.id,null),created=s.ingest(u,b.id,c.id,Array.from({length:10},(_,n)=>({key:'flow-'+n,content:content(200+n)}))).map(v=>v.idea);
 reviewAll(s,topic.id,b.id,c.id);
 s.review(u,b.id,c.id,[{idea_id:created[9].id,verdict:'reject',score:10,quality:10,rationale:'未达到质量门槛',compared:s.neighbors(u,created[9].content,created[9].id).map(n=>({id:n.id,difference:'不同的验证问题'}))}]);
 publish(s,topic.id,b.id,c.id,created.slice(0,8).map(v=>v.id));
 const feedback=(n:number,action:string)=>{const idea=s.idea(u,created[n].id);return s.feedback(u,idea.id,{requestKey:id(),revision:idea.revision,action,rating:3,note:'test feedback'});};
 feedback(1,'dismissed');feedback(2,'kept');feedback(3,'later');feedback(4,'rate');feedback(8,'expired');
 const requestKey=id(),beforeResearch=s.idea(u,created[5].id),research=s.start(u,topic.id,selection,requestKey,created[5].id);
 const afterResearch=s.idea(u,created[5].id);assert.equal(afterResearch.manual_processed,1);assert.equal(afterResearch.revision,beforeResearch.revision+1);
 assert.equal(s.start(u,topic.id,selection,requestKey,created[5].id).conversationId,research.conversationId);assert.equal(s.idea(u,created[5].id).revision,afterResearch.revision);
 const board=new ParaStore(db).createBoard(u,'工作总览测试',null),project=s.toProject(u,created[6].id,board.id,id());
 const inbox=s.view(u,topic.id);assert.deepEqual(new Set(inbox.ideas.map(i=>i.id)),new Set([created[0].id,created[7].id]));
 assert.deepEqual({...inbox.counts},{screen:2,reserve:0,kept:1,completed:0,working:3,processed:2,dismissed:2,rejected:1});
 s.sql.prepare('UPDATE opportunity_ideas SET manual_processed=0 WHERE id=?').run(created[5].id); // Existing research predates the new handling marker.
 assert.equal(s.view(u,topic.id,'today').total,2);assert.equal(s.view(u,topic.id,'unknown').total,2);
 assert.equal(s.topics(u).find(t=>t.id===topic.id)?.pending_count,2); // Also excludes legacy research without manual_processed.
 assert.deepEqual(new Set(s.view(u,topic.id,'processed').ideas.map(i=>i.id)),new Set([created[3].id,created[4].id]));
 assert.deepEqual(new Set(s.view(u,topic.id,'dismissed').ideas.map(i=>i.id)),new Set([created[1].id,created[8].id]));
 const work=s.view(u,undefined,'working');assert.equal(work.total,3);
 assert.equal(work.ideas.find(i=>i.id===created[5].id)?.work?.research?.conversation_id,research.conversationId);
 assert.equal(work.ideas.find(i=>i.id===created[6].id)?.work?.project?.id,project.id);
 assert.equal(work.ideas.find(i=>i.id===created[6].id)?.topic_name,topic.name);
 db.sqlite.prepare('DELETE FROM conversations WHERE id=?').run(research.conversationId);
 assert.equal(s.view(u,topic.id,'working').ideas.find(i=>i.id===created[5].id)?.work?.research?.available,false);
 feedback(1,'undo');assert.equal(s.topics(u).find(t=>t.id===topic.id)?.pending_count,3);assert.equal(s.view(u,topic.id).total,3);assert.equal(s.view(u,topic.id,'dismissed').total,1);
 feedback(2,'dismissed');assert.equal(s.view(u,topic.id,'working').total,2);assert.equal(s.view(u,topic.id,'dismissed').total,2);
 const outsider=id();assert.deepEqual(s.topics(outsider),[]);assert.equal(s.view(outsider,undefined).total,0);assert.equal(Object.values(s.view(outsider,undefined).counts).reduce((a,b)=>a+b,0),0);assert.throws(()=>s.view(outsider,topic.id),/不存在/);
 const second=s.createTopic(u,{name:'another',project_id:p.id,goal:'other'},id());assert.equal(s.view(u,second.id,'working').total,0);assert.equal(s.topics(u).find(t=>t.id===second.id)?.pending_count,0);assert.equal(s.topics(u).find(t=>t.id===topic.id)?.pending_count,3);
 assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('kept cards complete and reopen durably without losing feedback, research or linked projects', t => {
 const {s,db,root,c,topic}=fixture(t),batch=s.begin(u,topic.id,c.id,null);
 const cards=s.ingest(u,batch.id,c.id,Array.from({length:3},(_,n)=>({key:'complete-'+n,content:content(800+n)}))).map(v=>v.idea);
 const change=(iid:string,action:string)=>{const old=s.idea(u,iid);return s.feedback(u,iid,{requestKey:id(),revision:old.revision,action,rating:4,note:'继续制作的原始备注'});};
 assert.throws(()=>change(cards[0].id,'completed'),/请先保留/);
 change(cards[0].id,'kept');
 const research=s.start(u,topic.id,selection,id(),cards[0].id);
 const board=new ParaStore(db).createBoard(u,'完成验收',null),project=s.toProject(u,cards[0].id,board.id,id());
 change(cards[0].id,'kept');
 const old=s.idea(u,cards[0].id),input={requestKey:id(),revision:old.revision,action:'completed',rating:old.rating,note:old.note};
 const done=s.feedback(u,old.id,input);
 assert.equal(done.state,'completed');assert.equal(done.para_project_id,project.id);
 assert.deepEqual(s.feedback(u,old.id,input),done); // Retrying the same click is idempotent.
 assert.throws(()=>s.feedback(u,old.id,{...input,requestKey:id()}),/已更新/);
 assert.throws(()=>s.feedback(id(),old.id,{...input,requestKey:id()}),/不存在/);
 for(const tab of ['screen','reserve','kept','working','processed','dismissed','rejected'])assert.equal(s.view(u,topic.id,tab).ideas.some(i=>i.id===old.id),false,tab);
 const completed=s.view(u,topic.id,'completed');assert.equal(completed.total,1);assert.equal(completed.counts.completed,1);
 assert.equal(completed.ideas[0].work?.research?.conversation_id,research.conversationId);
 assert.equal(completed.ideas[0].work?.research?.status,'interested');assert.equal(completed.ideas[0].work?.project?.stage,'idea');
 assert.equal(completed.ideas[0].content.title,old.content.title);assert.equal(completed.ideas[0].note,old.note);
 assert.equal(s.history(u).total,3);assert.ok(!s.context(u,topic.id).inventory.some(i=>i.id===old.id));
 assert.throws(()=>s.start(u,topic.id,selection,id(),old.id),/恢复为保留/);
 change(cards[1].id,'kept');change(cards[1].id,'completed');
 assert.throws(()=>s.toProject(u,cards[1].id,board.id,id()),/恢复为保留/);
 change(cards[1].id,'rate');assert.equal(s.idea(u,cards[1].id).state,'completed');
 const reopened=new AppDatabase(root,undefined,false);
 try{assert.equal(new OpportunityStore(reopened).view(u,undefined,'completed').total,2);}finally{reopened.close();}
 change(old.id,'undo');assert.equal(s.idea(u,old.id).state,'kept');assert.equal(s.view(u,topic.id,'completed').total,1);
 change(old.id,'completed');change(old.id,'kept');assert.equal(s.view(u,topic.id,'kept').total,1);
 assert.equal(s.view(u,topic.id,'kept').ideas[0].work?.project?.id,project.id);
 change(old.id,'dismissed');assert.throws(()=>change(old.id,'completed'),/请先保留/);
 assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('kept and completed lists paginate across topics and enforce ownership and topic lifecycle',t=>{
 const {s,c,p,topic}=fixture(t),other=s.createTopic(u,{name:'第二个工作主题',project_id:p.id,goal:'完成归档'},id());
 const first=s.begin(u,topic.id,c.id,null),second=s.begin(u,other.id,c.id,null);
 const seed=(batch:string,start:number,count:number)=>s.ingest(u,batch,c.id,Array.from({length:count},(_,n)=>({key:'pagination-'+(start+n),content:content(900+start+n)}))).map(r=>r.idea.id);
 const ids=[...seed(first.id,0,25),...seed(second.id,25,18)];
 const update=s.sql.prepare("UPDATE opportunity_ideas SET state=?,manual_processed=1 WHERE id=?");
 for(const state of ['kept','completed']){
  for(const iid of ids)update.run(state,iid);
  const a=s.view(u,undefined,state),b=s.view(u,undefined,state,40);
  assert.equal(a.total,43);assert.equal(a.ideas.length,40);assert.equal(b.ideas.length,3);assert.equal(b.nextOffset,null);
  assert.equal(new Set([...a.ideas,...b.ideas].map(i=>i.id)).size,43);
  assert.equal(s.view(u,topic.id,state).total,25);assert.equal(s.view(u,other.id,state).total,18);
  assert.equal(s.view(id(),undefined,state).total,0);assert.throws(()=>s.view(id(),topic.id,state),/不存在/);
 }
 s.lifecycle(u,other.id,other.revision,'archive');assert.equal(s.view(u,undefined,'completed').total,43);
 s.lifecycle(u,other.id,s.topic(u,other.id).revision,'delete');assert.equal(s.view(u,undefined,'completed').total,25);
});

test('candidate pagination includes older unanswered cards and totals match filtering', t => {
 const {s,c,topic}=fixture(t),b=s.begin(u,topic.id,c.id,null);
 const inputs=Array.from({length:43},(_,n)=>({key:'page-'+n,content:content(300+n)}));
 const ideas=[...s.ingest(u,b.id,c.id,inputs.slice(0,30)),...s.ingest(u,b.id,c.id,inputs.slice(30))].map(v=>v.idea);
 const mark=s.sql.prepare("UPDATE opportunity_ideas SET state='recommended',first_recommended_at='2026-10-01T00:00:00.000Z' WHERE id=?");ideas.forEach(i=>mark.run(i.id));
 const first=s.view(u,topic.id),second=s.view(u,topic.id,'screen',first.nextOffset!);
 assert.equal(s.topics(u).find(t=>t.id===topic.id)?.pending_count,43);assert.equal(first.total,43);assert.equal(first.counts.screen,43);assert.equal(first.ideas.length,40);assert.equal(second.ideas.length,3);assert.equal(second.nextOffset,null);assert.equal(new Set([...first.ideas,...second.ideas].map(i=>i.id)).size,43);
 const i=first.ideas[0];s.feedback(u,i.id,{requestKey:id(),revision:i.revision,action:'rate',rating:4});
 assert.equal(s.topics(u).find(t=>t.id===topic.id)?.pending_count,42);assert.equal(s.view(u,topic.id).total,42);assert.equal(s.view(u,topic.id,'processed').total,1);
});

test('feedback learning drains all old feedback in order, persists principles atomically and gates discovery', t => {
 const {s,c,topic,root}=fixture(t),b=s.begin(u,topic.id,c.id,null,day),ideas=s.ingest(u,b.id,c.id,[{key:'learning',content:content(800)},{key:'reserve',content:content(801)}]);
 const iid=ideas[0].idea.id;
 for(let n=0;n<35;n++)s.feedback(u,iid,{requestKey:id(),revision:s.idea(u,iid).revision,action:'rate',rating:4,note:'优先两分钟可以验证的交互 '+n});
 s.sql.prepare("UPDATE opportunity_feedback SET created_at='2026-09-01T00:00:00Z' WHERE idea_id=?").run(iid);
 const page=s.feedbackInbox(u,topic.id);assert.equal(page.pending,35);assert.equal(page.items.length,30);assert.equal(topic.read_recent,0);
 assert.throws(()=>s.ingest(u,b.id,c.id,[{key:'blocked',content:content(802)}]),/未归纳/);
 assert.throws(()=>reviewAll(s,topic.id,b.id,c.id),/未归纳/);assert.throws(()=>publish(s,topic.id,b.id,c.id,[]),/未归纳/);
 const input={requestKey:id(),after:page.watermark,through:page.through,feedbackRevision:page.feedbackRevision,summary:'明确要求低成本验证，形成可复用原则。',principles:[{text:'优先两分钟可验证的交互',kind:'explicit',source:page.items[0].id}]};
 assert.throws(()=>s.learnFeedback(u,topic.id,c.id,{...input,through:page.through+1}),/不能跳过/);
 assert.throws(()=>s.learnFeedback(u,topic.id,c.id,{...input,principles:[...input.principles,{text:'无来源',kind:'inferred',source:id()}]}),/真实反馈/);
 assert.equal(s.preferences(u,topic.id).length,0);assert.equal(s.feedbackLearning(u,topic.id).watermark,0);
 const learned=s.learnFeedback(u,topic.id,c.id,input);assert.equal(learned.learning.pending,5);assert.equal(learned.learning.learned,30);
 assert.deepEqual(s.learnFeedback(u,topic.id,c.id,input),JSON.parse(JSON.stringify(learned)));assert.equal(s.preferences(u,topic.id).length,1);
 const reopened=new AppDatabase(root,undefined,false);try{const persisted=new OpportunityStore(reopened);assert.equal(persisted.feedbackInbox(u,topic.id).pending,5);assert.equal(persisted.preferences(u,topic.id)[0].text,input.principles[0].text);}finally{reopened.close();}
 const stale=s.feedbackInbox(u,topic.id);s.feedback(u,iid,{requestKey:id(),revision:s.idea(u,iid).revision,action:'undo'});
 assert.throws(()=>s.learnFeedback(u,topic.id,c.id,{...input,requestKey:id(),after:stale.watermark,through:stale.through,feedbackRevision:stale.feedbackRevision}),/进度已变化|知识库已更新/);
 const remaining=s.feedbackInbox(u,topic.id);assert.equal(remaining.pending,6);assert.equal(remaining.items.length,6);
 const pref=s.preferences(u,topic.id)[0];s.learnFeedback(u,topic.id,c.id,{requestKey:id(),after:remaining.watermark,through:remaining.through,feedbackRevision:remaining.feedbackRevision,summary:'撤销后重新检查证据，停用原原则待确认。',principles:[{...pref,source:remaining.items.at(-1)!.id,active:false}]});
 assert.equal(s.preferences(u,topic.id).length,0);assert.equal(s.feedbackLearning(u,topic.id).pending,0);assert.equal(s.feedbackLearning(u,topic.id).learned,36);
 reviewAll(s,topic.id,b.id,c.id);publish(s,topic.id,b.id,c.id,[ideas[1].idea.id]);
 assert.equal(s.sql.prepare('SELECT count(*) n FROM opportunity_feedback_learning').get()?.n,2);
 assert.throws(()=>s.feedbackInbox(id(),topic.id),/不存在/);assert.deepEqual(s.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('project knowledge is the single principle source and learning records written files without duplicating page preferences', t => {
 const {s,c,topic,root}=fixture(t),b=s.begin(u,topic.id,c.id,null,day),idea=s.ingest(u,b.id,c.id,[{key:'knowledge',content:content(900)}])[0].idea;
 s.setPreference(u,topic.id,{text:'迁移前偏好',kind:'explicit',source:'用户设置'});
 assert.throws(()=>s.updateTopic(u,topic.id,{...topic,read_recent:false,knowledge_path:'../another/README.md'}),/相对/);
 const entry='knowledge/opportunities/topic/README.md',linked=s.updateTopic(u,topic.id,{...topic,read_recent:false,knowledge_path:entry});
 const withoutPath={...linked,read_recent:false};delete (withoutPath as Partial<typeof linked>).knowledge_path;
 assert.equal(s.updateTopic(u,topic.id,withoutPath).knowledge_path,entry);
 assert.deepEqual(s.context(u,topic.id).preferences,[]);assert.equal(s.context(u,topic.id).knowledge.entry,entry);
 assert.equal(s.preferences(u,topic.id,true).length,1); // Keep legacy provenance, never inject it as current rules.
 assert.throws(()=>s.setPreference(u,topic.id,{text:'另一份偏好',kind:'explicit',source:'用户设置'}),/项目知识库/);
 const task=s.configureTask(u,topic.id,selection);assert.match(task.prompt,/knowledge\/opportunities\/topic\/README.md/);assert.ok(task.prompt.length<500);
 s.feedback(u,idea.id,{requestKey:id(),revision:idea.revision,action:'rate',rating:5,note:'优先可以观察验证的原型'});
 const page=s.feedbackInbox(u,topic.id),input={requestKey:id(),after:page.watermark,through:page.through,feedbackRevision:page.feedbackRevision,summary:'凝练验证原则并保存知识文件'};
 assert.equal(page.knowledgePath,entry);assert.deepEqual(page.preferences,[]);
 assert.throws(()=>s.learnFeedback(u,topic.id,c.id,input),/knowledgeFiles/);
 assert.throws(()=>s.learnFeedback(u,topic.id,c.id,{...input,knowledgeFiles:['another/README.md']}),/knowledgeFiles/);
 assert.equal(s.feedbackLearning(u,topic.id).pending,1);
 const file='knowledge/opportunities/topic/principles.md';fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),'优先可以观察验证的原型\n来源反馈：'+page.items[0].id);
 const result=s.learnFeedback(u,topic.id,c.id,{...input,knowledgeFiles:[file]});assert.equal(result.learning.pending,0);assert.deepEqual(result.preferences,[]);
 assert.deepEqual(JSON.parse(String(s.sql.prepare('SELECT knowledge_files_json FROM opportunity_feedback_learning').get()?.knowledge_files_json)),[file]);
 assert.equal(s.preferences(u,topic.id,true).length,1);assert.match(fs.readFileSync(path.join(root,file),'utf8'),/可观察|观察验证/);
});

 test('explanatory images gate publication; validate bytes, paths, ownership, revisions and deleted sources',async t=>{
 const {s,c,topic,db,root,p}=fixture(t),tenantRoot=path.join(root,'tenants'),media=new OpportunityImages(db,tenantRoot),b=s.begin(u,topic.id,c.id,null,day);
 const idea=s.ingest(u,b.id,c.id,[{key:'visual',content:content(999)}])[0].idea;reviewAll(s,topic.id,b.id,c.id);
 assert.throws(()=>s.publish(u,b.id,c.id,{ids:[idea.id],summary:'配图检查',feedbackRevision:s.feedbackRevision(u,topic.id)}),/说明图片/);
 const dir=path.join(tenantRoot,u,'conversations',c.id,'outputs');fs.mkdirSync(dir,{recursive:true});
 const bytes=await sharp({create:{width:80,height:60,channels:3,background:'#aabbcc'}}).webp().toBuffer();fs.writeFileSync(path.join(dir,'concept.webp'),bytes);
 const body=()=>({ideaId:idea.id,requestKey:id(),revision:s.idea(u,idea.id).revision,images:[{path:'outputs/concept.webp',alt:'一眼看懂核心流程',caption:'图示仅为方案示例'}]});
 for(const name of ['../secret','outputs/../secret','/etc/passwd','outputs//x','outputs/x\\y']) await assert.rejects(()=>media.attach(u,c.id,undefined,{...body(),images:[{path:name,alt:'越界'}]}));
 fs.symlinkSync(path.join(dir,'concept.webp'),path.join(dir,'link.webp'));await assert.rejects(()=>media.attach(u,c.id,undefined,{...body(),images:[{path:'outputs/link.webp',alt:'链接'}]}));
 fs.symlinkSync(dir,path.join(dir,'linked-dir'));await assert.rejects(()=>media.attach(u,c.id,undefined,{...body(),images:[{path:'outputs/linked-dir/concept.webp',alt:'目录链接'}]}),/符号链接/);
 fs.linkSync(path.join(dir,'concept.webp'),path.join(dir,'hardlink.webp'));await assert.rejects(()=>media.attach(u,c.id,undefined,body()),/普通图片/);fs.unlinkSync(path.join(dir,'hardlink.webp'));
 fs.writeFileSync(path.join(dir,'fake.png'),'not an image');await assert.rejects(()=>media.attach(u,c.id,undefined,{...body(),images:[{path:'outputs/fake.png',alt:'伪造图片'}]}));
 const wrongProject=db.createProject(id(),u,'Other',path.join(root,'other'),'tenant-local'),wrong=db.createConversation(id(),'Wrong',selection,u,wrongProject.id);await assert.rejects(()=>media.attach(u,wrong.id,undefined,body()),/关联的服务器项目/);
 const payload=body(),result=await media.attach(u,c.id,undefined,payload);assert.equal(result.idea.images.length,1);assert.deepEqual(await media.attach(u,c.id,undefined,payload),result);
 await assert.rejects(()=>media.attach(u,c.id,undefined,{...payload,requestKey:id()}),/卡片已变化/);
 const image=s.idea(u,idea.id).images![0];assert.equal(image.state,'local');assert.deepEqual((await media.bytes(u,idea.id,image.id)).bytes,bytes);
 s.publish(u,b.id,c.id,{ids:[idea.id],summary:'已验证配图',feedbackRevision:s.feedbackRevision(u,topic.id)});
 fs.writeFileSync(path.join(dir,'concept.webp'),Buffer.from('changed'));await assert.rejects(()=>media.bytes(u,idea.id,image.id),/已变化/);fs.writeFileSync(path.join(dir,'concept.webp'),bytes);
 db.sqlite.prepare('DELETE FROM conversations WHERE id=?').run(c.id);assert.equal(s.idea(u,idea.id).images![0].state,'unavailable');await assert.rejects(()=>media.bytes(u,idea.id,image.id),/不可用/);
 assert.deepEqual(db.sqlite.prepare('pragma foreign_key_check').all(),[]);
 });

test('queue return preserves provenance and feedback; requires fresh re-review; re-recommendation is not a first recommendation', t=>{
 const {s,c,topic}=fixture(t),b=s.begin(u,topic.id,c.id,null,day);
 const iid=s.ingest(u,b.id,c.id,[{key:'returned',content:content(601)}])[0].idea.id;
 reviewAll(s,topic.id,b.id,c.id);publish(s,topic.id,b.id,c.id,[iid]);
 const before=s.detail(u,iid),learning=s.feedbackLearning(u,topic.id),revision=s.feedbackRevision(u,topic.id);
 const command={requestKey:id(),revision:before.idea.revision,reason:'队列整理；有真实需求及新证据后再提'};
 const returned=s.returnToReserve(u,topic.id,iid,command);
 assert.equal(returned.idea.state,'reserve');
 for(const field of ['id','first_created_at','first_recommended_at','recommended_batch_id','source_batch_id','rating','note','content','images','score','quality','manual_processed'] as const)assert.deepEqual(returned.idea[field],before.idea[field]);
 assert.deepEqual(s.detail(u,iid).feedback,before.feedback);assert.deepEqual(s.feedbackLearning(u,topic.id),learning);assert.equal(s.feedbackRevision(u,topic.id),revision);
 assert.equal(s.queueEvents(u,iid).length,2);assert.equal(s.queueEvents(u,iid)[0].reason,command.reason);
 assert.equal(s.view(u,topic.id,'reserve').counts.reserve,1);assert.equal(s.view(u,topic.id).counts.screen,0);assert.equal(s.context(u,topic.id).inventory[0].id,iid);
 assert.deepEqual(s.returnToReserve(u,topic.id,iid,command),returned);assert.equal(s.queueEvents(u,iid).length,2);
 assert.throws(()=>s.returnToReserve(u,topic.id,iid,{...command,reason:'changed'}),/请求内容/);
 const b2=s.begin(u,topic.id,c.id,null,day+86400000);
 assert.throws(()=>publish(s,topic.id,b2.id,c.id,[iid]),/尚未参与/);
 reviewAll(s,topic.id,b2.id,c.id);const again=publish(s,topic.id,b2.id,c.id,[iid]);
 assert.equal(again.firstRecommendationCount,0);assert.equal(again.returnRecommendationCount,1);assert.equal(again.ideas[0].id,iid);
 assert.equal(again.ideas[0].first_recommended_at,before.idea.first_recommended_at);assert.equal(again.ideas[0].recommended_batch_id,b.id);
 assert.equal(s.queueEvents(u,iid).length,3);assert.equal(s.queueEvents(u,iid)[0].action,'rerecommended');
 assert.equal(publish(s,topic.id,b.id,c.id,[]).ideas[0].id,iid);assert.equal(publish(s,topic.id,b2.id,c.id,[]).returnRecommendationCount,1);
 assert.equal(s.history(u).total,1);
});

test('backlog cap persists across days; full queue completes with zero and no review loop; undo respects capacity', t=>{
 const {s,c,topic}=fixture(t);
 const cap=s.setBacklogLimit(u,topic.id,{requestKey:id(),revision:topic.revision,pendingLimit:3});assert.equal(cap.capacity.remainingSlots,3);
 const b=s.begin(u,topic.id,c.id,null,day),ideas=s.ingest(u,b.id,c.id,Array.from({length:6},(_,n)=>({key:'cap'+n,content:content(610+n)}))).map(v=>v.idea.id);
 reviewAll(s,topic.id,b.id,c.id);publish(s,topic.id,b.id,c.id,ideas.slice(0,3));
 const b2=s.begin(u,topic.id,c.id,null,day+86400000);const full=publish(s,topic.id,b2.id,c.id,ideas.slice(3));
 assert.equal(full.ideas.length,0);assert.equal(full.batch.status,'completed');assert.equal(full.capacity.pendingCount,3);assert.equal(full.capacity.publishLimit,0);
 assert.equal(s.begin(u,topic.id,c.id,null,day+86400000).alreadyCompleted,true);
 const old=s.idea(u,ideas[0]);s.feedback(u,old.id,{requestKey:id(),revision:old.revision,action:'later',rating:5,note:'已有用户备注'});
 learn(s,topic.id,c.id);assert.equal(s.capacity(u,topic.id).remainingSlots,1);
 const b3=s.begin(u,topic.id,c.id,null,day+2*86400000);reviewAll(s,topic.id,b3.id,c.id);const one=publish(s,topic.id,b3.id,c.id,ideas.slice(3));
 assert.equal(one.ideas.length,1);assert.equal(one.capacity.pendingCount,3);
 const later=s.idea(u,old.id);assert.throws(()=>s.feedback(u,old.id,{requestKey:id(),revision:later.revision,action:'undo'}),/已达上限/);
 assert.equal(s.idea(u,old.id).note,'已有用户备注');assert.equal(s.idea(u,old.id).state,'later');
 const spare=s.idea(u,ideas[1]);s.returnToReserve(u,topic.id,spare.id,{requestKey:id(),revision:spare.revision,reason:'队列整理'});
 const restored=s.feedback(u,old.id,{requestKey:id(),revision:later.revision,action:'undo'});assert.equal(restored.state,'recommended');assert.equal(s.capacity(u,topic.id).pendingCount,3);
});

test('queue returns reject stale, foreign, processed and working cards without resurrecting dismissed items', t=>{
 const {s,c,topic,p}=fixture(t);s.updateTopic(u,topic.id,{...topic,read_recent:false,limit_count:10});
 const b=s.begin(u,topic.id,c.id,null,day),ideas=s.ingest(u,b.id,c.id,Array.from({length:7},(_,n)=>({key:'protect'+n,content:content(630+n)}))).map(v=>v.idea.id);
 reviewAll(s,topic.id,b.id,c.id);publish(s,topic.id,b.id,c.id,ideas);
 const other=s.createTopic(u,{name:'Unchanged',project_id:p.id,goal:'Other'},id());assert.equal(other.pending_limit,null);
 const attempt=(iid:string,tid=topic.id,owner=u,revision=s.idea(u,iid).revision)=>s.returnToReserve(owner,tid,iid,{requestKey:id(),revision,reason:'队列整理'});
 assert.throws(()=>attempt(ideas[0],topic.id,u,1),/已更新/);assert.throws(()=>attempt(ideas[0],other.id),/不属于/);assert.throws(()=>attempt(ideas[0],topic.id,id()),/不存在/);
 ['kept','later','dismissed','rate','expired'].forEach((action,n)=>{const i=s.idea(u,ideas[n]);s.feedback(u,i.id,{requestKey:id(),revision:i.revision,action,rating:4,note:'保留原意见'});assert.throws(()=>attempt(i.id),/只能退回/);});
 const kept=s.idea(u,ideas[0]);s.feedback(u,kept.id,{requestKey:id(),revision:kept.revision,action:'completed'});assert.throws(()=>attempt(kept.id),/只能退回/);
 s.start(u,topic.id,selection,id(),ideas[5]);assert.throws(()=>attempt(ideas[5]),/只能退回/);
 assert.equal(s.view(u,topic.id).counts.screen,1);attempt(ideas[6]);
 assert.deepEqual(s.context(u,topic.id).inventory.map(i=>i.id),[ideas[6]]);
 for(const iid of ideas.slice(0,6))assert.notEqual(s.idea(u,iid).state,'reserve');
 assert.equal(s.feedbackLearning(u,topic.id).total,6);
});

test('topic cap settings are revision protected, idempotent, optional and independent from daily targets',t=>{
 const {s,c,p,topic,db}=fixture(t),other=s.createTopic(u,{name:'Untouched',project_id:p.id,goal:'Other'},id());
 const body={requestKey:id(),revision:topic.revision,pendingLimit:3};const applied=s.setBacklogLimit(u,topic.id,body);
 assert.deepEqual(s.setBacklogLimit(u,topic.id,body),applied);assert.throws(()=>s.setBacklogLimit(u,topic.id,{...body,requestKey:id()}),/已更新/);
 assert.throws(()=>s.setBacklogLimit(id(),topic.id,{...body,requestKey:id()}),/不存在/);
 const configured=s.updateTopic(u,topic.id,{...s.topic(u,topic.id),read_recent:false,limit_count:2});assert.equal(configured.limit_count,2);assert.equal(configured.pending_limit,3);
 assert.equal(new OpportunityStore(db).context(u,topic.id).capacity.publishLimit,2);assert.equal(s.topic(u,other.id).pending_limit,null);
 const full=s.setBacklogLimit(u,topic.id,{requestKey:id(),revision:configured.revision,pendingLimit:0});assert.equal(full.capacity.publishLimit,0);
 const b=s.begin(u,topic.id,c.id,null,day);assert.equal(publish(s,topic.id,b.id,c.id,[]).batch.status,'completed');
});

test('concurrent publishers serialize the last free slot across independent database connections', async t=>{
 const {s,c,topic,root}=fixture(t);s.setBacklogLimit(u,topic.id,{requestKey:id(),revision:topic.revision,pendingLimit:1});
 const b1=s.begin(u,topic.id,c.id,null,day),ids=s.ingest(u,b1.id,c.id,[{key:'race-a',content:content(650)},{key:'race-b',content:content(651)}]).map(v=>v.idea.id);
 const b2=s.begin(u,topic.id,c.id,null,day+86400000);reviewAll(s,topic.id,b1.id,c.id);reviewAll(s,topic.id,b2.id,c.id);ids.forEach(i=>seedImage(s,i,c.id));
 const {spawn}=await import('node:child_process');
 const worker=path.join(root,'publish-race.mjs'),dbUrl=new URL('../server/db.ts',import.meta.url).href,storeUrl=new URL('../server/opportunity-store.ts',import.meta.url).href;
 fs.writeFileSync(worker,`import {AppDatabase} from ${JSON.stringify(dbUrl)}; import {OpportunityStore} from ${JSON.stringify(storeUrl)};
 const [root,u,topic,b,c,i]=process.argv.slice(2);const db=new AppDatabase(root),s=new OpportunityStore(db);process.stdout.write('ready\\n');
 process.stdin.once('data',()=>{try{const r=s.publish(u,b,c,{ids:[i],summary:'concurrent test',feedbackRevision:s.feedbackRevision(u,topic)});process.stdout.write(JSON.stringify({count:r.ideas.length,pending:r.capacity.pendingCount})+'\\n');}catch(e){process.stdout.write(JSON.stringify({error:e.message})+'\\n');process.exitCode=1;}finally{db.close();process.stdin.destroy();}});`);
 function launch(bid:string,iid:string){let out='',ready!:()=>void;const started=new Promise<void>(r=>ready=r),child=spawn(process.execPath,['--import','tsx',worker,root,u,topic.id,bid,c.id,iid],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});
 const done=new Promise<{count:number;pending:number}>((resolve,reject)=>{child.stdout.on('data',d=>{out+=d;if(out.includes('ready\n'))ready();});child.on('error',reject);child.on('exit',code=>{try{assert.equal(code,0,out);resolve(JSON.parse(out.trim().split('\n').at(-1)!));}catch(e){reject(e);}});});return {child,started,done};}
 const a=launch(b1.id,ids[0]),b=launch(b2.id,ids[1]);await Promise.all([a.started,b.started]);a.child.stdin.write('go');b.child.stdin.write('go');
 const results=await Promise.all([a.done,b.done]);assert.deepEqual(results.map(r=>r.count).sort(),[0,1]);assert.equal(s.capacity(u,topic.id).pendingCount,1);
 assert.equal(s.batch(u,b1.id).status,'completed');assert.equal(s.batch(u,b2.id).status,'completed');
});

test('additive migration backfills original recommendation events once and preserves existing user data',t=>{
 const {s,c,topic,root,db}=fixture(t),b=s.begin(u,topic.id,c.id,null,day);
 const iid=s.ingest(u,b.id,c.id,[{key:'legacy',content:content(660)}])[0].idea.id;reviewAll(s,topic.id,b.id,c.id);publish(s,topic.id,b.id,c.id,[iid]);
 const first=s.idea(u,iid);s.feedback(u,iid,{requestKey:id(),revision:first.revision,action:'dismissed',rating:2,note:'原始人工意见'});const before=s.idea(u,iid);
 db.sqlite.exec('DROP TABLE opportunity_queue_events; ALTER TABLE opportunity_topics DROP COLUMN pending_limit; ALTER TABLE opportunity_reviews DROP COLUMN queue_revision; DELETE FROM schema_migrations WHERE version=2026102801;');
 const reopened=new AppDatabase(root);try{const upgraded=new OpportunityStore(reopened);assert.deepEqual(upgraded.idea(u,iid),before);assert.equal(upgraded.topic(u,topic.id).pending_limit,null);assert.equal(upgraded.queueEvents(u,iid).length,1);assert.equal(upgraded.queueEvents(u,iid)[0].created_at,before.first_recommended_at);assert.equal(upgraded.queueEvents(u,iid)[0].batch_id,b.id);assert.equal(upgraded.context(u,topic.id).inventory.length,0);assert.deepEqual(reopened.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);}finally{reopened.close();}
 const again=new AppDatabase(root);try{assert.equal(new OpportunityStore(again).queueEvents(u,iid).length,1);}finally{again.close();}
});

test('research selects an owned server project and keeps links, drafts, idempotency and source knowledge correct',t=>{
 const {s,c,topic,db,p,root}=fixture(t),b=s.begin(u,topic.id,c.id,null,day);
 const idea=s.ingest(u,b.id,c.id,[{key:'move-research',content:content(901)}])[0].idea;
 db.sqlite.prepare('UPDATE opportunity_topics SET knowledge_path=? WHERE id=?').run('knowledge/topic.md',topic.id);
 const target=db.createProject(id(),u,'Research target',root+'/research','tenant-local'),key=id();
 const started=s.start(u,topic.id,selection,key,idea.id,{rating:5,note:'unsaved research plan'},target.id);
 assert.equal(started.projectId,target.id);assert.equal(db.getConversation(started.conversationId)?.project_id,target.id);
 assert.equal(db.listPendingPrompts(started.conversationId).length,0);
 assert.ok(db.getComposerDraft(started.conversationId)?.content.includes(path.join(p.root_path,'knowledge/topic.md')));
 assert.ok(db.getComposerDraft(started.conversationId)?.content.includes('unsaved research plan'));
 assert.equal(s.detail(u,idea.id).research[0].project_id,target.id);
 assert.equal(s.view(u,topic.id,'working').ideas[0].work?.research?.project_id,target.id);
 assert.equal(s.idea(u,idea.id).project_id,p.id);assert.equal(s.idea(u,idea.id).note,'');
 assert.equal(s.start(u,topic.id,selection,key,idea.id,undefined,target.id).conversationId,started.conversationId);
 assert.throws(()=>s.start(u,topic.id,selection,key,idea.id,undefined,p.id),/请求内容已变化/);
 s.researchResult(u,idea.id,started.conversationId,{status:'inconclusive',result:'cross project result'});
 assert.equal(s.detail(u,idea.id).research[0].result,'cross project result');
 assert.throws(()=>s.researchResult(u,idea.id,c.id,{status:'validated',result:'unlinked'}),/未关联/);
 db.sqlite.prepare("UPDATE projects SET executor_id='remote:fixture' WHERE id=?").run(target.id);
 assert.throws(()=>s.start(u,topic.id,selection,id(),idea.id,undefined,target.id),/远程/);
 assert.throws(()=>s.researchResult(u,idea.id,started.conversationId,{status:'validated',result:'remote'}),/远程/);
 db.sqlite.prepare("UPDATE projects SET executor_id='tenant-local',archived_at=? WHERE id=?").run(new Date().toISOString(),target.id);
 assert.throws(()=>s.start(u,topic.id,selection,id(),idea.id,undefined,target.id),/归档/);
 assert.throws(()=>s.start(u,topic.id,selection,id(),idea.id,undefined,id()),/不存在/);
 db.sqlite.prepare('DELETE FROM conversations WHERE id=?').run(started.conversationId);
 assert.equal(s.view(u,topic.id,'working').ideas[0].work?.research?.available,false);
 assert.deepEqual(db.sqlite.prepare('pragma foreign_key_check').all(),[]);
});

test('cross-project research API permits only linked reads/results, never discovery or another account/project/card',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'opportunity-research-route-')),secret='cross-project-research-test-secret-32',password='research-test';
 const app=createApp({ basePath: "",projectRoot:root,dataRoot:root+'/data',tenantRoot:root+'/tenants',username:'pp',passwordHash:bcrypt.hashSync(password,4),sessionSecret:secret,queueAutoStart:false,minimumFreeDiskBytes:0});
 t.after(()=>{app.beginShutdown();app.db.close();fs.rmSync(root,{recursive:true,force:true});});
 const a=request.agent(app.app),login=await a.post('/api/auth/login').send({username:'pp',password}).expect(200),csrf=login.body.csrfToken;
 const p=app.db.createProject(id(),u,'Source',root+'/source','tenant-local'),target=app.db.createProject(id(),u,'Target',root+'/target','tenant-local');
 const store=new OpportunityStore(app.db),topic=store.createTopic(u,{name:'Research routing',project_id:p.id,goal:'test explicit project selection'},id());
 const c=app.db.createConversation(id(),'Source',selection,u,p.id),b=store.begin(u,topic.id,c.id,null,day);
 const ideas=store.ingest(u,b.id,c.id,[{key:'first',content:content(910)},{key:'second',content:content(911)}]).map(v=>v.idea);
 const url='/api/opportunities/ideas/'+ideas[0].id+'/research',body={requestKey:id(),projectId:target.id};
 await a.post(url).send(body).expect(403);
 await a.post(url).set('X-CSRF-Token',csrf).send({...body,projectId:'bad'}).expect(400);
 await a.post(url).set('X-CSRF-Token',csrf).send({...body,projectId:id()}).expect(404);
 const now=new Date().toISOString(),other=id();app.db.createUser({id:other,username:'other',display_name:'Other',password_hash:bcrypt.hashSync(password,4),role:'member',status:'active',created_at:now,updated_at:now});
 const foreign=app.db.createProject(id(),other,'Private',root+'/foreign','tenant-local');
 await a.post(url).set('X-CSRF-Token',csrf).send({...body,projectId:foreign.id}).expect(404);
 const result=await a.post(url).set('X-CSRF-Token',csrf).send(body).expect(201),cid=result.body.conversationId;
 assert.equal(result.body.projectId,target.id);
 assert.equal(app.db.sqlite.prepare('SELECT count(*) n FROM jobs WHERE conversation_id=?').get(cid)?.n,0);
 const job=app.db.createJob(id(),cid,undefined,selection);app.db.sqlite.prepare("UPDATE jobs SET status='running' WHERE id=?").run(job.id);
 const token=createJobAutomationToken(secret,job.id,cid,Date.now(),86400000,app.db.workflows.assertJob(job.id).epoch);
 const call=(action:string,data:Record<string,unknown>={})=>request(app.app).post(`/api/automation/jobs/${job.id}/opportunities`).set('Authorization','Bearer '+token).send({action,topicId:topic.id,data});
 await call('topics').expect(200);
 const context=await call('context').expect(200);assert.equal(context.body.linkedIdeaId,ideas[0].id);assert.equal(context.body.sourceProject.id,p.id);
 await call('detail',{ideaId:ideas[0].id}).expect(200);
 await call('detail',{ideaId:ideas[1].id}).expect(403);
 await call('research_result',{ideaId:ideas[0].id,status:'inconclusive',result:'linked-only evidence'}).expect(200);
 await call('research_result',{ideaId:ideas[1].id,status:'validated',result:'wrong card'}).expect(403);
 for(const action of ['begin','ingest','review','publish','feedback','feedback_inbox','learn_feedback','evidence','images','return_to_reserve','backlog_limit','preferences','recent','history','inventory','fail'])await call(action,{ideaId:ideas[0].id}).expect(403);
 const unrelated=app.db.createConversation(id(),'Unlinked',selection,u,target.id),unlinked=app.db.createJob(id(),unrelated.id,undefined,selection);app.db.sqlite.prepare("UPDATE jobs SET status='running' WHERE id=?").run(unlinked.id);
 await request(app.app).post(`/api/automation/jobs/${unlinked.id}/opportunities`).set('Authorization','Bearer '+createJobAutomationToken(secret,unlinked.id,unrelated.id,Date.now(),86400000,app.db.workflows.assertJob(unlinked.id).epoch)).send({action:'context',topicId:topic.id}).expect(403);
 app.db.sqlite.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(job.id);await call('context').expect(401);
});
