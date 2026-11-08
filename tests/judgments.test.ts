import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppDatabase, LEGACY_USER_ID } from '../server/db.js';
import { JudgmentStore, type JudgmentActor } from '../server/judgment-store.js';
import { RecurringStore } from '../server/recurring-store.js';
import { validateRecurrence, nextOccurrence } from '../server/recurrence.js';
import { createApp } from '../server/app.js';
import { createJobAutomationToken } from '../server/wake-automation.js';
import type { JudgmentDetail, JudgmentInput, JudgmentEvidenceInput } from '../src/judgment-types.js';
const id=()=>crypto.randomUUID(),user=LEGACY_USER_ID,selection={model:'gpt-6-astra',reasoningEffort:'max'},d=(n:number)=>new Date(n).toISOString();
function fixture(t:test.TestContext){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'judgment-')),db=new AppDatabase(root),p=db.createProject(id(),user,'Judgments',root,'tenant-local');let now=Date.now();
  const s=new JudgmentStore(db,()=>now),a:JudgmentActor={user,kind:'user'},r=new RecurringStore(db);
  const input=(patch:Partial<JudgmentInput>={}):JudgmentInput=>({projectId:p.id,kind:'prediction',title:'Synthetic prediction',probability:.7,deadlineAt:d(now+60000),criteria:'Explicit yes/no event',rationale:'Initial reasoning',doubts:'Known unknown',topic:'fixture',mode:'public_event',rule:null,autoResolve:false,checkAt:d(now+61000),timeZone:'Asia/Shanghai',synthetic:false,...patch});
  const create=(patch:Partial<JudgmentInput>={})=>s.create(a,{...input(patch),requestKey:id()},selection);
  const change=(j:JudgmentDetail,action:string,body:Record<string,unknown>={},actor=a)=>s.mutate(actor,j.judgment.id,action,{revision:j.judgment.revision,requestKey:id(),...body},selection);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});return {root,db,p,s,a,r,input,create,change,now:()=>now,advance:(n=62000)=>{now+=n;}};
}
test('create and revisions are atomic, idempotent, immutable across reopen; changed question is a linked record',t=>{
  const f=fixture(t),body={...f.input(),requestKey:id()},j=f.s.create(f.a,body,selection);
  assert.equal(f.s.create(f.a,body,selection).judgment.id,j.judgment.id);assert.equal(f.s.list(user).items.length,1);
  assert.throws(()=>f.s.create(f.a,{...body,title:'different'},selection),/不同的操作/);
  const revised=f.change(j,'revise',{probability:.4,reason:'User supplied lower probability'});
  assert.equal(revised.versions.length,2);assert.equal(revised.versions[0].snapshot?.title,body.title);assert.equal(revised.judgment.firstProbability,.7);assert.equal(revised.judgment.probability,.4);
  assert.throws(()=>f.change(j,'revise',{probability:.8,reason:'stale'}),/记录已更新/);
  const other=new AppDatabase(f.root,undefined,false);try{assert.equal(new JudgmentStore(other).detail(user,j.judgment.id).versions.length,2);}finally{other.close();}
  const fork=f.create({title:'Explicit new question',parentId:j.judgment.id});assert.equal(fork.judgment.parentId,j.judgment.id);assert.equal(f.s.detail(user,j.judgment.id).judgment.title,body.title);
  f.advance();assert.throws(()=>f.change(revised,'revise',{probability:1,reason:'after outcome'}),/截止/);
  assert.deepEqual(f.db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('one-time plans beyond 365 days persist, only fire once, and roll back queue/conversation/record changes together',t=>{
  const f=fixture(t),at=d(f.now()+5*366*86400000),schedule=validateRecurrence({kind:'once',at,timeZone:'Asia/Shanghai'});
  assert.equal(nextOccurrence(schedule,f.now()),at);
  const j=f.create({checkAt:at,deadlineAt:at}),check=j.checks[0];assert.equal(j.judgment.nextCheckAt,at);assert.equal(f.r.fire(user,check.taskId,f.now()),null);
  const original=f.db.createPendingPrompt.bind(f.db);f.db.createPendingPrompt=()=>{throw new Error('injected crash');};
  assert.throws(()=>f.r.fire(user,check.taskId,Date.parse(at)),/injected crash/);assert.equal(f.s.detail(user,j.judgment.id).checks[0].state,'armed');assert.equal(f.s.detail(user,j.judgment.id).judgment.revision,1);
  f.db.createPendingPrompt=original;const cid=f.r.fire(user,check.taskId,Date.parse(at))!;assert.ok(cid);assert.equal(f.db.getConversation(cid)?.project_id,f.p.id);assert.equal(f.db.listPendingPrompts(cid).length,1);
  assert.equal(f.r.get(user,check.taskId)?.state,'completed');assert.equal(f.r.fire(user,check.taskId,Date.parse(at)+86400000),null);
  const second=new AppDatabase(f.root,undefined,false);try{assert.equal(new RecurringStore(second).fire(user,check.taskId,Date.parse(at)),null);}finally{second.close();}
});
test('private predictions and long-term ideas become feedback without model jobs; ideas never enter scores',t=>{
  const f=fixture(t),a=f.create({mode:'private'}),b=f.create({kind:'idea',probability:null,deadlineAt:null,mode:'private',criteria:''});f.advance();
  for(const j of [a,b]){assert.equal(f.r.fire(user,j.checks[0].taskId,f.now()),null);const current=f.s.detail(user,j.judgment.id);assert.equal(current.judgment.status,'feedback');assert.equal(current.checks[0].taskStatus,'feedback');assert.equal(current.checks[0].conversationId,null);}
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM jobs').get()?.n,0);
  const yes=f.change(f.s.detail(user,a.judgment.id),'feedback',{outcome:'yes',reason:'本人明确反馈'});assert.equal(yes.judgment.status,'resolved');
  const idea=f.change(f.s.detail(user,b.judgment.id),'feedback',{outcome:'revise',reason:'Review changed my mind'});assert.equal(idea.judgment.outcome,'revise');
  assert.equal(f.s.list(user).stats.scored,1);assert.ok(Math.abs(f.s.list(user).stats.firstBrier!-.09)<1e-9);
  const again=f.change(idea,'schedule',{at:d(f.now()+400*86400000),timeZone:'UTC'});assert.equal(again.judgment.status,'observing');assert.equal(again.results.length,1);
});
test('public events remain candidates until user confirmation; corrections append; scoring counts a question once',t=>{
  const f=fixture(t),initial=f.create(),revised=f.change(initial,'revise',{probability:.2,reason:'User revision'});f.advance();
  const actor:JudgmentActor={user,kind:'agent',projectId:f.p.id};
  let j=f.change(revised,'evidence',{evidence:{url:'https://example.org/fact',excerpt:'Core event evidence',observedAt:d(f.now()),complete:true,conflict:false}},actor);
  j=f.change(j,'submit',{outcome:'yes',reason:'Candidate with evidence',evidenceIds:[j.evidence[0].id]},actor);assert.equal(j.judgment.status,'feedback');assert.equal(f.s.list(user).stats.scored,0);
  assert.throws(()=>f.change(j,'feedback',{outcome:'yes',reason:'Agent cannot confirm'},actor),/本人/);
  j=f.change(j,'feedback',{outcome:'yes',candidateId:j.results.at(-1)!.id,reason:'I reviewed the evidence'});assert.equal(j.judgment.status,'resolved');assert.equal(f.s.list(user).stats.scored,1);
  assert.ok(Math.abs(f.s.list(user).stats.firstBrier!-.09)<1e-9);assert.ok(Math.abs(f.s.list(user).stats.lastBrier!-.64)<1e-9);
  j=f.change(j,'evidence',{evidence:{url:'https://example.org/correction',excerpt:'Later evidence supports correction',observedAt:d(f.now()),complete:true,conflict:false}});
  j=f.change(j,'feedback',{outcome:'no',reason:'Correction with specific reason'});assert.equal(j.results.length,3);assert.equal(j.results.at(-1)?.supersedes,j.results[1].id);assert.equal(f.s.list(user).stats.scored,1);
  j=f.change(j,'feedback',{outcome:'indeterminate',reason:'Conflicting authoritative records'});assert.equal(f.s.list(user).stats.scored,0);assert.equal(f.s.list(user).stats.indeterminate,1);
});
test('numeric outcomes use deterministic comparison, not agent verdict; mismatches and unselected conflicts never become false',t=>{
  const f=fixture(t),rule={metric:'Fixture',unit:'m/s',period:'SI definition',sourceUrl:'https://www.bipm.org/en/measurement-units/si-defining-constants',comparator:'gt' as const,threshold:100};
  const initial=f.create({mode:'numeric',rule,autoResolve:true}),missing=f.create({mode:'numeric',rule,autoResolve:true}),conflicting=f.create({mode:'numeric',rule,autoResolve:true});f.advance();
  const ev=(value:number,patch:Partial<JudgmentEvidenceInput>={})=>({url:rule.sourceUrl,excerpt:'Stored core value',observedAt:d(f.now()),value,unit:rule.unit,period:rule.period,complete:true,conflict:false,...patch});
  let j=f.change(initial,'evidence',{evidence:ev(100)});j=f.change(j,'submit',{outcome:'yes',reason:'Compare strictly',evidenceIds:[j.evidence[0].id]});assert.equal(j.judgment.outcome,'no');assert.equal(j.results[0].candidate,false);
  let m=f.change(missing,'submit',{outcome:'needs_evidence',reason:'Data missing'});assert.equal(m.judgment.status,'evidence');assert.equal(m.results.length,0);
  m=f.change(m,'evidence',{evidence:ev(1,{unit:'wrong'})});m=f.change(m,'submit',{outcome:'no',reason:'Should not conclude',evidenceIds:[m.evidence[0].id]});assert.equal(m.judgment.status,'evidence');assert.equal(m.results.length,0);
  let c=f.change(conflicting,'evidence',{evidence:ev(99)});c=f.change(c,'evidence',{evidence:ev(101)});c=f.change(c,'submit',{outcome:'yes',reason:'Cannot cherry pick',evidenceIds:[c.evidence[1].id]});assert.equal(c.judgment.status,'evidence');assert.equal(c.results.length,0);
});
test('stock evidence needs verified market, basis, actual trading date and corporate action handling',t=>{
  const f=fixture(t),stock={symbol:'SYNTH',market:'synthetic exchange',currency:'USD',baselineDate:'2026-01-01',baselineValue:100,targetDate:'2026-01-02',timeZone:'America/New_York',priceType:'close' as const,adjustment:'raw' as const,nonTradingDay:'unresolved' as const,missing:'unresolved' as const,suspension:'unresolved' as const,corporateActions:'unresolved' as const};
  const rule={metric:'close',unit:'USD',period:'2026-01-02',sourceUrl:'https://example.org/official',comparator:'gt' as const,threshold:100,stock};
  const bad=f.create({mode:'numeric',rule,autoResolve:true,synthetic:true}),good=f.create({mode:'numeric',rule,autoResolve:true,synthetic:true});f.advance();
  const ev={url:rule.sourceUrl,excerpt:'Synthetic numeric fixture',observedAt:d(f.now()),value:110,unit:'USD',period:rule.period,stock,complete:true,conflict:false};
  let b=f.change(bad,'evidence',{evidence:ev});b=f.change(b,'submit',{outcome:'yes',reason:'Missing validation',evidenceIds:[b.evidence[0].id]});assert.equal(b.judgment.status,'evidence');
  let g=f.change(good,'evidence',{evidence:{...ev,stockValidation:{tradingDate:stock.targetDate,suspended:false,corporateAction:false,sourceAdjusted:false}}});g=f.change(g,'submit',{outcome:'no',reason:'Deterministic comparison',evidenceIds:[g.evidence[0].id]});assert.equal(g.judgment.outcome,'yes');assert.equal(f.s.list(user).stats.scored,0);assert.equal(f.s.list(user).stats.synthetic,2);
});
test('previous trading day requires explicit nearest-session evidence before automatic resolution',t=>{
  const f=fixture(t),stock={symbol:'SYNTH',market:'synthetic exchange',currency:'USD',baselineDate:'2026-01-01',baselineValue:100,targetDate:'2026-01-04',timeZone:'America/New_York',priceType:'close' as const,adjustment:'raw' as const,nonTradingDay:'previous' as const,missing:'unresolved' as const,suspension:'unresolved' as const,corporateActions:'unresolved' as const};
  const rule={metric:'close',unit:'USD',period:'2026-01-04',sourceUrl:'https://example.org/official',comparator:'gt' as const,threshold:100,stock};let j=f.create({mode:'numeric',rule,autoResolve:true,synthetic:true});f.advance();
  const evidence={url:rule.sourceUrl,excerpt:'Synthetic previous-session evidence',observedAt:d(f.now()),value:110,unit:rule.unit,period:rule.period,stock,complete:true,conflict:false,stockValidation:{tradingDate:'2026-01-02',suspended:false,corporateAction:false,sourceAdjusted:false}};
  j=f.change(j,'evidence',{evidence});j=f.change(j,'submit',{outcome:'yes',reason:'An older quote alone is insufficient',evidenceIds:[j.evidence[0].id]});assert.equal(j.judgment.status,'evidence');assert.equal(j.results.length,0);
  j=f.change(j,'evidence',{evidence:{...evidence,stockValidation:{...evidence.stockValidation,targetNonTradingDay:true,latestTradingDayVerified:true}}});j=f.change(j,'submit',{outcome:'yes',reason:'Nearest session verified',evidenceIds:[j.evidence.at(-1)!.id]});assert.equal(j.judgment.status,'resolved');
});
test('cancellation, rescheduling and failed runs preserve history and reject stale writes even with latest revision',t=>{
  const f=fixture(t),initial=f.create();f.advance();const cid=f.r.fire(user,initial.checks[0].taskId,f.now())!,a:JudgmentActor={user,kind:'agent',projectId:f.p.id,conversationId:cid};let j=f.s.detail(user,initial.judgment.id);
  j=f.change(j,'cancel');assert.equal(f.db.listPendingPrompts(cid).length,0);assert.equal(j.checks[0].state,'cancelled');assert.equal(j.versions.length,1);
  assert.throws(()=>f.change(j,'submit',{checkId:initial.checks[0].id,outcome:'needs_evidence',reason:'Late response'},a),/旧执行不能写回/);
  assert.throws(()=>f.change(j,'submit',{outcome:'needs_evidence',reason:'Dropped token'},a),/检查编号/);
  j=f.change(j,'schedule',{at:d(f.now()+60000),timeZone:'UTC'});f.advance();const next=f.r.fire(user,j.checks[0].taskId,f.now())!;
  const prompt=f.db.listPendingPrompts(next)[0],job=f.db.materializePendingPrompt(prompt.id,id(),id())!;f.db.sqlite.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(job.id);
  j=f.s.detail(user,j.judgment.id);assert.equal(j.checks[0].taskStatus,'failed');assert.equal(j.judgment.status,'verification');assert.equal(j.results.length,0);
  j=f.change(j,'schedule',{at:d(f.now()+60000),timeZone:'UTC'});assert.equal(j.checks.length,3);assert.equal(j.checks[0].state,'armed');assert.equal(j.checks[1].state,'cancelled');
});
test('archiving, inactive accounts and executor changes gate long schedules; hidden entry does not cancel',t=>{
  const f=fixture(t),j=f.create();f.advance();f.db.archiveProjectForUser(f.p.id,user);assert.equal(f.r.due(f.now()).length,0);assert.equal(f.r.fire(user,j.checks[0].taskId,f.now()),null);assert.equal(f.s.detail(user,j.judgment.id).checks[0].taskStatus,'project_archived');
  f.db.restoreProjectForUser(f.p.id,user,'Restored');const old=f.db.getFeatureSelection(user);f.db.setFeatureSelection(user,{...old,judgmentBook:false});assert.equal(f.s.detail(user,j.judgment.id).checks[0].state,'armed');
  f.db.sqlite.prepare("UPDATE projects SET executor_id='remote:fixture' WHERE id=?").run(f.p.id);assert.equal(f.r.fire(user,j.checks[0].taskId,f.now()),null);assert.equal(f.s.detail(user,j.judgment.id).checks[0].state,'cancelled');
});
test('normal discussion is a durable project draft and never starts a job',t=>{
  const f=fixture(t),j=f.create(),key=id(),r=f.s.draft(f.a,j.judgment.id,{requestKey:key},selection);
  assert.equal(f.s.draft(f.a,j.judgment.id,{requestKey:key},selection).conversationId,r.conversationId);assert.equal(f.db.getConversation(r.conversationId)?.project_id,f.p.id);
  assert.match(f.db.getComposerDraft(r.conversationId)!.content,/codex_web_judgments/);assert.equal(f.db.listPendingPrompts(r.conversationId).length,0);assert.equal(f.db.listActiveJobsForConversation(r.conversationId).length,0);
});
test('managed evidence attachments retain ownership and protect source deletion while core evidence survives unlinked conversation GC',t=>{
  const f=fixture(t),j=f.create(),c=f.db.createConversation(id(),'Evidence',selection,user,f.p.id),mid=id(),fid=id();
  f.db.addMessage({id:mid,conversation_id:c.id,role:'assistant',content:'Evidence attachment',created_at:stamp()});
  f.db.addFile({id:fid,conversation_id:c.id,message_id:mid,original_name:'evidence.txt',relative_path:'outputs/evidence.txt',mime_type:'text/plain',size:12,kind:'output',created_at:stamp()});
  const saved=f.change(j,'evidence',{evidence:{url:'https://example.org',excerpt:'Core facts remain in business data',observedAt:d(f.now()),complete:true,conflict:false,fileIds:[fid]}});
  assert.equal(saved.evidence[0].fileIds?.[0],fid);assert.equal(f.db.judgmentAttachmentProtectsConversation(c.id),true);assert.equal(f.db.beginConversationDeletion(c.id,user),undefined);assert.ok(f.db.getConversation(c.id));
  assert.throws(()=>f.db.removeFile(fid),/FOREIGN KEY/);
  const other=f.db.createConversation(id(),'Unlinked research',selection,user,f.p.id),actor:JudgmentActor={user,kind:'agent',projectId:f.p.id,conversationId:other.id};
  const next=f.change(saved,'evidence',{evidence:{url:'https://example.org/second',excerpt:'Durable independent excerpt',observedAt:d(f.now()),complete:true,conflict:false}},actor);
  f.db.sqlite.prepare('DELETE FROM conversations WHERE id=?').run(other.id);assert.equal(f.s.detail(user,j.judgment.id).evidence.length,2);assert.ok(!f.s.detail(user,j.judgment.id).availableConversations.includes(other.id));assert.equal(next.evidence[1].excerpt,'Durable independent excerpt');
});
test('real routes enforce authentication, CSRF, tenant and project ownership, job lifetime and generic schedule guard',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'judgment-api-')),secret='judgment-fixture-secret-longer-than-thirty-two',password='fixture-pass';
  const app=createApp({ basePath: "",projectRoot:process.cwd(),dataRoot:path.join(root,'data'),tenantRoot:path.join(root,'tenants'),queueAutoStart:false,username:'pp',passwordHash:bcrypt.hashSync(password,4),sessionSecret:secret,minimumFreeDiskBytes:0});
  t.after(()=>{app.beginShutdown();app.db.close();fs.rmSync(root,{recursive:true,force:true});});
  const agent=request.agent(app.app),login=await agent.post('/api/auth/login').send({username:'pp',password}).expect(200),csrf=login.body.csrfToken;
  const p=app.db.createProject(id(),user,'API',root,'tenant-local'),store=new JudgmentStore(app.db),a:JudgmentActor={user,kind:'user'};
  const input={projectId:p.id,kind:'prediction',title:'API fixture',probability:.5,deadlineAt:d(Date.now()+120000),criteria:'Explicit',rationale:'',doubts:'',topic:'',mode:'private',rule:null,autoResolve:false,checkAt:d(Date.now()+121000),timeZone:'UTC',synthetic:true,requestKey:id()};
  await request(app.app).get('/api/judgments').expect(401);await agent.post('/api/judgments').send(input).expect(403);
  const created=await agent.post('/api/judgments').set('X-CSRF-Token',csrf).send(input).expect(201),j=created.body as JudgmentDetail;
  await agent.post(`/api/recurring-tasks/${j.checks[0].taskId}/state`).set('X-CSRF-Token',csrf).send({revision:1,state:'paused'}).expect(409);
  const p2=app.db.createProject(id(),user,'Different project',path.join(root,'other'),'tenant-local'),c=app.db.createConversation(id(),'Agent fixture',selection,user,p2.id),job=app.db.createJob(id(),c.id,undefined,selection);app.db.sqlite.prepare("UPDATE jobs SET status='running' WHERE id=?").run(job.id);
  const token=createJobAutomationToken(secret,job.id,c.id,Date.now(),86400000,app.db.workflows.assertJob(job.id).epoch),endpoint=`/api/automation/jobs/${job.id}/judgments`,call=(body:unknown)=>request(app.app).post(endpoint).set('Authorization','Bearer '+token).send(body);
  await call({action:'context'}).expect(200);await call({action:'detail',id:j.judgment.id}).expect(200);await call({action:'revise',id:j.judgment.id,data:{revision:1,requestKey:id(),probability:.8,reason:'Wrong project'}}).expect(403);
  await call({action:'create',data:{...input,requestKey:id()}}).expect(403);
  const foreign=id(),now=stamp();app.db.createUser({id:foreign,username:'other',password_hash:'',display_name:'Other',role:'member',status:'active',created_at:now,updated_at:now});const fp=app.db.createProject(id(),foreign,'Private',path.join(root,'foreign'),'tenant-local');
  const fj=store.create({user:foreign,kind:'user'},{...input,projectId:fp.id,requestKey:id()},selection);await agent.get('/api/judgments/'+fj.judgment.id).expect(404);await call({action:'detail',id:fj.judgment.id}).expect(404);
  const ex=await agent.get('/api/judgments/export').expect(200);assert.equal(ex.body.records.length,1);assert.equal(ex.body.records[0].versions[0].snapshot.title,input.title);
  app.db.sqlite.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(job.id);await call({action:'context'}).expect(401);
  assert.equal(store.detail(user,j.judgment.id).judgment.revision,1);assert.equal(a.kind,'user');
});
function stamp(){return new Date().toISOString();}
