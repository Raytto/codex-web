import { isHostRootUser } from "./host-root-user.js";
import { HOST_EXECUTOR_ID } from "./remote-worker-protocol.js";
import crypto from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase, StoredAgentSelection } from './db.js';
import { RecurringStore } from './recurring-store.js';
import type { Judgment, JudgmentInput, JudgmentDetail, JudgmentStats, JudgmentOutcome } from '../src/judgment-types.js';

export class JudgmentError extends Error { constructor(readonly status:number,message:string){super(message);} }
export type JudgmentActor = { user:string; kind:'user'|'agent'; projectId?:string; conversationId?:string; jobId?:string };
const text = (max=10000) => z.string().trim().max(max);
const nonempty = (max=10000) => text(max).min(1);
const date = z.string().datetime({offset:true}).transform(v=>new Date(v).toISOString());
const zone = z.string().max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'时区无效');
const url = z.string().url().max(2000).refine(v=>/^https?:\/\//.test(v),'来源须为 HTTP(S) 地址').refine(v=>{const u=new URL(v);return !u.username&&!u.password&&![...u.searchParams.keys()].some(k=>/^(api[_-]?key|token|access[_-]?token|secret|signature)$/i.test(k));},'证据地址不可包含凭据，请保存公开来源页地址');
const stockSchema = z.object({symbol:nonempty(40),market:nonempty(80),currency:nonempty(20),baselineDate:z.iso.date(),baselineValue:z.number().finite().positive(),targetDate:z.iso.date(),timeZone:zone,priceType:z.enum(['close','intraday']),adjustment:z.enum(['raw','adjusted','total_return']),nonTradingDay:z.enum(['unresolved','previous']),missing:z.literal('unresolved'),suspension:z.literal('unresolved'),corporateActions:z.enum(['unresolved','source_adjusted'])}).strict();
const ruleSchema = z.object({metric:nonempty(150),unit:nonempty(80),period:nonempty(150),sourceUrl:url,comparator:z.enum(['gt','gte','lt','lte','eq']),threshold:z.number().finite(),stock:stockSchema.optional()}).strict();
const inputSchema = z.object({projectId:z.string().uuid(),kind:z.enum(['prediction','idea']),title:nonempty(500),probability:z.number().min(0).max(1).nullable(),deadlineAt:date.nullable(),criteria:text(),rationale:text(),doubts:text(),topic:text(100),mode:z.enum(['public_event','numeric','private']),rule:ruleSchema.nullable(),autoResolve:z.boolean(),checkAt:date,timeZone:zone,synthetic:z.boolean().default(false),parentId:z.string().uuid().optional()}).strict();
const evidenceSchema = z.object({url:z.union([url,z.literal('')]),excerpt:nonempty(20000),observedAt:date,value:z.number().finite().optional(),unit:text(80).optional(),period:text(150).optional(),stock:stockSchema.optional(),complete:z.boolean(),conflict:z.boolean(),fileIds:z.array(z.string().uuid()).max(12).optional(),stockValidation:z.object({tradingDate:z.iso.date(),suspended:z.boolean(),corporateAction:z.boolean(),sourceAdjusted:z.boolean(),targetNonTradingDay:z.boolean().optional(),latestTradingDayVerified:z.boolean().optional()}).strict().optional()}).strict();
type Row = {id:string;user_id:string;project_id:string;project_name:string;archived_at:string|null;kind:Judgment['kind'];title:string;original_json:string;probability:number|null;topic:string;deadline_at:string|null;mode:Judgment['mode'];auto_resolve:number;synthetic:number;state:Judgment['status'];outcome:JudgmentOutcome|null;revision:number;parent_id:string|null;created_at:string;updated_at:string};
const stable = (v:unknown):string => JSON.stringify(v, (_k,value)=>value && typeof value==='object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))) : value);
const stamp = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

export class JudgmentStore {
  constructor(readonly db:AppDatabase, readonly now:()=>number=Date.now){}
  private get sql(){return this.db.sqlite;}
  private row(user:string,id:string):Row {
    const row=this.sql.prepare(`SELECT j.*,p.name AS project_name,p.archived_at FROM judgments j JOIN projects p ON p.id=j.project_id AND p.user_id=j.user_id WHERE j.id=? AND j.user_id=?`).get(id,user) as Row|undefined;
    if(!row)throw new JudgmentError(404,'判断不存在。');return row;
  }
  project(user:string,id:string){
    if(!this.sql.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(user))throw new JudgmentError(403,'当前账号不可用。');
    const p=this.db.getActiveProjectForUser(id,user);
    if(!p)throw new JudgmentError(404,'所属项目不存在或已归档。');
    if(p.executor_id!==(isHostRootUser(user)?HOST_EXECUTOR_ID:'tenant-local'))throw new JudgmentError(400,'第一版判断簿使用服务器文件夹项目，请选择服务器项目。');
    return p;
  }
  private writable(actor:JudgmentActor,id:string,revision:unknown){
    const row=this.row(actor.user,id);this.project(actor.user,row.project_id);
    if(actor.projectId&&actor.projectId!==row.project_id)throw new JudgmentError(403,'请在这条判断所属的项目中操作。');
    if(!Number.isInteger(revision)||row.revision!==revision)throw new JudgmentError(409,'记录已更新。请刷新读取最新版本；你的输入仍保留。');
    return row;
  }
  private event(id:string,kind:string,message:string,actor:JudgmentActor){this.sql.prepare('INSERT INTO judgment_events(id,judgment_id,kind,text,conversation_id,created_at) VALUES(?,?,?,?,?,?)').run(uuid(),id,kind,message,actor.conversationId??null,stamp());}
  private bump(id:string){this.sql.prepare('UPDATE judgments SET revision=revision+1,updated_at=? WHERE id=?').run(stamp(),id);}
  private transaction<T>(actor:JudgmentActor,key:unknown,operation:string,payload:unknown,fn:()=>T):T {
    const requestKey=z.string().min(8).max(160).parse(key),fingerprint=crypto.createHash('sha256').update(stable({operation,payload,project:actor.projectId??null,conversation:actor.conversationId??null})).digest('hex');
    this.sql.exec('BEGIN IMMEDIATE');
    try{
      const old=this.sql.prepare('SELECT fingerprint,result_json FROM judgment_requests WHERE user_id=? AND request_key=?').get(actor.user,requestKey) as {fingerprint:string;result_json:string}|undefined;
      if(old){if(old.fingerprint!==fingerprint)throw new JudgmentError(409,'该请求已用于不同的操作，请使用新的请求编号。');this.sql.exec('COMMIT');return JSON.parse(old.result_json) as T;}
      const value=fn();this.sql.prepare('INSERT INTO judgment_requests VALUES(?,?,?,?,?)').run(actor.user,requestKey,fingerprint,JSON.stringify(value),stamp());this.sql.exec('COMMIT');return value;
    }catch(e){this.sql.exec('ROLLBACK');throw e;}
  }
  private view(row:Row):Judgment {
    const original=JSON.parse(row.original_json) as JudgmentInput;
    const next=this.sql.prepare("SELECT t.next_run_at FROM judgment_checks c JOIN recurring_tasks t ON t.id=c.task_id WHERE c.judgment_id=? AND c.state='armed' AND t.state='active' ORDER BY t.next_run_at LIMIT 1").get(row.id) as {next_run_at:string}|undefined;
    const state=row.state==='observing'&&row.deadline_at&&Date.parse(row.deadline_at)<=this.now()?'verification':row.state;
    return {id:row.id,projectId:row.project_id,projectName:row.project_name,projectArchived:!!row.archived_at,kind:row.kind,title:row.title,probability:row.probability,firstProbability:original.probability,deadlineAt:row.deadline_at,criteria:original.criteria,rationale:original.rationale,doubts:original.doubts,topic:row.topic,mode:row.mode,rule:original.rule,autoResolve:!!row.auto_resolve,synthetic:!!row.synthetic,status:state,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at,parentId:row.parent_id,outcome:row.outcome,nextCheckAt:next?.next_run_at??null};
  }
  list(user:string):{items:Judgment[];stats:JudgmentStats}{
    const ids=this.sql.prepare('SELECT id FROM judgments WHERE user_id=? ORDER BY created_at DESC,id DESC').all(user) as {id:string}[];
    const items=ids.map(r=>this.view(this.row(user,r.id)));
    const priority={feedback:0,verification:1,evidence:2,observing:3,resolved:4,indeterminate:5,withdrawn:6};
    items.sort((a,b)=>priority[a.status]-priority[b.status]||(a.nextCheckAt??a.deadlineAt??'9999').localeCompare(b.nextCheckAt??b.deadlineAt??'9999'));
    const predictions=items.filter(j=>j.kind==='prediction'&&!j.synthetic),scored=predictions.filter(j=>j.status==='resolved'&&(j.outcome==='yes'||j.outcome==='no'));
    const score=(key:'probability'|'firstProbability')=>scored.length?scored.reduce((n,j)=>n+((j[key]??0)-(j.outcome==='yes'?1:0))**2,0)/scored.length:null;
    return {items,stats:{scored:scored.length,pending:predictions.filter(j=>!['resolved','indeterminate','withdrawn'].includes(j.status)).length,withdrawn:predictions.filter(j=>j.status==='withdrawn').length,indeterminate:predictions.filter(j=>j.status==='indeterminate').length,synthetic:items.filter(j=>j.synthetic).length,firstBrier:score('firstProbability'),lastBrier:score('probability')}};
  }
  detail(user:string,id:string):JudgmentDetail{
    const judgment=this.view(this.row(user,id));
    const versions=this.sql.prepare('SELECT id,number,probability,reason,snapshot_json,created_at AS createdAt,actor,conversation_id AS conversationId FROM judgment_versions WHERE judgment_id=? ORDER BY number').all(id).map(raw=>{const {snapshot_json,...r}=raw;return {...r,snapshot:snapshot_json?JSON.parse(String(snapshot_json)):null};}) as JudgmentDetail['versions'];
    const evidence=this.sql.prepare('SELECT id,content_json,created_at AS createdAt,conversation_id AS conversationId,check_id AS checkId FROM judgment_evidence WHERE judgment_id=? ORDER BY created_at,id').all(id).map(raw=>{const {content_json,...r}=raw;return {...r,...JSON.parse(String(content_json))};}) as JudgmentDetail['evidence'];
    const results=this.sql.prepare('SELECT id,outcome,reason,candidate,evidence_json,actor,created_at AS createdAt,conversation_id AS conversationId,supersedes FROM judgment_results WHERE judgment_id=? ORDER BY rowid').all(id).map(raw=>{const {candidate,evidence_json,...r}=raw;return {...r,candidate:!!candidate,evidenceIds:JSON.parse(String(evidence_json))};}) as JudgmentDetail['results'];
    const checks=this.sql.prepare(`SELECT c.id,c.task_id AS taskId,json_extract(t.schedule_json,'$.at') AS at,json_extract(t.schedule_json,'$.timeZone') AS timeZone,c.state,c.conversation_id AS conversationId,t.model,t.reasoning_effort AS reasoningEffort,
      CASE WHEN c.state='cancelled' AND c.conversation_id IS NULL THEN 'cancelled' WHEN c.state='feedback' THEN 'feedback' WHEN c.state='armed' THEN CASE WHEN p.archived_at IS NOT NULL THEN 'project_archived' ELSE 'scheduled' END
      WHEN x.deleted_at IS NOT NULL THEN 'deleted'
      WHEN EXISTS(SELECT 1 FROM pending_prompts q WHERE q.conversation_id=x.id AND q.status='queued') THEN 'queued'
      ELSE COALESCE((SELECT status FROM jobs j WHERE j.conversation_id=x.id ORDER BY created_at DESC,id DESC LIMIT 1),'cancelled') END AS taskStatus,
      (SELECT reason FROM recurring_runs r WHERE r.task_id=t.id ORDER BY created_at DESC LIMIT 1) AS reason
      FROM judgment_checks c JOIN recurring_tasks t ON t.id=c.task_id JOIN projects p ON p.id=t.project_id LEFT JOIN conversations x ON x.id=c.conversation_id WHERE c.judgment_id=? ORDER BY c.created_at DESC,c.rowid DESC`).all(id) as JudgmentDetail['checks'];
    const events=this.sql.prepare('SELECT id,kind,text,created_at AS createdAt,conversation_id AS conversationId FROM judgment_events WHERE judgment_id=? ORDER BY rowid DESC').all(id) as JudgmentDetail['events'];
    const links=new Set([...versions,...evidence,...results,...checks,...events].map(r=>r.conversationId).filter((id):id is string=>!!id));
    const availableConversations=[...links].filter(cid=>{const c=this.db.getConversationForUser(cid,user);return c?.project_id===judgment.projectId;});
    return {judgment,versions,evidence,results,checks,events,availableConversations};
  }
  private cancelChecks(id:string){
    const pending=this.sql.prepare(`SELECT r.pending_prompt_id FROM judgment_checks c JOIN recurring_runs r ON r.task_id=c.task_id JOIN pending_prompts q ON q.id=r.pending_prompt_id WHERE c.judgment_id=? AND c.state IN ('armed','fired','feedback') AND q.status='queued'`).all(id) as {pending_prompt_id:string}[];
    for(const p of pending)this.db.deletePendingPrompt(p.pending_prompt_id);
    this.sql.prepare("UPDATE recurring_tasks SET state='paused',next_run_at=NULL,revision=revision+1 WHERE id IN (SELECT task_id FROM judgment_checks WHERE judgment_id=? AND state IN ('armed','fired','feedback'))").run(id);
    this.sql.prepare("UPDATE judgment_checks SET state='cancelled' WHERE judgment_id=? AND state IN ('armed','fired','feedback')").run(id);
  }
  private plan(actor:JudgmentActor,id:string,at:string,timeZone:string,selection:StoredAgentSelection){
    const row=this.row(actor.user,id);this.cancelChecks(id);
    const checkId=uuid();
    const task=new RecurringStore(this.db).create(actor.user,row.project_id,{name:`判断核验 · ${row.title.slice(0,80)}`,prompt:`核验判断簿记录 ${id}，检查编号 ${checkId}。先调用 codex_web_judgments context，再 detail。若检查已取消或被替代，立即结束，不再取证。按保存的判据与来源核验，使用 evidence 保存核心摘录、数值、时期、单位和来源，再用 submit 写回同一记录。每次写入使用最新 revision 和独立 requestKey，并带 checkId。未找到证据写 needs_evidence，不能判否；语义事件只提交候选，不能代本人确认。不要另建计划或改变本人概率。工具不可见时使用 CODEX_WEB_JUDGMENT_CLI。`,...selection,maxRuns:1,schedule:{kind:'once',at,timeZone}},this.now());
    this.sql.prepare('INSERT INTO judgment_checks(id,judgment_id,task_id,created_at) VALUES(?,?,?,?)').run(checkId,id,task.id,stamp());
    return checkId;
  }
  create(actor:JudgmentActor,body:Record<string,unknown>,selection:StoredAgentSelection){
    return this.transaction(actor,body.requestKey,'create',body,()=>{
      const {requestKey:_,...raw}=body,input=inputSchema.parse(raw);this.project(actor.user,input.projectId);
      if(actor.projectId&&actor.projectId!==input.projectId)throw new JudgmentError(403,'只能在当前会话所属项目创建判断。');
      if(Date.parse(input.checkAt)<=this.now())throw new JudgmentError(400,'检查时间须晚于现在。');
      if(input.kind==='prediction'&&(input.probability===null||!input.deadlineAt||!input.criteria||Date.parse(input.deadlineAt)<=this.now()))throw new JudgmentError(400,'预测需要本人概率、未来的事件期限和清晰判据。');
      if(input.kind==='idea'&&(input.probability!==null||input.deadlineAt!==null||input.mode!=='private'))throw new JudgmentError(400,'长期想法使用回顾日期和本人反馈，不填写概率或输赢期限。');
      if(input.mode==='numeric'&&!input.rule)throw new JudgmentError(400,'请填写数值来源、时期、单位和比较规则。');
      if(input.mode!=='numeric'&&(input.rule||input.autoResolve))throw new JudgmentError(400,'只有结构化数值预测可以预先允许自动结论。');
      if(input.rule?.stock){const s=input.rule.stock;if(s.targetDate<s.baselineDate||input.rule.unit!==s.currency)throw new JudgmentError(400,'股票目标日期须不早于基准日期，单位须与币种一致。');}
      if(input.parentId){const parent=this.row(actor.user,input.parentId);if(parent.project_id!==input.projectId)throw new JudgmentError(403,'关联新题须属于同一项目。');}
      const id=uuid(),time=stamp();this.sql.prepare(`INSERT INTO judgments(id,user_id,project_id,kind,title,original_json,probability,topic,deadline_at,mode,auto_resolve,synthetic,parent_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,actor.user,input.projectId,input.kind,input.title,JSON.stringify(input),input.probability,input.topic,input.deadlineAt,input.mode,Number(input.autoResolve),Number(input.synthetic),input.parentId??null,time,time);
      this.sql.prepare('INSERT INTO judgment_versions(id,judgment_id,number,probability,reason,snapshot_json,actor,conversation_id,created_at) VALUES(?,?,1,?,?,?,?,?,?)').run(uuid(),id,input.probability,input.rationale||'首次记录',JSON.stringify(input),actor.kind,actor.conversationId??null,time);
      this.event(id,'created','保留原始判断与首次把握。',actor);this.plan(actor,id,input.checkAt,input.timeZone,selection);return this.detail(actor.user,id);
    });
  }
  private check(actor:JudgmentActor,row:Row,checkId:unknown,allowClosed=false){
    const linked=actor.conversationId?this.sql.prepare('SELECT id,judgment_id FROM judgment_checks WHERE conversation_id=?').get(actor.conversationId) as {id:string;judgment_id:string}|undefined:undefined;
    if(linked&&(linked.id!==checkId||linked.judgment_id!==row.id))throw new JudgmentError(409,'此次核验只可写回绑定的判断和检查编号。');
    if(checkId){const check=this.sql.prepare('SELECT * FROM judgment_checks WHERE id=? AND judgment_id=?').get(String(checkId),row.id) as {state:string;conversation_id:string|null}|undefined;
      if(!check||check.state!=='fired'||(actor.kind==='agent'&&check.conversation_id!==actor.conversationId))throw new JudgmentError(409,'检查已停止、被新计划替代或已提交，旧执行不能写回。');}
    if(!allowClosed&&['resolved','indeterminate','withdrawn'].includes(row.state))throw new JudgmentError(409,'这条判断已结束；更正结果请由本人追加更正。');
  }
  mutate(actor:JudgmentActor,id:string,action:string,body:Record<string,unknown>,selection:StoredAgentSelection){
    return this.transaction(actor,body.requestKey,`${id}:${action}`,body,()=>{
      const row=this.writable(actor,id,body.revision),original=JSON.parse(row.original_json) as JudgmentInput;
      const linked=actor.conversationId&&this.sql.prepare('SELECT 1 FROM judgment_checks WHERE conversation_id=?').get(actor.conversationId);
      if(linked&&!['evidence','submit'].includes(action))throw new JudgmentError(403,'到期核验会话只能追加证据与核验结果。');
      if(action==='revise'){
        if(row.kind!=='prediction'||['resolved','indeterminate','withdrawn'].includes(row.state)||!row.deadline_at||Date.parse(row.deadline_at)<=this.now())throw new JudgmentError(409,'事件已截止或判断已结束，不能回改事前概率；可追加复盘或建立关联新题。');
        const probability=z.number().min(0).max(1).parse(body.probability),reason=nonempty().parse(body.reason);
        this.sql.prepare('INSERT INTO judgment_versions(id,judgment_id,number,probability,reason,actor,conversation_id,created_at) SELECT ?,?,MAX(number)+1,?,?,?,?,? FROM judgment_versions WHERE judgment_id=?').run(uuid(),id,probability,reason,actor.kind,actor.conversationId??null,stamp(),id);
        this.sql.prepare('UPDATE judgments SET probability=? WHERE id=?').run(probability,id);this.event(id,'revision',reason,actor);
      }else if(action==='schedule'){
        if(['resolved','indeterminate','withdrawn'].includes(row.state)&&row.kind!=='idea')throw new JudgmentError(409,'已结束的预测不能再安排检查。');
        const at=date.parse(body.at),timeZone=zone.parse(body.timeZone);if(Date.parse(at)<=this.now())throw new JudgmentError(400,'请选择未来的检查时间。');
        this.plan(actor,id,at,timeZone,selection);this.sql.prepare("UPDATE judgments SET state='observing' WHERE id=?").run(id);this.event(id,'schedule',`安排检查：${at}（${timeZone}）`,actor);
      }else if(action==='cancel'){
        this.cancelChecks(id);this.event(id,'cancel','已停止当前检查；记录与证据保留，运行中的旧检查不能写回。',actor);
      }else if(action==='withdraw'){
        if(actor.kind!=='user')throw new JudgmentError(403,'请本人在判断簿撤回。');this.cancelChecks(id);this.sql.prepare("UPDATE judgments SET state='withdrawn' WHERE id=?").run(id);this.event(id,'withdraw',nonempty().parse(body.reason),actor);
      }else if(action==='note'){
        this.event(id,'lesson',nonempty(20000).parse(body.reason),actor);
      }else if(action==='evidence'){
        this.check(actor,row,body.checkId,!linked&&!body.checkId);const evidence=evidenceSchema.parse(body.evidence);
        if(Date.parse(evidence.observedAt)>this.now()+60000)throw new JudgmentError(400,'证据取得时间不能在未来。');
        const evidenceId=uuid();this.sql.prepare('INSERT INTO judgment_evidence VALUES(?,?,?,?,?,?,?)').run(evidenceId,id,typeof body.checkId==='string'?body.checkId:null,JSON.stringify(evidence),actor.conversationId??null,actor.jobId??null,stamp());for(const fileId of new Set(evidence.fileIds??[])){
          const file=this.db.getFileForUser(fileId,actor.user),c=file?this.db.getConversation(file.conversation_id):null;
          if(!file||!c||c.project_id!==row.project_id||file.composer_draft_id||file.pending_prompt_id)throw new JudgmentError(400,'只能引用所属项目中已保存到消息的附件，草稿或待发送附件不可引用。');
          this.sql.prepare('INSERT INTO judgment_attachments VALUES(?,?)').run(evidenceId,fileId);
        }
        this.event(id,'evidence','已保存证据摘录；它会独立于来源会话保留。引用的附件继续由原会话和冷存储管理。',actor);
      }else if(action==='submit'){
        this.check(actor,row,body.checkId);const reason=nonempty().parse(body.reason);
        const verdict=z.enum(['yes','no','indeterminate','needs_evidence','needs_feedback']).parse(body.outcome);
        if(verdict==='needs_evidence'||verdict==='needs_feedback'){
          this.sql.prepare('UPDATE judgments SET state=? WHERE id=?').run(verdict==='needs_evidence'?'evidence':'feedback',id);this.event(id,'verification',reason,actor);
        }else{
          if(row.kind!=='prediction'||row.mode==='private')throw new JudgmentError(400,'请由本人在判断簿填写私有结果或长期想法回顾。');
          if(!row.deadline_at||Date.parse(row.deadline_at)>this.now())throw new JudgmentError(409,'事件期限尚未到，先保存证据，不能提前揭晓。');
          const evidenceIds=z.array(z.string().uuid()).min(1).max(100).parse(body.evidenceIds),all=this.detail(actor.user,id).evidence,selected=all.filter(e=>evidenceIds.includes(e.id));
          if(selected.length!==new Set(evidenceIds).size)throw new JudgmentError(400,'证据不属于这条判断。');
          if(row.mode==='public_event'&&selected.some(e=>!e.url||!e.complete||e.conflict)){this.sql.prepare("UPDATE judgments SET state='evidence' WHERE id=?").run(id);this.event(id,'verification','公开事实证据不完整或有冲突，等待补充后再提请本人确认。',actor);this.finishCheck(body.checkId);this.bump(id);return this.detail(actor.user,id);}
          let outcome:JudgmentOutcome=verdict,automatic=false,resultReason=reason;
          if(row.mode==='numeric'){
            const rule=original.rule!;
            const valid=selected.every(e=>e.complete&&!e.conflict&&e.url===rule.sourceUrl&&e.unit===rule.unit&&e.period===rule.period&&typeof e.value==='number'&&(!rule.stock||stable(e.stock)===stable(rule.stock)));
            const conflict=all.some(e=>e.period===rule.period&&(e.conflict||(e.unit===rule.unit&&e.value!==undefined&&selected.some(s=>s.value!==e.value))))||new Set(selected.map(e=>e.value)).size!==1;
            const stockValid=!rule.stock||selected.every(e=>{
              const s=rule.stock!,v=e.stockValidation;
              return !!v&&!v.suspended&&v.tradingDate>=s.baselineDate&&(v.tradingDate===s.targetDate||(s.nonTradingDay==='previous'&&v.tradingDate<s.targetDate&&v.targetNonTradingDay===true&&v.latestTradingDayVerified===true))&&(!v.corporateAction||(s.corporateActions==='source_adjusted'&&s.adjustment!=='raw'&&v.sourceAdjusted))&&(s.adjustment==='raw'||v.sourceAdjusted)&&s.priceType==='close';
            });
            if(!valid||conflict||!stockValid){this.sql.prepare("UPDATE judgments SET state='evidence' WHERE id=?").run(id);this.event(id,'verification','数值证据缺失、冲突或口径不一致，已保留证据并等待补充。',actor);this.finishCheck(body.checkId);this.bump(id);return this.detail(actor.user,id);}
            const value=selected[0].value!,limit=rule.threshold;const yes={gt:value>limit,gte:value>=limit,lt:value<limit,lte:value<=limit,eq:value===limit}[rule.comparator];outcome=yes?'yes':'no';automatic=!!row.auto_resolve;resultReason=`按预设规则计算：${value} ${rule.unit} ${{gt:'>',gte:'≥',lt:'<',lte:'≤',eq:'='}[rule.comparator]} ${limit}，${yes?'成立':'不成立'}。\n取证说明：${reason}`;
          }
          this.result(actor,id,outcome,resultReason,evidenceIds,!automatic,null);
          this.sql.prepare('UPDATE judgments SET state=?,outcome=? WHERE id=?').run(automatic?'resolved':'feedback',automatic?outcome:null,id);
        }
        this.finishCheck(body.checkId);
      }else if(action==='feedback'){
        if(actor.kind!=='user')throw new JudgmentError(403,'候选结论须由本人在判断簿确认。');
        const outcome=z.enum(['yes','no','indeterminate','maintain','revise','shelve']).parse(body.outcome),reason=nonempty().parse(body.reason);
        if(row.kind==='idea'?!['maintain','revise','shelve'].includes(outcome):!['yes','no','indeterminate'].includes(outcome))throw new JudgmentError(400,'结果不适用于此记录类型。');
        if(row.kind==='prediction'&&(!row.deadline_at||Date.parse(row.deadline_at)>this.now()))throw new JudgmentError(409,'事件期限尚未到，不能提前揭晓。');
        const detail=this.detail(actor.user,id),previous=detail.results.filter(r=>!r.candidate).at(-1);
        let evidenceIds:string[]=detail.evidence.map(e=>e.id);
        if(body.candidateId){const candidate=detail.results.find(r=>r.id===body.candidateId&&r.candidate);if(!candidate||detail.results.at(-1)?.id!==candidate.id)throw new JudgmentError(409,'候选结论已更新，请重新查看。');evidenceIds=candidate.evidenceIds;}
        this.result(actor,id,outcome,reason,evidenceIds,false,previous?.id??null);this.cancelChecks(id);
        this.sql.prepare('UPDATE judgments SET state=?,outcome=? WHERE id=?').run(outcome==='indeterminate'?'indeterminate':'resolved',outcome,id);
      }else throw new JudgmentError(400,'未知操作，请先读取 context。');
      this.bump(id);return this.detail(actor.user,id);
    });
  }
  private finishCheck(check:unknown){if(typeof check==='string')this.sql.prepare("UPDATE judgment_checks SET state='submitted' WHERE id=? AND state='fired'").run(check);}
  private result(actor:JudgmentActor,id:string,outcome:JudgmentOutcome,reason:string,evidenceIds:string[],candidate:boolean,supersedes:string|null){
    this.sql.prepare('INSERT INTO judgment_results VALUES(?,?,?,?,?,?,?,?,?,?)').run(uuid(),id,outcome,reason,Number(candidate),JSON.stringify(evidenceIds),actor.kind,actor.conversationId??null,supersedes,stamp());
    this.event(id,candidate?'candidate':'result',candidate?'Agent 提交了候选结论，等待本人确认。':`已追加结果：${outcome}。${reason}`,actor);
  }
  draft(actor:JudgmentActor,id:string,body:Record<string,unknown>,selection:StoredAgentSelection){
    return this.transaction(actor,body.requestKey,`${id}:draft`,{},()=>{
      const row=this.row(actor.user,id);this.project(actor.user,row.project_id);const cid=uuid();
      this.db.createConversation(cid,`讨论判断 · ${row.title.slice(0,70)}`,selection,actor.user,row.project_id);
      this.sql.prepare("UPDATE conversations SET title_source='manual' WHERE id=?").run(cid);
      const message=`请讨论判断簿记录 ${id}「${row.title}」。先调用 codex_web_judgments context 和 detail，结合保存的理由、疑点与证据帮助我复盘。不要替我填写概率或确认结果。`;
      this.db.saveComposerDraft(cid,message,null);
      this.event(id,'discussion','创建了所属项目的讨论草稿；发送后才执行。',{...actor,conversationId:cid});return {conversationId:cid,projectId:row.project_id};
    });
  }
}
