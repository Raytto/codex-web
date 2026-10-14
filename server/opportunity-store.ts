import { reserveOpportunityBatch, reconcileOpportunityBatches } from "./opportunity-schema.js";
import crypto from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase, StoredAgentSelection } from './db.js';
import { RecurringStore } from './recurring-store.js';
import { isHostRootUser } from './host-root-user.js';
import { ParaStore, emptyBrief } from './para-store.js';
import { opportunityFingerprint, opportunitySimilarity } from './opportunity-similarity.js';
import { stripPersonalContext } from './personal-context.js';
import type { OpportunityTopic, OpportunityContent, OpportunityIdea, OpportunityBatch, OpportunityPreference, OpportunityFeedback, OpportunityResearch, OpportunityDetail, OpportunityState } from '../src/opportunity-types.js';
const id = () => crypto.randomUUID(), stamp = () => new Date().toISOString();
const text = z.string().trim().max(6000), required = text.min(1), uuid = z.string().uuid();
export const topicInput = z.object({ name: required.max(120), project_id: uuid, goal: required, questions: text.default(''), constraints: text.default(''), limit_count: z.number().int().min(1).max(10).default(3), exploration: z.number().int().min(0).max(40).default(20), read_recent: z.boolean().default(false) });
export const contentInput = z.object({
  title: required.max(180), summary: required.max(1200), audience: required, problem: required, mechanism: required, value: required,
  fit: required, facts: required, assumptions: required, doubt: required, validation: required, difference: required,
  interaction: text.default(''), loop: text.default(''), english: text.default(''), expansion: text.default(''), maturity: text.default(''),
  category: required.max(100), keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(16),
  sources: z.array(z.object({ title: required.max(300), url: z.string().url().max(3000).refine(v=>/^https?:\/\//i.test(v),'资料链接仅支持 HTTP(S)'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), finding: required })).max(20),
});
const reviewInput = z.object({ idea_id: uuid, verdict: z.enum(['approve','reject','duplicate','expired']), score: z.number().min(0).max(100), quality: z.number().min(0).max(100), rationale: required, compared: z.array(z.object({ id: uuid, difference: required })).max(300), duplicate_of: uuid.optional() });
export class OpportunityError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function fail(message: string, status=400): never { throw new OpportunityError(status,message); }
type IdeaRow = Omit<OpportunityIdea,'content'> & { content_json: string };
const ideaView = (r: IdeaRow): OpportunityIdea => { const {content_json,...other}=r; return {...other,content:JSON.parse(content_json)}; };
export function opportunityPrompt(topic: OpportunityTopic) {
  return `发现主题「${topic.name}」的新机会。主题 ID：${topic.id}。\n使用 codex_web_opportunities 工具读取 context（目标、反馈、备用库、历史及操作说明），按主题约束检索可核对的外部信息。在本项目的正常会话内完成采集、生成、独立评审、语义查重及库存排序。先 begin；所有新候选先 ingest 记录历史，再 review；历史备用与当天通过质量门槛的新候选一起复评，挑选最多 ${topic.limit_count} 条首次推荐并 publish。不得重推已推荐/人工处理项，不为凑数编造来源。不足时写明原因。新证据补到旧卡；其余合格候选保留备用，不当作负面偏好。\n先查历史，比较服务对象、问题、核心交互与价值，改名/同义改写不是新机会。评审须检查来源、相关性、可验证性、投入边界、实质新意及组合多样性；对召回的近似项逐一说明差异或合并。生成与评审分两步操作。失败调用 fail 并说明原因，不将抓取失败当空批次成功。每轮最多 60 个新候选，同日最多 3 次尝试；尽量在 20 分钟内完成，不安排额外续跑或独立周期。模型和日程只在本原生周期任务中管理。\n若主题授权 read_recent，使用 recent 增量读取本账号相关新对话，引用消息编号提炼偏好，区分 explicit 与 inferred；只保存相关偏好，推断默认仅限本主题，不复制无关私人内容。个人记忆以当前会话注入内容为背景，服从当前主题和最新明确反馈。\n结束汇报精选、备用数量和不足/失败原因。不要自动开发、购买、交易、发布或联系第三方。`;
}
export class OpportunityStore {
  constructor(readonly db: AppDatabase) {}
  get sql(){return this.db.sqlite;}
  transaction<T>(fn:()=>T):T { this.sql.exec('BEGIN IMMEDIATE');try {const r=fn();this.sql.exec('COMMIT');return r;}catch(e){this.sql.exec('ROLLBACK');throw e;} }
  receipt<T>(user:string,key:string,operation:string,fn:()=>T):T {
    uuid.parse(key);
    return this.transaction(()=>{const r=this.sql.prepare('SELECT * FROM opportunity_requests WHERE user_id=? AND request_key=?').get(user,key) as {operation:string;result_json:string}|undefined;
      if(r){if(r.operation!==operation)fail('请求内容已变化，请重新操作。',409);return JSON.parse(r.result_json) as T;}
      const result=fn();this.sql.prepare('INSERT INTO opportunity_requests VALUES(?,?,?,?)').run(user,key,operation,JSON.stringify(result));return result;});
  }
  serverProject(user:string,projectId:string) {
    const p=this.db.getActiveProjectForUser(projectId,user);
    if(!p)fail('服务器项目不存在或已归档。',404);
    if(p.executor_id!==(isHostRootUser(user)?'local-host':'tenant-local'))fail('机会发现只能关联本账号的服务器项目。远程工程不可执行。',403);
    return p;
  }
  topic(user:string,topicId:string,includeDeleted=false):OpportunityTopic {
    const t=this.sql.prepare(`SELECT * FROM opportunity_topics WHERE id=? AND user_id=? ${includeDeleted?'':'AND deleted_at IS NULL'}`).get(topicId,user) as OpportunityTopic|undefined;
    if(!t)fail('机会主题不存在。',404);
    return {...t,task:t.task_id?new RecurringStore(this.db).get(user,t.task_id)??null:null};
  }
  topics(user:string){return (this.sql.prepare('SELECT id FROM opportunity_topics WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at,id').all(user) as {id:string}[]).map(r=>this.topic(user,r.id));}
  createTopic(user:string,raw:unknown,key:string) {
    const b=topicInput.parse(raw);this.serverProject(user,b.project_id);
    return this.receipt(user,key,'create-topic:'+JSON.stringify(b),()=>{const tid=id(),time=stamp();this.sql.prepare('INSERT INTO opportunity_topics(id,user_id,project_id,name,goal,questions,constraints,limit_count,exploration,read_recent,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(tid,user,b.project_id,b.name,b.goal,b.questions,b.constraints,b.limit_count,b.exploration,+b.read_recent,time,time);return this.topic(user,tid);});
  }
  updateTopic(user:string,topicId:string,raw:unknown) {
    const b=topicInput.extend({revision:z.number().int().positive()}).parse(raw),old=this.topic(user,topicId);this.serverProject(user,b.project_id);
    if(old.project_id!==b.project_id && (old.task_id || this.sql.prepare('SELECT 1 FROM opportunity_batches WHERE topic_id=? LIMIT 1').get(topicId)))fail('已有计划或执行记录的主题不能更换项目。请新建主题。',409);
    const r=this.sql.prepare('UPDATE opportunity_topics SET name=?,goal=?,questions=?,constraints=?,limit_count=?,exploration=?,read_recent=?,project_id=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=?').run(b.name,b.goal,b.questions,b.constraints,b.limit_count,b.exploration,+b.read_recent,b.project_id,stamp(),topicId,user,b.revision);
    if(!r.changes)fail('主题已在其他页面更新，请重新加载。',409);return this.topic(user,topicId);
  }
  lifecycle(user:string,topicId:string,revision:number,action:'archive'|'restore'|'delete') {
    return this.transaction(()=>{const t=this.topic(user,topicId);if(t.revision!==revision)fail('主题已变化，请重新加载。',409);
      const recurring=new RecurringStore(this.db),task=t.task;
      if(task && action!=='restore'){if(action==='delete')recurring.remove(user,task.id,task.revision);else recurring.update(user,task.id,task.revision,task,'paused');}
      else if(t.task_id && action!=='restore')this.sql.prepare("UPDATE recurring_tasks SET state='paused',next_run_at=NULL,deleted_at=CASE WHEN ?='delete' THEN ? ELSE deleted_at END,revision=revision+1 WHERE id=? AND user_id=? AND deleted_at IS NULL").run(action,stamp(),t.task_id,user);
      this.sql.prepare('UPDATE opportunity_topics SET archived_at=?,deleted_at=?,revision=revision+1,updated_at=? WHERE id=?').run(action==='restore'?null:stamp(),action==='delete'?stamp():null,stamp(),topicId);
      return {ok:true};});
  }
  configureTask(user:string,topicId:string,selection:StoredAgentSelection,existingId?:string) {
    return this.transaction(()=>{const t=this.topic(user,topicId);this.serverProject(user,t.project_id);if(t.archived_at)fail('请先恢复主题。',409);
      if(t.task)return t.task;
      const recurring=new RecurringStore(this.db);
      if(existingId){const task=recurring.get(user,existingId);if(!task||task.project_id!==t.project_id)fail('请选择同一服务器项目中的周期任务。');if(this.sql.prepare('SELECT 1 FROM opportunity_topics WHERE task_id=?').get(existingId))fail('这个周期任务已关联其他主题。',409);this.sql.prepare('UPDATE opportunity_topics SET task_id=?,revision=revision+1,updated_at=? WHERE id=?').run(existingId,stamp(),topicId);return task;}
      let task=recurring.create(user,t.project_id,{name:t.name+' · 自动发现',prompt:opportunityPrompt(t),...selection,maxRuns:null,schedule:{kind:'daily',timeZone:'Asia/Shanghai',time:'09:00',intervalMinutes:60,weekdays:[1,2,3,4,5],monthDay:1}});
      task=recurring.update(user,task.id,task.revision,task,'paused')!;
      this.sql.prepare('UPDATE opportunity_topics SET task_id=?,revision=revision+1,updated_at=? WHERE id=?').run(task.id,stamp(),topicId);return task;});
  }
  idea(user:string,ideaId:string):OpportunityIdea {
    const r=this.sql.prepare('SELECT * FROM opportunity_ideas WHERE id=? AND user_id=?').get(ideaId,user) as IdeaRow|undefined;if(!r)fail('机会卡片不存在。',404);return ideaView(r);
  }
  history(user:string,offset=0,limit=100){
    const total=Number((this.sql.prepare('SELECT count(*) n FROM opportunity_ideas WHERE user_id=?').get(user) as {n:number}).n);
    const rows=this.sql.prepare('SELECT * FROM opportunity_ideas WHERE user_id=? ORDER BY first_created_at,id LIMIT ? OFFSET ?').all(user,Math.min(200,Math.max(1,limit)),Math.max(0,offset)) as IdeaRow[];
    return {total,items:rows.map(r=>{const v=ideaView(r);return {id:v.id,topic_id:v.topic_id,title:v.content.title,audience:v.content.audience,problem:v.content.problem,mechanism:v.content.mechanism,value:v.content.value,state:v.state,first_recommended_at:v.first_recommended_at};}),nextOffset:offset+rows.length<total?offset+rows.length:null};
  }
  neighbors(user:string,content:OpportunityContent,exclude='') {
    return (this.sql.prepare("SELECT * FROM opportunity_ideas WHERE user_id=? AND id<>? AND state<>'duplicate'").all(user,exclude) as IdeaRow[]).map(r=>{const v=ideaView(r);return {id:v.id,topic_id:v.topic_id,title:v.content.title,mechanism:v.content.mechanism,problem:v.content.problem,state:v.state,similarity:opportunitySimilarity(content,v.content)};}).filter(v=>v.similarity>=.22).sort((a,b)=>b.similarity-a.similarity).slice(0,30);
  }
  feedbackRevision(user:string,topicId:string){
    const feedback=Number((this.sql.prepare('SELECT COALESCE(MAX(f.rowid),0) n FROM opportunity_feedback f JOIN opportunity_ideas i ON i.id=f.idea_id WHERE i.user_id=? AND i.topic_id=?').get(user,topicId) as {n:number}).n);
    const topic=this.topic(user,topicId),preferences=this.preferences(user,topicId,true);
    // Covers edited/revoked preferences and goal changes as well as raw feedback.
    const evidence=Number((this.sql.prepare('SELECT COALESCE(MAX(v.rowid),0) n FROM opportunity_versions v JOIN opportunity_ideas i ON i.id=v.idea_id WHERE i.user_id=? AND i.topic_id=?').get(user,topicId) as {n:number}).n);
    const digest=crypto.createHash('sha256').update(JSON.stringify([feedback,topic.revision,preferences,evidence])).digest('hex');
    return Number.parseInt(digest.slice(0,12),16);
  }
  preferences(user:string,topicId:string,all=false){const t=this.topic(user,topicId);return this.sql.prepare(`SELECT p.* FROM opportunity_preferences p JOIN opportunity_topics t ON t.id=p.topic_id WHERE p.user_id=? AND (p.topic_id=? OR p.scope='account' OR (p.scope='project' AND t.project_id=?)) ${all?'':'AND p.active=1'} ORDER BY p.created_at`).all(user,topicId,t.project_id) as OpportunityPreference[];}
  context(user:string,topicId:string) {
    const t=this.topic(user,topicId);this.reconcile(user,topicId);
    const reserve=(this.sql.prepare("SELECT * FROM opportunity_ideas WHERE user_id=? AND topic_id=? AND state IN ('reserve','pending') AND first_recommended_at IS NULL AND manual_processed=0 ORDER BY score DESC,first_created_at").all(user,topicId) as IdeaRow[]).map(ideaView);
    return {topic:t,inventory:reserve,history:this.history(user),feedback:this.sql.prepare('SELECT f.* FROM opportunity_feedback f JOIN opportunity_ideas i ON i.id=f.idea_id WHERE f.user_id=? AND i.topic_id=? ORDER BY f.rowid DESC LIMIT 200').all(user,topicId),feedbackRevision:this.feedbackRevision(user,topicId),preferences:this.preferences(user,topicId),batches:this.batches(user,topicId),instructions:OPPORTUNITY_WORKFLOW};
  }
  batches(user:string,topicId?:string){return this.sql.prepare(`SELECT * FROM opportunity_batches WHERE user_id=? ${topicId?'AND topic_id=?':''} ORDER BY day DESC,created_at DESC LIMIT 60`).all(...(topicId?[user,topicId]:[user])) as OpportunityBatch[];}
  reconcile(user:string,topicId?:string) { reconcileOpportunityBatches(this.sql,user,topicId); }
  assertJob(user:string,topicId:string,conversationId:string,jobId?:string) {
    const t=this.topic(user,topicId);this.serverProject(user,t.project_id);if(t.archived_at)fail('主题已归档。',409);
    const c=this.db.getConversationForUser(conversationId,user);if(!c||c.project_id!==t.project_id)fail('请在主题关联的服务器项目会话中操作。',403);
    if(jobId){const j=this.db.getJob(jobId);if(!j||j.conversation_id!==conversationId||j.status!=='running')fail('任务已结束。',401);}
    return t;
  }
  batch(user:string,batchId:string,conversationId?:string){const b=this.sql.prepare('SELECT * FROM opportunity_batches WHERE id=? AND user_id=?').get(batchId,user) as OpportunityBatch|undefined;if(!b)fail('批次不存在。',404);if(conversationId&&b.conversation_id!==conversationId)fail('本批次由另一会话持有。',409);return b;}
  begin(user:string,topicId:string,conversationId:string,jobId:string|null,now=Date.now()) {
    this.assertJob(user,topicId,conversationId,jobId??undefined);this.reconcile(user,topicId);
    return this.transaction(()=>{const t=this.topic(user,topicId),time=new Date(now).toISOString(),day=new Intl.DateTimeFormat('en-CA',{timeZone:t.task?.schedule.timeZone??'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
      const old=this.sql.prepare('SELECT * FROM opportunity_batches WHERE topic_id=? AND day=?').get(topicId,day) as OpportunityBatch|undefined;
      if(old){if(old.status==='completed')return {...old,alreadyCompleted:true};if(old.conversation_id===conversationId&&old.status!=='failed'){if(!old.job_id&&jobId)this.sql.prepare('UPDATE opportunity_batches SET job_id=?,feedback_snapshot=?,context_watermark=? WHERE id=?').run(jobId,JSON.stringify({preferences:this.preferences(user,topicId),feedbackRevision:this.feedbackRevision(user,topicId)}),t.context_watermark,old.id);return this.batch(user,old.id);}
        if(old.status!=='failed')fail('本主题今日已有执行中的批次，请查看来源会话。',409);
        if(old.attempts>=3)fail('今日已尝试三次，请检查原因后明日继续。',409);
        this.sql.prepare("UPDATE opportunity_batches SET status='generating',conversation_id=?,job_id=?,attempts=attempts+1,error='',completed_at=NULL WHERE id=?").run(conversationId,jobId,old.id);return this.batch(user,old.id);}
      const bid=id(),snapshot={preferences:this.preferences(user,topicId),feedbackRevision:this.feedbackRevision(user,topicId)};
      this.sql.prepare('INSERT INTO opportunity_batches(id,user_id,topic_id,day,status,conversation_id,job_id,project_id,task_id,context_watermark,feedback_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(bid,user,topicId,day,'generating',conversationId,jobId,t.project_id,t.task_id,t.context_watermark,JSON.stringify(snapshot),time);return this.batch(user,bid);});
  }
  writableBatch(user:string,batchId:string,conversationId:string){const b=this.batch(user,batchId,conversationId);this.assertJob(user,b.topic_id,conversationId,b.job_id??undefined);if(!['generating','reviewing'].includes(b.status))fail('批次已经结束。',409);return b;}
  ingest(user:string,batchId:string,conversationId:string,raw:unknown) {
    const input=z.array(z.object({key:required.max(120),content:contentInput})).min(1).max(30).parse(raw);
    return this.transaction(()=>{const b=this.writableBatch(user,batchId,conversationId),count=Number((this.sql.prepare('SELECT count(*) n FROM opportunity_candidates WHERE batch_id=?').get(batchId) as {n:number}).n);
      let added=0;
      return input.map(v=>{const previous=this.sql.prepare('SELECT * FROM opportunity_candidates WHERE batch_id=? AND candidate_key=?').get(batchId,v.key) as {idea_id:string;payload:string;outcome:string}|undefined;
        if(previous){if(previous.payload!==JSON.stringify(v.content))fail('同一候选编号内容不同；更新旧想法应使用 evidence 更正证据。',409);return {idea:this.idea(user,previous.idea_id),outcome:previous.outcome,neighbors:this.neighbors(user,v.content,previous.idea_id)};}
        if(count+(++added)>60)fail('本批次已达到 60 个新候选预算。',409);
        const fingerprint=opportunityFingerprint(v.content),old=this.sql.prepare('SELECT id FROM opportunity_ideas WHERE user_id=? AND fingerprint=?').get(user,fingerprint) as {id:string}|undefined;
        const iid=old?.id??id(),time=stamp();
        if(!old)this.sql.prepare('INSERT INTO opportunity_ideas(id,user_id,topic_id,content_json,state,fingerprint,first_created_at,source_batch_id,source_conversation_id,project_id,task_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(iid,user,b.topic_id,JSON.stringify(v.content),'pending',fingerprint,time,batchId,conversationId,b.project_id,b.task_id,time);
        else this.mergeEvidence(user,iid,v.content,conversationId,'完全相同或规范化同义候选；新来源补充到原想法');
        this.sql.prepare('INSERT INTO opportunity_candidates(id,batch_id,candidate_key,payload,idea_id,outcome,created_at) VALUES(?,?,?,?,?,?,?)').run(id(),batchId,v.key,JSON.stringify(v.content),iid,old?'duplicate':'pending',time);
        return {idea:this.idea(user,iid),outcome:old?'duplicate':'pending',neighbors:this.neighbors(user,v.content,iid)};});});
  }
  mergeEvidence(user:string,ideaId:string,content:OpportunityContent,conversationId:string,reason:string) {
    const old=this.idea(user,ideaId),sources=[...old.content.sources];
    for(const source of content.sources)if(!sources.some(s=>s.url===source.url&&s.finding===source.finding))sources.push(source);
    this.sql.prepare('INSERT INTO opportunity_versions VALUES(?,?,?,?,?,?)').run(id(),ideaId,JSON.stringify(content),reason,conversationId,stamp());
    this.sql.prepare('UPDATE opportunity_ideas SET content_json=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify({...old.content,sources}),stamp(),ideaId);
  }
  correctEvidence(user:string,ideaId:string,conversationId:string,jobId:string,raw:unknown) {
    const v=z.object({requestKey:uuid,revision:z.number().int().positive(),reason:required.max(1200),patch:z.object({sources:contentInput.shape.sources.optional(),facts:required.optional(),assumptions:required.optional(),doubt:required.optional(),validation:required.optional(),maturity:text.optional()}).strict().refine(p=>Object.values(p).some(v=>v!==undefined),'请提供需要更正的证据字段。')}).parse(raw);
    const idea=this.idea(user,ideaId);this.assertJob(user,idea.topic_id,conversationId,jobId);
    // Evidence corrections are independent of daily discovery batches. Preserve
    // identity, user feedback, ranking history and first recommendation forever.
    return this.receipt(user,v.requestKey,'evidence:'+ideaId+':'+conversationId+':'+JSON.stringify(v),()=>{
      const old=this.idea(user,ideaId);if(old.revision!==v.revision)fail('卡片已变化，请重新读取后更正。',409);
      const content=contentInput.parse({...old.content,...v.patch}),time=stamp();
      this.sql.prepare('INSERT INTO opportunity_versions VALUES(?,?,?,?,?,?)').run(id(),ideaId,JSON.stringify(old.content),'证据更正前：'+v.reason,conversationId,time);
      this.sql.prepare('UPDATE opportunity_ideas SET content_json=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(content),time,ideaId);
      return {idea:this.idea(user,ideaId)};
    });
  }
  review(user:string,batchId:string,conversationId:string,raw:unknown) {
    const reviews=z.array(reviewInput).min(1).max(60).parse(raw);
    return this.transaction(()=>{const b=this.writableBatch(user,batchId,conversationId);
      for(const r of reviews){const idea=this.idea(user,r.idea_id);
        if(idea.topic_id!==b.topic_id||idea.first_recommended_at||idea.manual_processed||!['pending','reserve'].includes(idea.state))fail('只能评审本主题尚未正式推荐、未经人工处理的有效候选。',409);
        for(const c of r.compared)this.idea(user,c.id);
        const near=this.neighbors(user,idea.content,idea.id).filter(n=>n.similarity>=.35);
        if(near.some(n=>!r.compared.some(c=>c.id===n.id)) && r.verdict==='approve')fail('请逐一比较召回的相似历史，给出实质差异后再通过。',409);
        if(r.verdict==='approve'&&(r.quality<60||idea.content.sources.length===0))fail('通过评审须质量至少 60 分且有可核对来源。');
        let state:OpportunityState=r.verdict==='approve'?'reserve':r.verdict==='expired'?'expired':r.verdict==='duplicate'?'duplicate':'internal_rejected';
        if(r.verdict==='duplicate'){if(!r.duplicate_of||r.duplicate_of===idea.id)fail('请指定原想法编号。');const original=this.idea(user,r.duplicate_of);if(original.state==='duplicate')fail('请合并到最终原想法。');this.mergeEvidence(user,original.id,idea.content,conversationId,r.rationale);}
        this.sql.prepare('UPDATE opportunity_ideas SET state=?,score=?,quality=?,review_reason=?,state_reason=?,duplicate_of=?,last_reviewed_at=?,revision=revision+1,updated_at=? WHERE id=?').run(state,r.score,r.quality,r.rationale,r.verdict==='approve'?'':r.rationale,r.duplicate_of??null,stamp(),stamp(),idea.id);
        this.sql.prepare('INSERT INTO opportunity_reviews VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(batch_id,idea_id) DO UPDATE SET verdict=excluded.verdict,score=excluded.score,rationale=excluded.rationale,compared_json=excluded.compared_json,created_at=excluded.created_at,feedback_revision=excluded.feedback_revision').run(batchId,idea.id,r.verdict,r.score,r.rationale,JSON.stringify(r.compared),stamp(),this.feedbackRevision(user,b.topic_id));
        this.sql.prepare('UPDATE opportunity_candidates SET outcome=?,reason=? WHERE batch_id=? AND idea_id=?').run(r.verdict,r.rationale,batchId,idea.id);
      }
      this.sql.prepare("UPDATE opportunity_batches SET status='reviewing' WHERE id=?").run(batchId);return {reviewed:reviews.length,inventory:this.context(user,b.topic_id).inventory};});
  }
  publish(user:string,batchId:string,conversationId:string,raw:unknown) {
    const v=z.object({ids:z.array(uuid).max(10),summary:required,feedbackRevision:z.number().int().nonnegative(),contextWatermark:z.number().int().nonnegative().optional()}).parse(raw);
    return this.transaction(()=>{const old=this.batch(user,batchId);if(old.status==='completed')return {batch:old,ideas:(this.sql.prepare('SELECT * FROM opportunity_ideas WHERE recommended_batch_id=?').all(batchId) as IdeaRow[]).map(ideaView),idempotent:true};
      const b=this.writableBatch(user,batchId,conversationId),topic=this.topic(user,b.topic_id);
      if(new Set(v.ids).size!==v.ids.length||v.ids.length>topic.limit_count)fail('精选数量超出主题上限或包含重复项。');
      if(v.feedbackRevision!==this.feedbackRevision(user,b.topic_id))fail('用户反馈已更新，请重新读取并复评后提交。',409);
      const pool=(this.sql.prepare("SELECT i.id FROM opportunity_ideas i WHERE i.topic_id=? AND i.state IN ('pending','reserve') AND i.first_recommended_at IS NULL AND i.manual_processed=0 AND NOT EXISTS(SELECT 1 FROM opportunity_reviews r WHERE r.batch_id=? AND r.idea_id=i.id AND r.feedback_revision=?)").all(b.topic_id,batchId,v.feedbackRevision) as {id:string}[]);
      if(pool.length)fail(`还有 ${pool.length} 条历史备用/新候选尚未参与本轮复评，或尚未按最新反馈复评。`,409);
      const time=stamp();
      for(const iid of v.ids){const idea=this.idea(user,iid);if(idea.topic_id!==b.topic_id||idea.state!=='reserve'||idea.first_recommended_at||idea.manual_processed||idea.quality<60)fail('精选必须是本主题通过评审且从未正式推荐/人工处理的候选。',409);
        this.sql.prepare("UPDATE opportunity_ideas SET state='recommended',first_recommended_at=?,recommended_batch_id=?,revision=revision+1,updated_at=? WHERE id=?").run(time,batchId,time,iid);}
      const eligible=Number((this.sql.prepare("SELECT count(*) n FROM opportunity_ideas WHERE topic_id=? AND state='reserve' AND first_recommended_at IS NULL AND manual_processed=0").get(b.topic_id) as {n:number}).n);
      this.sql.prepare("UPDATE opportunity_batches SET status='completed',summary=?,completed_at=?,context_watermark=? WHERE id=?").run(v.summary,time,v.contextWatermark??b.context_watermark,batchId);
      if(v.contextWatermark!==undefined){const max=Number((this.sql.prepare('SELECT COALESCE(MAX(m.rowid),0) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=?').get(user) as {n:number}).n);if(v.contextWatermark>max)fail('对话水位无效。');this.sql.prepare('UPDATE opportunity_topics SET context_watermark=MAX(context_watermark,?) WHERE id=?').run(v.contextWatermark,b.topic_id);}
      return {batch:this.batch(user,batchId),ideas:v.ids.map(i=>this.idea(user,i)),reserveCount:eligible};});
  }
  failBatch(user:string,batchId:string,conversationId:string,reason:string){const b=this.writableBatch(user,batchId,conversationId);this.sql.prepare("UPDATE opportunity_batches SET status='failed',error=?,completed_at=? WHERE id=?").run(required.parse(reason),stamp(),b.id);return this.batch(user,b.id);}
  detail(user:string,ideaId:string):OpportunityDetail {
    const idea=this.idea(user,ideaId),sourceBatch=this.batch(user,idea.source_batch_id),recommendedBatch=idea.recommended_batch_id?this.batch(user,idea.recommended_batch_id):null;
    const research=this.sql.prepare('SELECT * FROM opportunity_research WHERE user_id=? AND idea_id=? ORDER BY created_at DESC').all(user,ideaId) as OpportunityResearch[];
    const versions=(this.sql.prepare('SELECT * FROM opportunity_versions WHERE idea_id=? ORDER BY created_at DESC').all(ideaId) as OpportunityDetail['versions']).map(v=>({...v,project_id:this.db.getConversationForUser(v.conversation_id,user)?.project_id??null}));
    const availableConversations=[idea.source_conversation_id,sourceBatch.conversation_id,recommendedBatch?.conversation_id,...research.map(r=>r.conversation_id),...versions.map(v=>v.conversation_id)].filter((cid):cid is string=>!!cid&&!!this.db.getConversationForUser(cid,user));
    return {idea,sourceBatch,recommendedBatch,availableConversations,versions,research,feedback:this.sql.prepare('SELECT * FROM opportunity_feedback WHERE user_id=? AND idea_id=? ORDER BY rowid DESC').all(user,ideaId) as OpportunityFeedback[]};
  }
  feedback(user:string,ideaId:string,raw:unknown,actor='user') {
    const v=z.object({requestKey:uuid,revision:z.number().int().positive(),action:z.enum(['kept','later','dismissed','rate','undo','expired']),reason:z.enum(['','no_time','vague','evidence','duplicate','direction','outdated','other']).default(''),rating:z.number().int().min(1).max(5).nullable().default(null),note:text.default('')}).parse(raw);
    return this.receipt(user,v.requestKey,'feedback:'+ideaId+':'+JSON.stringify(v),()=>{const old=this.idea(user,ideaId);if(old.revision!==v.revision)fail('卡片已更新，请重新加载后重试。',409);
      const previous={state:old.state,rating:old.rating,note:old.note,manual_processed:old.manual_processed,state_reason:old.state_reason};
      let next={...previous,state:v.action==='rate'?old.state:v.action as OpportunityState,rating:v.rating,note:v.note,manual_processed:1,state_reason:v.reason};
      if(v.action==='undo'){const last=this.sql.prepare('SELECT previous_json FROM opportunity_feedback WHERE user_id=? AND idea_id=? ORDER BY rowid DESC LIMIT 1').get(user,ideaId) as {previous_json:string}|undefined;if(!last)fail('没有可撤销的操作。');next=JSON.parse(last.previous_json);}
      this.sql.prepare('INSERT INTO opportunity_feedback VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id(),user,ideaId,v.requestKey,v.action,v.reason,v.rating,v.note,actor,JSON.stringify(previous),stamp());
      this.sql.prepare('UPDATE opportunity_ideas SET state=?,rating=?,note=?,manual_processed=?,state_reason=?,revision=revision+1,updated_at=? WHERE id=?').run(next.state,next.rating,next.note,next.manual_processed,next.state_reason,stamp(),ideaId);return this.idea(user,ideaId);});
  }
  setPreference(user:string,topicId:string,raw:unknown,agent=false) {
    const v=z.object({id:uuid.optional(),text:required,kind:z.enum(['explicit','inferred']),scope:z.enum(['topic','project','account']).default('topic'),source:required.max(1000),active:z.boolean().default(true)}).parse(raw);this.topic(user,topicId);
    if(agent&&v.scope!=='topic')fail('Agent 提炼偏好只能作用于当前主题；扩大范围需用户在页面确认。',403);
    if(agent&&v.source!=='topic-goal'){
      const valid=this.sql.prepare("SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.user_id=? AND c.deleted_at IS NULL AND m.role='user' UNION ALL SELECT 1 FROM opportunity_feedback WHERE id=? AND user_id=?").get(v.source,user,v.source,user);if(!valid)fail('偏好须引用本账号的可回查消息或反馈编号。');
    }
    if(!v.id){const existing=this.sql.prepare('SELECT id FROM opportunity_preferences WHERE user_id=? AND topic_id=? AND source=? AND text=? AND kind=? AND scope=? AND active=?').get(user,topicId,v.source,v.text,v.kind,v.scope,+v.active);if(existing)return this.preferences(user,topicId,true);}
    const pid=v.id??id();if(v.id&&!this.sql.prepare('SELECT 1 FROM opportunity_preferences WHERE id=? AND user_id=? AND topic_id=?').get(pid,user,topicId))fail('偏好不存在。',404);
    this.sql.prepare('INSERT INTO opportunity_preferences VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,kind=excluded.kind,scope=excluded.scope,source=excluded.source,active=excluded.active,updated_at=excluded.updated_at').run(pid,user,topicId,v.text,v.kind,v.scope,v.source,+v.active,stamp(),stamp());return this.preferences(user,topicId,true);
  }
  recent(user:string,topicId:string,after?:number) {
    const t=this.topic(user,topicId);if(!t.read_recent)fail('此主题尚未授权读取近期对话。',403);
    const cursor=after??t.context_watermark;
    const rows=this.sql.prepare("SELECT m.rowid cursor,m.id,m.conversation_id,c.project_id,c.title,m.created_at,substr(m.content,1,4000) content FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=? AND c.deleted_at IS NULL AND m.rowid>? AND m.created_at>=? AND m.role='user' AND m.is_internal=0 AND m.is_scheduled=0 ORDER BY m.rowid LIMIT 120").all(user,cursor,new Date(Date.now()-30*86400000).toISOString()) as {cursor:number;id:string;conversation_id:string;project_id:string;title:string;created_at:string;content:string}[];
    const words=[...new Set((t.name+' '+t.goal+' '+t.questions).match(/[\p{Script=Han}]{2,6}|[a-zA-Z]{3,}/gu)??[])];
    const relevant=rows.filter(r=>r.project_id===t.project_id||words.some(w=>(r.title+' '+r.content).includes(w))||(/游戏|儿童|绘画/.test(t.name+t.goal)&&/游戏|绘画|画鱼|侦探|英语|小朋友|孩子/.test(r.title+r.content)));
    return {items:relevant.map(r=>({...r,content:stripPersonalContext(r.content).slice(0,2400)})),scanned:rows.length,nextWatermark:rows.at(-1)?.cursor??cursor,hasMore:rows.length===120,notice:'只提炼与主题相关偏好；无关私人内容不入卡。最多增量翻页十次，将返回水位在 publish 时保存。'};
  }
  view(user:string,topicId:string|undefined,tab:string,offset=0) {
    if(topicId)this.topic(user,topicId);this.reconcile(user,topicId);
    const todayBatches=this.topics(user).flatMap(t=>{
      const day=new Intl.DateTimeFormat('en-CA',{timeZone:t.task?.schedule.timeZone??'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const b=this.sql.prepare("SELECT id FROM opportunity_batches WHERE topic_id=? AND day=? AND status='completed'").get(t.id,day) as {id:string}|undefined;
      return b?[b.id]:[];
    });
    const filters:Record<string,string>={today:`i.recommended_batch_id IN (${todayBatches.map(()=>'?').join(',')||'NULL'})`,reserve:"i.state='reserve' AND i.first_recommended_at IS NULL AND i.manual_processed=0",history:"(i.first_recommended_at IS NOT NULL OR i.manual_processed=1)",screen:"i.state='recommended' AND i.manual_processed=0",rejected:"i.state IN ('internal_rejected','expired','duplicate')"};
    const clause=`i.user_id=? AND t.deleted_at IS NULL ${topicId?'AND i.topic_id=?':''} AND ${filters[tab]??filters.today}`,params=[...(topicId?[user,topicId]:[user]),...((tab==='today'||!filters[tab])?todayBatches:[])];
    const total=Number((this.sql.prepare(`SELECT count(*) n FROM opportunity_ideas i JOIN opportunity_topics t ON t.id=i.topic_id WHERE ${clause}`).get(...params) as {n:number}).n);
    const rows=this.sql.prepare(`SELECT i.* FROM opportunity_ideas i JOIN opportunity_topics t ON t.id=i.topic_id WHERE ${clause} ORDER BY i.first_recommended_at DESC,i.score DESC,i.first_created_at DESC LIMIT 40 OFFSET ?`).all(...params,Math.max(0,offset)) as IdeaRow[];
    return {topics:this.topics(user),ideas:rows.map(ideaView),batches:this.batches(user,topicId),preferences:topicId?this.preferences(user,topicId,true):[],total,nextOffset:offset+rows.length<total?offset+rows.length:null};
  }
  start(user:string,topicId:string,selection:StoredAgentSelection,key:string,researchIdeaId?:string) {
    const t=this.topic(user,topicId);this.serverProject(user,t.project_id);if(t.archived_at)fail('请先恢复主题。',409);
    return this.receipt(user,key,'start:'+topicId+':'+(researchIdeaId??''),()=>{
      if(!researchIdeaId){const day=new Intl.DateTimeFormat('en-CA',{timeZone:t.task?.schedule.timeZone??'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const b=this.sql.prepare('SELECT * FROM opportunity_batches WHERE topic_id=? AND day=?').get(topicId,day) as OpportunityBatch|undefined;if(b&&b.status!=='failed')return {conversationId:b.conversation_id,projectId:t.project_id,alreadyStarted:true};if(b&&b.attempts>=3)fail('今日已尝试三次，请先检查来源会话。',409);
        const pending=this.sql.prepare("SELECT c.id FROM conversations c JOIN opportunity_requests r ON json_extract(r.result_json,'$.conversationId')=c.id WHERE r.user_id=? AND r.operation=? AND (EXISTS(SELECT 1 FROM pending_prompts p WHERE p.conversation_id=c.id AND p.status='queued') OR EXISTS(SELECT 1 FROM jobs j WHERE j.conversation_id=c.id AND j.status IN ('queued','running')))").get(user,'start:'+topicId+':') as {id:string}|undefined;if(pending)return {conversationId:pending.id,projectId:t.project_id,alreadyStarted:true};}
      const idea=researchIdeaId?this.idea(user,researchIdeaId):null;if(idea&&idea.topic_id!==topicId)fail('卡片不属于当前主题。');
      const cid=id(),selected=t.task?{model:t.task.model,reasoningEffort:t.task.reasoningEffort}:selection;
      this.db.createConversation(cid,idea?'深入研究 · '+idea.content.title:t.name+' · 发现机会',selected,user,t.project_id);this.sql.prepare("UPDATE conversations SET title_source='manual' WHERE id=?").run(cid);
      const prompt=idea?`深入研究机会卡片 ${idea.id}，主题 ${topicId}。先用 codex_web_opportunities context/detail 读取目标、证据、疑点和反馈，检索权威资料，执行不涉及购买/交易/发布的最小可行验证。区分已验证、被证伪及待验证；完成后 research_result 写回本卡，result 提供证据和结论。不自动宣称项目完成。\n${JSON.stringify(idea.content)}`:(t.task?.prompt??opportunityPrompt(t))+`\n关联机会主题：${topicId}。先用 codex_web_opportunities context 读取当前目标、反馈与库存。`;
      this.db.createPendingPrompt(id(),cid,prompt,selected);
      if(!idea){const day=new Intl.DateTimeFormat('en-CA',{timeZone:t.task?.schedule.timeZone??'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());reserveOpportunityBatch(this.sql,t.id,user,cid,t.project_id,t.task_id,day,stamp());}
      if(idea)this.sql.prepare('INSERT INTO opportunity_research VALUES(?,?,?,?,?,?,?,?,?)').run(id(),user,idea.id,cid,key,'interested','',stamp(),stamp());
      return {conversationId:cid,projectId:t.project_id};});
  }
  researchResult(user:string,ideaId:string,conversationId:string,raw:unknown){const v=z.object({status:z.enum(['validated','invalidated','inconclusive']),result:required}).parse(raw),idea=this.idea(user,ideaId);this.assertJob(user,idea.topic_id,conversationId);const r=this.sql.prepare('UPDATE opportunity_research SET status=?,result=?,updated_at=? WHERE user_id=? AND idea_id=? AND conversation_id=?').run(v.status,v.result,stamp(),user,ideaId,conversationId);if(!r.changes)fail('当前会话未关联这张卡片的研究。',403);return this.detail(user,ideaId);}
  toProject(user:string,ideaId:string,boardId:string,key:string){
    const para=new ParaStore(this.db);para.board(user,boardId);
    return this.receipt(user,key,'project:'+ideaId+':'+boardId,()=>{const idea=this.idea(user,ideaId);if(idea.para_project_id)return para.project(user,idea.para_project_id);const p=para.createProject(user,boardId,idea.content.title,'idea');
      const brief={...emptyBrief(),goal:idea.content.summary,success:idea.content.validation,constraints:this.topic(user,idea.topic_id).constraints,questions:idea.content.doubt,next:idea.content.validation,decisions:'来自机会卡片 '+idea.id+'；感兴趣不代表验证有效。'};
      this.sql.prepare('UPDATE para_projects SET brief=?,default_project_id=? WHERE id=?').run(JSON.stringify(brief),idea.project_id,p.id);
      para.linkConversation(user,p.id,idea.source_conversation_id,false);
      this.sql.prepare("UPDATE opportunity_ideas SET state='project',para_project_id=?,manual_processed=1,revision=revision+1,updated_at=? WHERE id=?").run(p.id,stamp(),ideaId);return para.project(user,p.id);});
  }
}
export const OPPORTUNITY_WORKFLOW = `工具 action 与 data：
context: 读取目标/偏好/反馈/库存摘要；inventory: {offset,limit} 分页读取所有待评审与备用候选详情（context 只显示前25条摘要，须按 nextInventoryOffset 继续）；history: {offset,limit} 分页读取本账号全历史（含淘汰），先查再生成；detail: {ideaId}。
begin: 建立/恢复今日批次。返回 alreadyCompleted=true 则立即停止，不能重复推荐。保留 batch.id 后续使用。
recent: {after?} 仅授权主题可用，增量返回当前账号相关用户消息及水位；最多翻页十次。
preferences: {text,kind:explicit|inferred,scope:topic,source:消息或反馈ID|topic-goal,id?,active?}。明确评价才 explicit；无备注淘汰/未读是弱信号，AI 淘汰不算用户负面偏好。按最新状态和时间处理撤销，已撤销的反馈不能继续作为有效负面证据。先查已有偏好，相同来源更新旧项。用户可修正/撤销。
ingest: {batchId,candidates:[{key:本轮稳定编号,content:{title,summary,audience,problem,mechanism,value,fit,facts,assumptions,doubt,validation,difference,interaction,loop,english,expansion,maturity,category,keywords:[...],sources:[{title,url,date:YYYY-MM-DD,finding}]}}]}。必填文本不可空，互动/循环/英语/扩展/成熟度对小游戏主题必须充分说明。所有新候选先入库，再评审；一次最多30条，一轮最多60条。返回原卡/近似历史；重复项新证据自动入旧卡版本。
evidence: {ideaId,requestKey:UUID,revision:detail.idea.revision,reason,patch:{sources?,facts?,assumptions?,doubt?,validation?,maturity?}}。补充或更正旧卡证据，sources若提供为完整替换列表，可移除错误引用；记录更正前完整版本及本正常会话。无需begin，不生成候选/批次，不更改标题、核心机制、状态、评分、人工反馈或首次推荐。先detail核对再提交；只在本主题服务器项目运行Job中使用，版本冲突须重读。备用证据变化后需重新评审，不能冒充人工负面反馈。
review: {batchId,reviews:[{idea_id,verdict:approve|reject|duplicate|expired,score:0..100,quality:0..100,rationale,compared:[{id, difference}],duplicate_of?:原想法ID}]}。独立评审每个新候选及所有历史备用；approve 须质量>=60且有来源，按主题 exploration 比例考虑有理由的探索方向，但不降低质量；近似>=.35逐一解释实质差异，语义相同合并，不只比标题。旧备用复评分数反映最新反馈和证据，过时项给原因。跨主题全历史也避重。相似召回不保证绝对完整，请结合 history 作语义判定。
publish: {batchId,ids:[精选稳定ID],summary:排序与多样性取舍/不足原因,feedbackRevision:context返回值,contextWatermark?:recent返回水位}。从全部有效备用+新候选择优，不足可0条；已推荐/人工处理不得进入。未入选合格项自动留备用，首次推荐时间只写一次。库存全部复评后才可提交。失败用 fail:{batchId,reason}，采集失败不得 publish 伪成功。
research_result:{ideaId,status:validated|invalidated|inconclusive,result} 仅关联研究会话写回。feedback:{ideaId,requestKey:UUID,revision,action:kept|later|dismissed|rate|undo|expired,reason:no_time|vague|evidence|duplicate|direction|outdated|other|空,rating:1..5|null,note} 仅记录用户明确要求，不得把AI评审当人工反馈。
所有执行必须留在本服务器项目正常会话内，不使用隐藏模型、远程Worker或另起调度器。正常停止/失败保留原批次与候选，显式重试每日最多3次。`;
